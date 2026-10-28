#!/usr/bin/env bash
# Install the DSH Data Sync plugin that sits next to this script.
#
#   ./install.sh [profile]
#
# It only links the plugin into a profile; restoring the snapshot itself is done
# from Settings -> Data Sync, so the human still reviews every file change.
set -euo pipefail

PROFILE="${1:-desktop}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

cat <<'DONE'

Installed. Next steps:
  1. Restart DeepSeek Harness.
  2. Settings -> Data Sync: paste the repository URL and press Connect.
  3. Press Check remote, review the plan, then Apply pull.
DONE
