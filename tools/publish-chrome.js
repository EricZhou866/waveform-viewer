#!/usr/bin/env node
/* Publish the Chrome build to the Chrome Web Store from the command line.
 *
 *   npm run cws:key                                   # once
 *   npm run build && npm run publish:chrome -- --dry-run
 *   npm run build && npm run publish:chrome
 *
 * Same shape as tools/publish-amo.js: everything that can be checked is checked
 * before anything is uploaded. Chrome is more forgiving than AMO here — a
 * version number is not burned by a failed upload — but a bad package that
 * reaches review still costs days.
 *
 * Credentials come from the macOS Keychain (npm run cws:key) or from
 * CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN in the environment.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const ITEM_ID = 'ebceieenmeiakdkhphcaphegoaiajcpn';
const SERVICE = 'waveform-viewer-cws';
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };
const ok = (m) => console.log('  ✓ ' + m);

const manifests = ['chrome.json', 'firefox.json', 'firefox-mv3.json'].map((f) => path.join(REPO, 'manifests', f));
const versions = [...new Set(manifests.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).version))];
if (versions.length !== 1) die('the manifests disagree on the version: ' + versions.join(', '));
const VERSION = versions[0];
console.log(`\nWaveform Viewer ${VERSION} → Chrome Web Store${DRY ? '  (dry run)' : ''}\n`);
ok('three manifests agree on ' + VERSION);

const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty) die('uncommitted changes — commit them first:\n    ' + dirty.split('\n').join('\n    '));
ok('working tree clean');

const BUILD = path.join(REPO, 'build', 'chrome');
if (!fs.existsSync(path.join(BUILD, 'manifest.json'))) die('build/chrome is missing — run ./build.sh first');
const built = JSON.parse(fs.readFileSync(path.join(BUILD, 'manifest.json'), 'utf8'));
if (built.version !== VERSION) die(`build/chrome is ${built.version}, not ${VERSION} — re-run ./build.sh`);
if (built.manifest_version !== 3) die('build/chrome is not the MV3 build the Chrome Web Store expects');
ok('build/chrome is the MV3 build of ' + VERSION);

for (const f of ['content.js', 'background.js', 'page-hook.js', 'panel.html']) {
  if (!fs.readFileSync(path.join(REPO, 'src', f)).equals(fs.readFileSync(path.join(BUILD, f))))
    die(`build/chrome/${f} differs from src/${f} — re-run ./build.sh`);
}
ok('the build matches src/');

// The store caps the listing description at 132 characters and rejects on it.
if (built.description.length > 132) die(`description is ${built.description.length} characters, the store allows 132`);
ok(`description, ${built.description.length}/132 characters`);

const ZIP = path.join(REPO, 'dist', `waveform-viewer-chrome-${VERSION}.zip`);
if (!fs.existsSync(ZIP)) die(`dist/waveform-viewer-chrome-${VERSION}.zip is missing — run ./build.sh`);
ok(`package, ${(fs.statSync(ZIP).size / 1024).toFixed(0)} KB`);

/* ---- credentials: keychain first, environment wins ---- */
const fromKeychain = (account) => {
  const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
let source = 'the environment';
let cfg = { client_id: process.env.CWS_CLIENT_ID || '', client_secret: process.env.CWS_CLIENT_SECRET || '',
            refresh_token: process.env.CWS_REFRESH_TOKEN || '' };
if (!(cfg.client_id && cfg.client_secret && cfg.refresh_token) && process.platform === 'darwin') {
  const k = { client_id: fromKeychain('client_id'), client_secret: fromKeychain('client_secret'),
              refresh_token: fromKeychain('refresh_token') };
  if (k.client_id && k.client_secret && k.refresh_token) { cfg = k; source = 'the macOS Keychain'; }
}
if (!(cfg.client_id && cfg.client_secret && cfg.refresh_token)) {
  die('no Chrome Web Store credentials.\n' +
      '    Set them up once:  npm run cws:key\n' +
      '    or per shell:      export CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=...');
}
ok('API credentials, from ' + source);

if (DRY) {
  console.log(`\n  Would upload ${path.relative(REPO, ZIP)} to item ${ITEM_ID} and submit it for review.`);
  console.log('  Dry run: nothing uploaded. Drop --dry-run to publish.\n');
  console.log('  Screenshots and listing text are NOT part of this: they live in the\n' +
              '  dashboard and have to be updated there (store/screenshots/).\n');
  process.exit(0);
}

(async () => {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret,
                                refresh_token: cfg.refresh_token, grant_type: 'refresh_token' })
  });
  const tok = await tokenRes.json();
  if (!tok.access_token) die('could not get an access token: ' + JSON.stringify(tok));
  const auth = { Authorization: 'Bearer ' + tok.access_token, 'x-goog-api-version': '2' };
  ok('access token');

  const up = await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`, {
    method: 'PUT', headers: auth, body: fs.readFileSync(ZIP)
  });
  const upJson = await up.json();
  if (upJson.uploadState !== 'SUCCESS') {
    die('upload failed: ' + JSON.stringify(upJson.itemError || upJson, null, 2));
  }
  ok(`uploaded ${VERSION}`);

  const pub = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}/publish`, {
    method: 'POST', headers: Object.assign({ 'Content-Length': '0' }, auth)
  });
  const pubJson = await pub.json();
  if (!pub.ok) die('publish failed: ' + JSON.stringify(pubJson, null, 2));
  console.log('\n  ✓ submitted: ' + (pubJson.status || []).join(', '));
  (pubJson.statusDetail || []).forEach((d) => console.log('    ' + d));
  console.log('\n  It is in review now. Screenshots and listing text are separate —\n' +
              '  update those in the dashboard (store/screenshots/).\n');
})();
