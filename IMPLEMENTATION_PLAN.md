# Implementation Plan: Finding E (Transactional Install) + Finding D (Journal Migration)

**Status: COMPLETE** — all phases implemented, all tests green.

| Gate | Result |
|---|---|
| `pnpm build` | Clean |
| `pnpm test` | 469 passed, 6 skipped (Windows symlink tests), 50 files |
| `okf-validate knowledge` | CONFORMANT (0 errors) |
| `anyplugin doctor` | Working, incl. `--fix` |

---

## Phase 1: Journal Schema Versioning (Finding D) — DONE

- [x] `schemaVersion: 1` added to `InstallJournal` + `InstallJournalSchema`
- [x] `migrateJournal(raw)` — upgrades legacy (pre-`schemaVersion`) journals
- [x] Future/unknown versions **fail closed** (`unsupported journal schema version`)
- [x] `readJournal()` routes through `migrateJournal()`; corrupt ⇒ throws (never falls back to legacy cleanup)
- [x] `writeJournal()` always stamps the current version
- [x] `readCurrentWithError()` distinguishes `ENOENT` from `EACCES`/`EPERM`/`OTHER`
- [x] `JournalEntryStatus` gained an `unreadable` variant (fail-closed on unreadable files)

**Tests:** `cli/src/journal-migration-audit.test.ts` (13), `cli/src/journal-validation-audit.test.ts` (8)

## Phase 2: Transaction Engine (Finding E) — DONE

New module `cli/src/transaction.ts`:

- [x] `createTransactionContext()` — staging + backup scratch space
- [x] `writeInstallIntent()` / `readInstallIntent()` — atomic intent manifest (temp + rename)
- [x] `backupDestinations()` — byte-exact file AND directory-tree backups; records `wasAbsent`
- [x] `restoreFromBackups()` — rollback; failures are collected, never thrown (must not mask the original error)
- [x] `verifyAppliedState()` — per-file hash verification (detects partial copies)
- [x] `hashTree()` / `hashDirFiles()` — stable, order-independent tree hashing

`executeInstall()` pipeline in `cli/src/index.ts`:

```
1. PREFLIGHT  classify every destination (ABSENT / OWNED / CONFLICTING); refuse conflicts
2. STAGE      render every incoming byte into staging — host untouched
3. INTENT     persist install_intent.json (atomic)
4. BACKUP     snapshot the current content of every destination
5. APPLY      copy staged bytes onto the host, revalidating ownership (TOCTOU guard)
6. VERIFY     re-hash every destination against the staged hashes
7. COMMIT     write the journal, then purge staging + backups
```

Any failure after STAGE ⇒ rollback restores every destination and purges the scratch space.

**Tests:** `cli/src/install-transactional-audit.test.ts` (20)

## Phase 3: Doctor Diagnostics (Finding L) — DONE

- [x] `anyplugin doctor [--json] [--fix]`
- [x] Detects: stale worker-runtime locks, corrupt journals, outdated journal schemas,
      orphaned install transaction scratch spaces, plugin dirs with no journal
- [x] `--fix` remediates ONLY unambiguous problems (orphan scratch spaces, schema upgrades)
- [x] `--fix` **never** auto-repairs a corrupt journal — it is the only record of owned bytes
- [x] Always exits 0 or 1; never crashes on malformed inputs

**Tests:** `cli/src/doctor-diagnostics.test.ts` (9)

---

## Bugs found and fixed during implementation

| Bug | Root cause | Fix |
|---|---|---|
| Install hang (infinite recursion) | Staging dir was created **inside** the install root, which is also the "root" copy destination ⇒ `copyDir(staged → dest)` copied a dir into its own subtree | `transactionWorkspaceRoot()` returns a **sibling** of the installed root |
| `{{PLUGIN_ROOT}}` resolved to a deleted staging path | Substitution ran on the staged copy using the staging path as the root | Substitute with the **final destination** path |
| Reinstall always falsely conflicted | Ownership for non-root copies (skills/commands/agent) was looked up in the *destination* dir, but the journal lives in the *installed root* | `classifyDestination()` now takes `journalRoot` and consults the root journal's copy entries |
| `--fix` rejected by the CLI parser | `ALL_OPTIONS` allowlist in `strict-args.ts` did not include `fix` | Added `fix` (boolean) to the allowlist and to the `doctor` schema |

---

## File changes

| File | Change |
|---|---|
| `cli/src/transaction.ts` | **NEW** — staging/backup/verify/rollback engine |
| `cli/src/journal.ts` | `schemaVersion`, `migrateJournal()`, `readCurrentWithError()`, `unreadable` status |
| `cli/src/index.ts` | Transactional `executeInstall`, `transactionWorkspaceRoot()`, ownership lookup fix, `__onApplied` test seam |
| `cli/src/bin.ts` | `doctor --fix` remediation, orphaned-transaction + outdated-schema detection |
| `cli/src/strict-args.ts` | `doctor` schema gains `--home/--project/--fix`; `fix` added to `ALL_OPTIONS` |
| `cli/src/install-transactional-audit.test.ts` | **NEW** — 20 tests |
| `cli/src/journal-migration-audit.test.ts` | **NEW** — 13 tests |
| `cli/src/doctor-diagnostics.test.ts` | **NEW** — 9 tests |
| `AGENTS.md` | Audit findings C/D/E marked FIXED; transaction engine documented |
