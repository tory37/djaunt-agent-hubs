#!/usr/bin/env bash
# Installs djt-hub's dependencies, puts a djt-hub shim in ~/.local/bin, and
# (on macOS) runs the daemon under launchd. Safe to rerun: it restarts the daemon.
#   ./install.sh               install + launchd
#   ./install.sh --no-launchd  install only
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${DJT_HUB_BIN_DIR:-$HOME/.local/bin}"
use_launchd=true
[[ "${1:-}" == "--no-launchd" ]] && use_launchd=false

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

if $use_launchd && [[ "$(uname)" == "Darwin" ]]; then
  "$bin_dir/djt-hub" install
elif $use_launchd; then
  echo "launchd skipped (not macOS); run 'djt-hub serve' under your own supervisor" >&2
fi
