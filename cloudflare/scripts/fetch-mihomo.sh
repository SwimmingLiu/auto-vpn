#!/usr/bin/env bash
# Fetch the mihomo binary the container image installs.
#
# The image is linux/amd64 (Cloudflare Containers requirement), so one binary
# covers every build. It is vendored rather than downloaded inside the Docker
# build because the Docker VM on a workstation often cannot reach GitHub's
# release CDN — the redirect target is on a different host than github.com and
# a proxy that passes the first request may still abort the second.
#
# Usage: scripts/fetch-mihomo.sh [version]
set -euo pipefail

VERSION="${1:-v1.19.34}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/container/vendor"
TARGET="$VENDOR/mihomo-linux-amd64"

mkdir -p "$VENDOR"
if [ -x "$TARGET" ]; then
  echo "already present: $TARGET"
  "$TARGET" -v || true
  exit 0
fi

URL="https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/mihomo-linux-amd64-compatible-${VERSION}.gz"
echo "fetching $URL"
curl -fsSL --retry 5 --retry-delay 3 "$URL" -o "$VENDOR/mihomo.gz"
gunzip -f "$VENDOR/mihomo.gz"
mv "$VENDOR/mihomo" "$TARGET"
chmod 0755 "$TARGET"
"$TARGET" -v
