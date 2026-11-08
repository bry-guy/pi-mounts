#!/usr/bin/env bash
# Builds the pi-local-sandbox container image and turns it into Gondolin VM assets in ~/.cache/pi-mounts.
# Needs docker (or podman as docker). GONDOLIN_CLI overrides the gondolin CLI (e.g. a local checkout's
# host/dist/bin/gondolin.js).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$HOME/.cache/pi-mounts/pi-local-sandbox"
cli="${GONDOLIN_CLI:-$here/node_modules/@earendil-works/gondolin/dist/bin/gondolin.js}"
arch=$([ "$(uname -m)" = x86_64 ] && echo x86_64 || echo aarch64)
docker build -q -f "$here/image/pi-local-sandbox/Containerfile" -t ghcr.io/bry-guy/pi-local-sandbox:latest "$here/image/pi-local-sandbox"
config="$(mktemp)"
sed "s/\"aarch64\"/\"$arch\"/" "$here/image/pi-local-sandbox/gondolin.json" > "$config"
rm -rf "$out"
node "$cli" build --config "$config" --output "$out"
rm -f "$config"
echo "pi-mounts: image in $out"
