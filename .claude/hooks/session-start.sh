#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR must be set}"

pnpm install --frozen-lockfile

# pnpm build (tsc -b) is also the typecheck/lint step for this repo, and the
# CLI E2E test suite spawns cli/dist/bin.js, which only exists after a build.
pnpm build

# Global Claude Code plugins used for reviewing this repo's PRs.
# Non-fatal: a GitHub hiccup here must not block the pnpm install/build above,
# which is what tests and linting actually depend on.
claude plugin marketplace add anthropics/claude-code || echo "warning: failed to add claude-code-plugins marketplace (non-fatal)" >&2
claude plugin install pr-review-toolkit@claude-code-plugins -s user -y || echo "warning: failed to install pr-review-toolkit plugin (non-fatal)" >&2
claude plugin install code-review@claude-code-plugins -s user -y || echo "warning: failed to install code-review plugin (non-fatal)" >&2
