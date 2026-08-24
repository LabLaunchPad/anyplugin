# Contributing to AnyPlugin

Thanks for contributing! AnyPlugin is an agent-agnostic plugin framework: one canonical manifest compiled into native plugin bundles for Claude Code, OpenCode, Codex CLI, and Antigravity.

AI coding agents: read [`AGENTS.md`](AGENTS.md) first — it contains the repo map, source-of-truth table, and definition of done.

## Setup

- Node.js >= 20 and pnpm 11 (`corepack enable` or `npm i -g pnpm`)
- Windows with long paths: run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1`

```bash
git clone https://github.com/LabLaunchPad/anyplugin
cd anyplugin
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`pnpm build` (tsc) is also the typecheck — there is no separate lint step. CI runs the same matrix on every PR: Ubuntu (Node 20 & 24) and Windows (Node 24).

## What we look for in PRs

1. `pnpm build` and `pnpm test` pass locally (86 tests, including runtime E2E that spawns the real runner and MCP server, and install-journal conflict suites).
2. Schema changes update `anyplugin.plugin.schema.json` (a sync test enforces this).
3. Event-mapping changes update `knowledge/adapters/event-mapping.md` (a drift test enforces this).
4. New installer destinations are whitelisted templates with tests proving uninstall fully reverses them.
5. No new runtime dependencies without justification in the PR description.
6. Never reintroduce the old "prism" naming in code, docs, or identifiers.

## Adding a new agent adapter

See the recipe in [`AGENTS.md`](AGENTS.md#how-to-add-an-agent-recipe). The short version: adapters are pure emitters that render a native bundle and return an install plan; detection and event mapping live in core; the CLI executes plans.

## The PR review loop

Every PR goes through the same loop — for humans and AI coding agents alike:

1. **Open the PR** against `main`; the pull request template structures the description.
2. **Review pass** — a reviewer (person or agent) reads the full diff and reports only high-confidence P0/P1 findings (bugs, security, cross-platform breakage, untrue tests/docs). Findings land in the "Review loop log" section.
3. **Fix** everything accepted in the PR; verify with `pnpm build && pnpm test`; push. Append an iteration line to the log.
4. **Re-review** the updated diff. Repeat 2–3 (at most 3 iterations; if still red, step back and discuss design instead of patching).
5. **Converge** — a full pass with zero P0/P1 findings.
6. **CI green** on all matrix cells (Ubuntu Node 20/24, Windows Node 24).
7. **Explicit GO** — a maintainer records GO on the PR. Only then merge. No auto-merge, no self-merge without GO.

The loop's guarantees live in tests: schema changes trip the sync test, event-mapping changes trip the drift guard, installer changes must prove reversibility, and the runtime E2E suite executes the real runner and MCP server. CI enforces all of it mechanically; the loop adds the human/agent judgment on top.

## Dependabot PRs stuck on a stale base

Dependabot generally won't rebase a PR whose base merely moved without conflicting — its `auto` rebase-strategy triggers reliably on a real merge conflict, not just on the base advancing. If several dependabot PRs merge back-to-back (as in a batch), an unrelated PR can end up with a stale base and failing CI even though it has no conflict — dependabot may not touch it on its own.

Commenting `@dependabot rebase` is the documented trigger, but don't assume it landed — verify the PR's *head* actually moved afterward (not just the base branch, which advances on every push to `main` regardless of what dependabot did):

```bash
git merge-base --is-ancestor origin/main origin/<dependabot-branch> && echo "rebase landed"
```

If it didn't land, rebase manually instead of re-commenting — or use GitHub's "Update branch" button on the PR if branch protection's "Require branches to be up to date" exposes one, which does the same merge without a local checkout. To do it locally (needed when the merge must be built/tested before pushing):

```bash
git fetch origin main <dependabot-branch>
git worktree add ../wt-pr<N> origin/<dependabot-branch> --detach
cd ../wt-pr<N> && git merge origin/main --no-edit
# full-scratch build + test before pushing (see Setup above)
git push origin HEAD:<dependabot-branch>
cd - && git worktree remove ../wt-pr<N>
```

This puts a merge commit on the dependabot branch, which is fine today but would be rejected under "Require linear history" and gets discarded by any later dependabot force-push. `rebase-strategy: auto` in `dependabot.yml` (the default) only covers the conflict case above — it does not make this scenario impossible.

## Branch protection on `main`

The PR review loop above is a convention enforced by discipline, not by GitHub — nothing currently stops a direct push or a merge with red CI. A repo admin should turn on branch protection for `main` to make it durable:

**Settings → Branches → Add branch protection rule** for `main`:

- Require a pull request before merging (no direct pushes)
- Require status checks to pass before merging, selecting the full CI matrix: `test (ubuntu-latest, 22)`, `test (ubuntu-latest, 24)`, `test (windows-latest, 24)`, `runtime-node-20`
- Require branches to be up to date before merging
- Require at least 1 approving review (this is what "Explicit GO" in the loop above formalizes)
- "Do not allow bypassing the above settings" so it applies to admins too

Equivalently, via the API (requires admin token):

```bash
gh api repos/LabLaunchPad/anyplugin/branches/main/protection -X PUT --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test (ubuntu-latest, 22)", "test (ubuntu-latest, 24)", "test (windows-latest, 24)", "runtime-node-20"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 1},
  "restrictions": null
}
EOF
```

## Reporting bugs / proposing features

Open an issue using the bug or feature template. For security issues, see [`SECURITY.md`](SECURITY.md) — do not open public issues for vulnerabilities.
