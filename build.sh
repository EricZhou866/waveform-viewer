#!/usr/bin/env bash
# Build store-ready zips for Chrome and Firefox from the shared src/ tree.
#   ./build.sh            -> dist/waveform-viewer-chrome-<ver>.zip
#                            dist/waveform-viewer-firefox-<ver>.zip
#   ./build.sh firefox-mv3  also builds the MV3 Firefox variant
set -euo pipefail
cd "$(dirname "$0")"

VER=$(python3 -c "import json;print(json.load(open('manifests/chrome.json'))['version'])")
rm -rf build dist && mkdir -p dist

pack () {
  local target="$1" manifest="$2" out="$3"
  rm -rf "build/$target"
  mkdir -p "build/$target"
  cp -r src/* "build/$target/"
  cp "$manifest" "build/$target/manifest.json"
  ( cd "build/$target" && zip -qr "../../dist/$out" . -x '.*' '*/.*' )
  echo "  dist/$out"
}

echo "Building v$VER"
pack chrome  manifests/chrome.json      "waveform-viewer-chrome-$VER.zip"
pack firefox manifests/firefox.json     "waveform-viewer-firefox-$VER.zip"
if [ "${1:-}" = "firefox-mv3" ]; then
  pack firefox-mv3 manifests/firefox-mv3.json "waveform-viewer-firefox-mv3-$VER.zip"
fi

# Firefox reviewers ask for readable sources; ship the tree as-is.
zip -qr "dist/waveform-viewer-source-$VER.zip" src manifests build.sh README.md LICENSE 2>/dev/null || \
zip -qr "dist/waveform-viewer-source-$VER.zip" src manifests build.sh README.md
echo "  dist/waveform-viewer-source-$VER.zip"
echo "Done."
