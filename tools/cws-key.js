#!/usr/bin/env node
/* One-time OAuth setup for the Chrome Web Store API.
 *
 *   npm run cws:key
 *
 * Before running it, in the Google Cloud console (once):
 *   1. create or pick a project
 *   2. enable "Chrome Web Store API"
 *   3. OAuth consent screen: External, and add your own address as a test user
 *   4. Credentials → Create credentials → OAuth client ID → **Desktop app**
 *      That gives a client ID and client secret.
 *
 * This script takes those two, walks the consent flow, and stores all three —
 * client id, client secret, refresh token — in the macOS Keychain. The refresh
 * token does not expire on its own, so this is done once.
 *
 * The consent redirect goes to 127.0.0.1 on a port this script listens on.
 * Google stopped accepting the old copy-the-code-from-the-page flow in 2022,
 * and a desktop OAuth client is only allowed to redirect to loopback.
 */
'use strict';
const http = require('http');
const readline = require('readline');
const { spawnSync } = require('child_process');

const SERVICE = 'waveform-viewer-cws';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

if (process.platform !== 'darwin') die('not macOS — set CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN instead');

function keychainSet(account, secret) {
  const r = spawnSync('security',
    ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], { encoding: 'utf8' });
  if (r.status !== 0) die('could not write to the keychain: ' + (r.stderr || '').trim());
}
const ask = (q, quiet) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (quiet) {                        // do not echo a secret into the scrollback
    const out = rl.output;
    rl._writeToOutput = (s) => { if (s.indexOf(q) === 0) out.write(s); };
  }
  rl.question(q, (a) => { rl.close(); if (quiet) process.stdout.write('\n'); res(a.trim()); });
});

(async () => {
  console.log('\nChrome Web Store API credentials\n');
  const id = await ask('OAuth client ID:     ');
  if (!id) die('no client ID');
  const secret = await ask('OAuth client secret: ', true);
  if (!secret) die('no client secret');

  // A loopback server catches the redirect, so nothing has to be copied by hand.
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?response_type=code&access_type=offline&prompt=consent'
    + '&scope=' + encodeURIComponent(SCOPE)
    + '&client_id=' + encodeURIComponent(id)
    + '&redirect_uri=' + encodeURIComponent(redirect);

  console.log('\nAdd this to the client\'s "Authorised redirect URIs" if it is not there:\n  ' + redirect);
  console.log('\nThen open this and approve:\n  ' + url + '\n');
  spawnSync('open', [url]);                        // best effort

  const code = await new Promise((resolve) => {
    server.on('request', (req, res) => {
      const got = new URL(req.url, redirect).searchParams.get('code');
      res.end(got ? 'Done — close this tab and go back to the terminal.' : 'No code in the redirect.');
      if (got) resolve(got);
    });
  });
  server.close();

  const body = new URLSearchParams({ code, client_id: id, client_secret: secret,
                                     redirect_uri: redirect, grant_type: 'authorization_code' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const json = await res.json();
  if (!json.refresh_token) die('no refresh token came back: ' + JSON.stringify(json));

  keychainSet('client_id', id);
  keychainSet('client_secret', secret);
  keychainSet('refresh_token', json.refresh_token);
  console.log('\n  ✓ stored in the login keychain under "' + SERVICE + '"');
  console.log('  Check with:  npm run publish:chrome -- --dry-run\n');
})();
