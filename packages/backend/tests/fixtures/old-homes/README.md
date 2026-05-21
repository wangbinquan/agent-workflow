# old-homes — rolling-upgrade fixtures (RFC-054 W1-6)

`packages/backend/tests/upgrade-rolling.test.ts` proves that a daemon
home stopped at an old migration upgrades cleanly when re-opened against
the current `packages/backend/db/migrations/` folder. Three freeze
points are exercised:

| Journal idx | Tag                       | Significance                                |
| ----------- | ------------------------- | ------------------------------------------- |
| 1           | `0001_cold_sentry`        | earliest meaningful schema (post bootstrap) |
| 13          | `0014_rfc031_plugins`     | mid-period — plugins / RFC-031              |
| 19          | `0020_rfc036_task_collab` | late — last pre RFC-037 multi-user schema   |

## No committed fixture files

The "old home" fixtures are **generated at test runtime**, not stored as
gzipped artifacts in git. Two reasons:

1. **Migration SQL is immutable**. By CLAUDE.md policy, never edit a
   shipped migration. So re-applying `0000…N` byte-for-byte against an
   empty SQLite produces a deterministic schema state at any freeze
   point — no commit hash drift to worry about.
2. **Smaller repo**. A snapshotted SQLite file would be ~50 KB per
   freeze point; gzipped a bit smaller. Three is fine, but the count
   grows over time (every RFC tends to want a fresh freeze near its
   own migration). Skipping the artifacts keeps the repo lean.

The freeze logic lives in `upgrade-rolling.test.ts::freezeAt(idx, out)`
and works by:

1. Reading `meta/_journal.json` from the real migrations folder.
2. Writing a truncated journal (first `idx + 1` entries) into a temp
   dir, copying the matching `*.sql` files and `meta/N_snapshot.json`
   files alongside.
3. Running drizzle `migrate()` against that partial folder onto a
   fresh sqlite at the desired output path.

The result is a SQLite file with `__drizzle_migrations` containing
exactly `idx + 1` rows whose hashes match the prefix of the real
journal — drizzle's later `migrate()` call (with the full folder) sees
those hashes, accepts them, and proceeds from `idx + 1`.

## Adding a new freeze target

Edit `FREEZE_TARGETS` in `upgrade-rolling.test.ts`:

```ts
const FREEZE_TARGETS: FreezeTarget[] = [
  // ...existing
  { idx: 23, tag: '0024_rfc043_distill_capture' },
]
```

The journal idx is the 0-based position in `_journal.json#entries[]`
(NOT the migration file's numeric prefix — those have gaps from
rolled-back migrations like the missing `0013_`). Use:

```sh
jq -r '.entries[] | "\(.idx) \(.tag)"' \
  packages/backend/db/migrations/meta/_journal.json
```

to confirm the mapping.

## Why this also covers `bun test --bail` flake mode

Each test creates its own temp home + DB and tears down on cleanup, so
sequential runs don't share state. The mock-opencode binary is the same
one used by `scheduler.test.ts` (`tests/fixtures/mock-opencode.ts`) so
no new spawn-side surface is introduced.
