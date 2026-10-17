#!/usr/bin/env bash
# Store the AMO API credentials in the macOS Keychain, once.
#
# `security -w` with no value prompts, so neither secret is typed on a command
# line: nothing lands in shell history or in the process list.
set -euo pipefail
SERVICE=waveform-viewer-amo

if [ "$(uname)" != "Darwin" ]; then
  echo "Not macOS. Export WEB_EXT_API_KEY and WEB_EXT_API_SECRET instead." >&2
  exit 1
fi

cat <<'EOF'
Generate a key pair at
  https://addons.mozilla.org/en-US/developers/addon/api/key/

They are account-wide, so treat them like a password. You will be prompted for
each one twice; nothing is echoed.

EOF
echo "JWT issuer  (looks like user:12345678:123):"
security add-generic-password -U -s "$SERVICE" -a key -w
echo "JWT secret:"
security add-generic-password -U -s "$SERVICE" -a secret -w
echo
echo "Stored in the login keychain under \"$SERVICE\"."
echo "Check with:  npm run publish:amo -- --dry-run"
echo "Remove with: security delete-generic-password -s $SERVICE -a key"
echo "             security delete-generic-password -s $SERVICE -a secret"
