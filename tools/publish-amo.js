#!/usr/bin/env node
/* Publish the Firefox build to addons.mozilla.org from the command line.
 *
 *   npm run build && npm run publish:amo -- --dry-run     # check, upload nothing
 *   npm run build && npm run publish:amo
 *
 * Credentials come from the environment and are never read from the repo:
 *
 *   export WEB_EXT_API_KEY=user:12345678:123          # "JWT issuer"
 *   export WEB_EXT_API_SECRET=...                     # "JWT secret"
 *
 * Both are generated at https://addons.mozilla.org/en-US/developers/addon/api/key/
 * and are account-wide — treat them like a password.
 *
 * Everything before the upload is a pre-flight check, because an AMO upload
 * cannot be taken back: a version string is reserved for good the moment AMO
 * receives it, even if the submission is later deleted (DESIGN.md §21.2).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const die = (msg) => { console.error('\n  ✗ ' + msg + '\n'); process.exit(1); };
const ok = (msg) => console.log('  ✓ ' + msg);

/* ---- what are we publishing ---- */
const manifests = ['chrome.json', 'firefox.json', 'firefox-mv3.json']
  .map((f) => path.join(REPO, 'manifests', f));
const versions = [...new Set(manifests.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).version))];
if (versions.length !== 1) die('the manifests disagree on the version: ' + versions.join(', '));
const VERSION = versions[0];
console.log(`\nWaveform Viewer ${VERSION} → addons.mozilla.org${DRY ? '  (dry run)' : ''}\n`);
ok('three manifests agree on ' + VERSION);

/* ---- the tree has to be committed: what ships must be what is in git ---- */
const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty) die('uncommitted changes — commit them first, so the published build is in git:\n    ' +
               dirty.split('\n').join('\n    '));
ok('working tree clean');

/* ---- the build has to exist and be this version ---- */
const SRC_DIR = path.join(REPO, 'build', 'firefox');
if (!fs.existsSync(path.join(SRC_DIR, 'manifest.json'))) die('build/firefox is missing — run ./build.sh first');
const built = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
if (built.version !== VERSION) die(`build/firefox is version ${built.version}, not ${VERSION} — re-run ./build.sh`);
if (built.manifest_version !== 2) die('build/firefox is not the MV2 build AMO expects');
ok('build/firefox is the MV2 build of ' + VERSION);

for (const f of ['content.js', 'background.js', 'page-hook.js', 'panel.html']) {
  const a = fs.readFileSync(path.join(REPO, 'src', f));
  const b = fs.readFileSync(path.join(SRC_DIR, f));
  if (!a.equals(b)) die(`build/firefox/${f} differs from src/${f} — re-run ./build.sh`);
}
ok('the build matches src/');

const SOURCE_ZIP = path.join(REPO, 'dist', `waveform-viewer-source-${VERSION}.zip`);

/* ---- the linter is what predicts an AMO rejection, so it is a gate ----
   Its verdict depends on its own version: an addons-linter too old to know a
   manifest key calls that key reserved and fails a package AMO is perfectly
   happy with. Hence the pinned range in package.json. */
const zip = path.join(REPO, 'dist', `waveform-viewer-firefox-${VERSION}.zip`);
if (!fs.existsSync(zip)) die(`dist/waveform-viewer-firefox-${VERSION}.zip is missing — run ./build.sh`);
const lint = spawnSync('npx', ['addons-linter', zip], { cwd: REPO, encoding: 'utf8' });
if (lint.status !== 0) {
  console.error((lint.stdout || '') + (lint.stderr || ''));
  die('addons-linter rejected the package — AMO will too');
}
ok('addons-linter: clean');

/* ---- the text that goes with it ---- */
const notesFile = path.join(REPO, 'store', `release-notes-${VERSION}.md`);
if (!fs.existsSync(notesFile)) die(`store/release-notes-${VERSION}.md is missing`);
const notesDoc = fs.readFileSync(notesFile, 'utf8');
// The file is split per store; take the AMO half.
const amoSection = notesDoc.split(/^##\s+Firefox[^\n]*$/m)[1];
if (!amoSection) die(`store/release-notes-${VERSION}.md has no "## Firefox / AMO" section`);
const releaseNotes = amoSection.split(/^---$/m)[0].trim();
if (!releaseNotes) die('the Firefox release notes section is empty');
if (releaseNotes.length > 3000) die(`release notes are ${releaseNotes.length} characters, AMO allows 3000`);
ok(`release notes, ${releaseNotes.length} characters`);

const reviewerNotes = fs.readFileSync(path.join(REPO, 'store', 'reviewer-notes.md'), 'utf8').trim();
if (reviewerNotes.length > 3000) die(`reviewer notes are ${reviewerNotes.length} characters, AMO allows 3000`);
ok(`reviewer notes, ${reviewerNotes.length} characters`);

/* ---- is this version already up there ---- */
const addonId = built.browser_specific_settings.gecko.id;
try {
  const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
  const res = execFileSync('curl', ['-sS', '-H', 'Accept: application/json', url], { encoding: 'utf8' });
  const live = JSON.parse(res).current_version;
  if (live && live.version === VERSION) die(`${VERSION} is already the published version on AMO`);
  if (live) ok(`AMO currently has ${live.version}`);
} catch (e) {
  console.log('  · could not reach the AMO API to check the live version — continuing');
}

/* ---- credentials ---- */
console.log('  · run `npm test` too if you have not since the last code change');
if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  die('WEB_EXT_API_KEY and WEB_EXT_API_SECRET are not set.\n' +
      '    Generate them at https://addons.mozilla.org/en-US/developers/addon/api/key/\n' +
      '    and export them in this shell (they are account-wide — treat them like a password).');
}
ok('API credentials present in the environment');

/* ---- metadata file for the submission API ---- */
const metaPath = path.join(REPO, 'dist', `amo-metadata-${VERSION}.json`);
fs.writeFileSync(metaPath, JSON.stringify({
  version: {
    release_notes: { 'en-US': releaseNotes },
    approval_notes: reviewerNotes
  }
}, null, 2));
ok('metadata written to dist/' + path.basename(metaPath));

if (DRY) {
  console.log('\n--- release notes ---\n' + releaseNotes + '\n\n--- reviewer notes (first 300) ---\n' +
              reviewerNotes.slice(0, 300) + '…\n');
  console.log('Dry run: nothing uploaded. Drop --dry-run to submit.\n');
  process.exit(0);
}

/* ---- submit ---- */
const args = ['web-ext', 'sign',
  '--source-dir', SRC_DIR,
  '--artifacts-dir', path.join(REPO, 'dist'),
  '--channel', 'listed',
  '--amo-metadata', metaPath,
  '--approval-timeout', '0'];            // submit and return; do not wait for review
if (fs.existsSync(SOURCE_ZIP)) args.push('--upload-source-code', SOURCE_ZIP);

console.log('\n  → npx ' + args.join(' ') + '\n');
const run = spawnSync('npx', args, { cwd: REPO, stdio: 'inherit' });
if (run.status !== 0) die('web-ext sign failed — see the output above. The version number may now be used up.');
console.log(`\n  ✓ ${VERSION} submitted to AMO. It is in the review queue; you will get an email.\n`);
