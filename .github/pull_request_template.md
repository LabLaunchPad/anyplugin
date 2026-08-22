<!-- Review–fix–re-review loop: see CONTRIBUTING.md "PR review loop". Merge only on explicit GO. -->

## Summary

<!-- What this PR does and why. One paragraph. -->

## Changes

<!-- Bullet list of behavioral changes (not file list). -->

## Review loop log

<!-- One line per review iteration. Append as you iterate. -->

- Iteration 1: <findings count> finding(s) → <fixed / n/a>

## Checklist (author)

- [ ] `pnpm build` clean (tsc is the typecheck)
- [ ] `pnpm test` green — no new skips, E2E included
- [ ] Manifest schema touched → `anyplugin.plugin.schema.json` updated (sync test green)
- [ ] `NATIVE_EVENT_MAP` touched → `knowledge/adapters/event-mapping.md` updated (drift test green)
- [ ] Installer destinations touched → whitelist entry added + uninstall reversibility proven by test
- [ ] Runtime protocol touched → `AGENTS.md` protocol section still accurate
- [ ] No reintroduction of the old project name (search the tree)
- [ ] Docs (README / AGENTS.md / CHANGELOG) consistent with the final code
- [ ] CI green on all matrix cells (Ubuntu Node 20/24, Windows Node 24)

## Reviewer checklist

- [ ] Zero open P0/P1 findings on the final diff
- [ ] Tests assert real behavior (no tautologies, no weakened assertions)
- [ ] Security invariants intact (path whitelist, marker reversibility, non-blocking runtime)

## Merge gate

- [ ] Explicit GO from the maintainer recorded in this PR
