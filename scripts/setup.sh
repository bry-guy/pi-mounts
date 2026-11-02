#!/usr/bin/env bash
# Builds the sandbox image and fetches the musl mise binary into ~/.cache/pi-mounts.
# GONDOLIN_CLI overrides the gondolin CLI (e.g. a locally patched checkout's host/dist/bin/gondolin.js).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cache="$HOME/.cache/pi-mounts"
mise_version="${MISE_VERSION:-v2026.10.25}"
cli="${GONDOLIN_CLI:-$here/node_modules/@earendil-works/gondolin/dist/bin/gondolin.js}"
mkdir -p "$cache/bin"
node "$cli" build --config "$here/image/pi-worker.json" --output "$cache/pi-worker"
curl -fsSL "https://github.com/jdx/mise/releases/download/$mise_version/mise-$mise_version-linux-arm64-musl" -o "$cache/bin/mise"
chmod +x "$cache/bin/mise"
echo "pi-mounts: image in $cache/pi-worker, mise $mise_version in $cache/bin"
