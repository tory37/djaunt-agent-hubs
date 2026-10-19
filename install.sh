#!/usr/bin/env bash
# Installs djt-hub's dependencies and puts a djt-hub shim in ~/.local/bin.
# Nothing runs in the background: each process starts its own server with
# `djt-hub up`. Also removes the launchd daemon that older installs set up.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${DJT_HUB_BIN_DIR:-$HOME/.local/bin}"
launchd_label="com.djaunt.djt-hub"
launchd_plist="$HOME/Library/LaunchAgents/$launchd_label.plist"

if ! command -v bun >/dev/null 2>&1; then
  echo "djt-hub: bun not found; install it (brew install oven-sh/bun/bun)" >&2
  exit 1
fi
bun_path="$(command -v bun)"

(cd "$repo" && bun install --frozen-lockfile)

mkdir -p "$bin_dir"
cat > "$bin_dir/djt-hub.new" <<EOF
#!/bin/sh
exec "$bun_path" "$repo/src/cli/main.ts" "\$@"
EOF
chmod +x "$bin_dir/djt-hub.new"
mv -f "$bin_dir/djt-hub.new" "$bin_dir/djt-hub"
echo "wrote $bin_dir/djt-hub"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on PATH" >&2 ;;
esac

if [[ "$(uname)" == "Darwin" ]] && { [[ -f "$launchd_plist" ]] || launchctl print "gui/$(id -u)/$launchd_label" >/dev/null 2>&1; }; then
  launchctl bootout "gui/$(id -u)/$launchd_label" 2>/dev/null || true
  rm -f "$launchd_plist"
  echo "removed the old djt-hub launchd daemon"
fi
