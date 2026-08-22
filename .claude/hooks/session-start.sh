#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

pnpm install --frozen-lockfile

# pnpm build (tsc -b) is also the typecheck/lint step for this repo, and the
# CLI E2E test suite spawns cli/dist/bin.js, which only exists after a build.
pnpm build
