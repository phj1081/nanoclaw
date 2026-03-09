#!/bin/bash
# Build the NanoClaw agent container images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
TAG="${1:-latest}"

# Build Claude Code agent image
AGENT_IMAGE="nanoclaw-agent"
echo "Building NanoClaw agent container image..."
echo "Image: ${AGENT_IMAGE}:${TAG}"
${CONTAINER_RUNTIME} build -t "${AGENT_IMAGE}:${TAG}" .
echo "Build complete: ${AGENT_IMAGE}:${TAG}"
echo ""

# Build Codex agent image
CODEX_IMAGE="nanoclaw-codex-agent"
echo "Building NanoClaw Codex agent container image..."
echo "Image: ${CODEX_IMAGE}:${TAG}"
${CONTAINER_RUNTIME} build -t "${CODEX_IMAGE}:${TAG}" -f Dockerfile.codex .
echo "Build complete: ${CODEX_IMAGE}:${TAG}"
echo ""

echo "All images built!"
echo "  ${AGENT_IMAGE}:${TAG}"
echo "  ${CODEX_IMAGE}:${TAG}"
echo ""
echo "Test Claude Code agent:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${AGENT_IMAGE}:${TAG}"
echo ""
echo "Test Codex agent:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false,\"agentType\":\"codex\"}' | ${CONTAINER_RUNTIME} run -i -e OPENAI_API_KEY=your-key ${CODEX_IMAGE}:${TAG}"
