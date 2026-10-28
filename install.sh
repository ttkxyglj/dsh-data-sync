#!/usr/bin/env bash
# Install the DSH Data Sync plugin that sits next to this script.
#
#   ./install.sh [profile]
#
# It does the two things pnpm alone does not:
#   1. adds the package to the profile (dsh plugin add forwards to pnpm)
#   2. registers the bundle in the profile's dsh.profile.bundles list
# Restoring the snapshot itself stays in Settings -> Data Sync, so the human
# still reviews every file change.
set -euo pipefail

PROFILE="${1:-desktop}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ID="@local/dsh-data-sync"

if [ ! -f "$SOURCE/package.json" ]; then
  echo "not a plugin directory (package.json is missing): $SOURCE" >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "The 'dsh' command is not on PATH. Install DeepSeek Harness first." >&2
  exit 1
fi

echo "Installing plugin from $SOURCE into profile '$PROFILE' ..."
dsh plugin --profile "$PROFILE" add "$SOURCE"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_FILE="$DSH_HOME_DIR/profiles/$PROFILE/package.json"
if [ -f "$PROFILE_FILE" ]; then
  if command -v node >/dev/null 2>&1; then
    node - "$PROFILE_FILE" "$BUNDLE_ID" <<'NODE'
const fs = require('node:fs')
const [file, bundle] = process.argv.slice(2)
const json = JSON.parse(fs.readFileSync(file, 'utf8'))
json.dsh = json.dsh || {}
json.dsh.profile = json.dsh.profile || {}
const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : []
if (!bundles.includes(bundle)) {
  bundles.push(bundle)
  json.dsh.profile.bundles = bundles
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  console.log(`Registered ${bundle} in ${file}`)
} else {
  console.log(`${bundle} is already registered in ${file}`)
}
NODE
  else
    echo "node is not available; add \"$BUNDLE_ID\" to dsh.profile.bundles in $PROFILE_FILE by hand." >&2
  fi
else
  echo "Profile file not found: $PROFILE_FILE" >&2
  echo "Add \"$BUNDLE_ID\" to dsh.profile.bundles by hand, then restart DeepSeek Harness." >&2
fi

cat <<'DONE'

Installed. Next steps:
  1. Restart DeepSeek Harness.
  2. Settings -> Data Sync: paste the repository URL and press Connect.
  3. Press Check remote, review the plan, then Apply pull.
DONE
