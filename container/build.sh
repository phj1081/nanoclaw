#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

# Build Claude Code agent image
echo "Building NanoClaw agent container image..."
echo "Image: nanoclaw-agent:${TAG}"
${CONTAINER_RUNTIME} build -t "nanoclaw-agent:${TAG}" .
echo "Built nanoclaw-agent:${TAG}"

# Build Codex agent image (if Dockerfile.codex exists)
if [ -f "$SCRIPT_DIR/Dockerfile.codex" ]; then
  echo ""
  echo "Building NanoClaw Codex agent container image..."
  echo "Image: nanoclaw-codex-agent:${TAG}"
  ${CONTAINER_RUNTIME} build -t "nanoclaw-codex-agent:${TAG}" -f Dockerfile.codex .
  echo "Built nanoclaw-codex-agent:${TAG}"
fi

echo ""
echo "Build complete!"
