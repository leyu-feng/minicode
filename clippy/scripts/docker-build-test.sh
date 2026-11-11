#!/usr/bin/env bash
# Verify the container image builds successfully.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

source "$REPO_ROOT/scripts/container-engine.sh"
if ! require_container_engine; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "SKIP: $CONTAINER_ENGINE is unavailable — skipping build test"
    exit 0
  fi
  exit 1
fi

IMAGE_TAG="paperclip-build-test:$$"
trap 'container rmi "$IMAGE_TAG" >/dev/null 2>&1 || true' EXIT

echo "==> Testing container build with $CONTAINER_ENGINE"
container build \
  -f "$REPO_ROOT/Dockerfile" \
  -t "$IMAGE_TAG" \
  --target production \
  "$REPO_ROOT"

echo "==> Verifying key binaries in image"
container run --rm "$IMAGE_TAG" sh -c '
  set -e
  node --version
  git --version
  gh --version
  rg --version
  python3 --version
  curl --version | head -1
  claude --version 2>/dev/null || echo "claude CLI not found (OK in minimal builds)"
'

echo "==> Verifying PID 1 is an init that reaps adopted orphans"
# Piped in as CMD (`sh -s`) rather than `--entrypoint`, so the image's real
# ENTRYPOINT still runs and PID 1 is exactly what a production container gets.
container run --rm -i "$IMAGE_TAG" sh -s < "$REPO_ROOT/scripts/assert-orphan-reaping.sh"

echo "PASS: Container build test succeeded"
