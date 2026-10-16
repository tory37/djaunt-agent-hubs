#!/usr/bin/env bash
# Builds djt-hub into ~/.local/bin and (on macOS) runs it under launchd.
# Safe to rerun: a rebuild replaces the binary and restarts the daemon.
#   ./install.sh               build + launchd
#   ./install.sh --no-launchd  build only
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${DJT_HUB_BIN_DIR:-$HOME/.local/bin}"
use_launchd=true
[[ "${1:-}" == "--no-launchd" ]] && use_launchd=false

if ! command -v go >/dev/null 2>&1; then
  echo "djt-hub: go not found; install it (brew install go)" >&2
  exit 1
fi

mkdir -p "$bin_dir"
(cd "$repo" && go build -trimpath -ldflags "-s -w" -o "$bin_dir/djt-hub.new" ./cmd/djt-hub)
mv -f "$bin_dir/djt-hub.new" "$bin_dir/djt-hub"
echo "built $bin_dir/djt-hub"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on PATH" >&2 ;;
esac

if $use_launchd && [[ "$(uname)" == "Darwin" ]]; then
  "$bin_dir/djt-hub" install
elif $use_launchd; then
  echo "launchd skipped (not macOS); run '$bin_dir/djt-hub serve' under your own supervisor" >&2
fi
