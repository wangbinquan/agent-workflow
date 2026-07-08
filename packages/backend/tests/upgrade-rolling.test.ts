// RFC-054 W1-6 — rolling upgrade test.
//
// LOCKS: a daemon home stopped at an old migration must (a) accept the
// current migrations folder on startup and apply the missing migrations
// idempotently, (b) end up with the HEAD schema (all 29 entries in
// `__drizzle_migrations` + all current tables present), and (c) remain
// operationally functional — a fresh task driven by the scheduler runs
// through to `done`. A regression in any of these three means existing
// users can't upgrade past whatever migration broke the chain.
//
// Strategy (RFC-054-T6): the test generates the "old home" fixtures
// **at runtime** by truncating drizzle's `_journal.json` to the first
// N entries and running `migrate()` against that partial folder. The
// migration SQL files in `packages/backend/db/migrations/` are by policy
// append-only / immutable (per CLAUDE.md), so the byte-identical SQL
// re-application produces a deterministic schema state at any freeze
// point — no committed fixture files are needed, and the test never
// ages out of step with the SQL.
//
// Three freeze targets per W1-6 plan:
//   - journal idx 1  (0001_cold_sentry)         — earliest schema
//   - journal idx 13 (0014_rfc031_plugins)      — mid-period plugins
//   - journal idx 19 (0020_rfc036_task_collab)  — late, just pre RFC-037

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { eq } from 'drizzle-orm'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface FreezeTarget {
  /** Drizzle journal idx (0-indexed into `entries[]`). */
  idx: number
  /** Migration `tag` for readable test names. */
  tag: string
}

const FREEZE_TARGETS: FreezeTarget[] = [
  { idx: 1, tag: '0001_cold_sentry' },
  { idx: 13, tag: '0014_rfc031_plugins' },
  { idx: 19, tag: '0020_rfc036_task_collab' },
]

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

/** Create a partial migrations folder + apply just the first `idx + 1` migrations
 *  to a fresh sqlite at `outDbPath`. The DB is closed before return.
 */
function freezeAt(idx: number, outDbPath: string): void {
  const fullJournal = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal
  if (idx < 0 || idx >= fullJournal.entries.length) {
    throw new Error(`freezeAt: idx ${idx} out of range [0, ${fullJournal.entries.length})`)
  }
  const partialMigDir = mkdtempSync(join(tmpdir(), 'aw-rolling-partial-mig-'))
  try {
    mkdirSync(join(partialMigDir, 'meta'), { recursive: true })
    const partialJournal: Journal = {
      ...fullJournal,
      entries: fullJournal.entries.slice(0, idx + 1),
    }
    writeFileSync(
      join(partialMigDir, 'meta', '_journal.json'),
      JSON.stringify(partialJournal, null, 2),
      'utf-8',
    )
    for (const entry of partialJournal.entries) {
      const sqlFile = `${entry.tag}.sql`
      copyFileSync(join(MIGRATIONS, sqlFile), join(partialMigDir, sqlFile))
      const snap = `${String(entry.idx).padStart(4, '0')}_snapshot.json`
      const snapSrc = join(MIGRATIONS, 'meta', snap)
      if (existsSync(snapSrc)) {
        copyFileSync(snapSrc, join(partialMigDir, 'meta', snap))
      }
    }
    const sqlite = new Database(outDbPath, { create: true })
    sqlite.exec('PRAGMA foreign_keys = ON;')
    const db = drizzle(sqlite, {})
    migrate(db, { migrationsFolder: partialMigDir })
    sqlite.close()
  } finally {
    rmSync(partialMigDir, { recursive: true, force: true })
  }
}

function countAppliedMigrations(dbPath: string): number {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const row = sqlite.query('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
      n: number
    } | null
    return row?.n ?? 0
  } finally {
    sqlite.close()
  }
}

function listTables(dbPath: string): Set<string> {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    const rows = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    return new Set(rows.map((r) => r.name))
  } finally {
    sqlite.close()
  }
}

const HEAD_TOTAL_MIGRATIONS = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
).entries.length as number

interface Harness {
  home: string
  cleanup: () => void
}

function buildHarness(label: string): Harness {
  const home = mkdtempSync(join(tmpdir(), `aw-rolling-${label}-`))
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

async function seedToyAgent(db: DbClient, name = 'rolling-agent'): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'rolling-upgrade test stub',
    outputs: JSON.stringify(['out']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedToyTask(db: DbClient, worktreePath: string): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  const def = {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'rolling-agent' }],
    edges: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rolling-wf',
    definition: JSON.stringify(def),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rolling-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rolling-repo-never-read',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

function withMockEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('RFC-054 W1-6 — rolling upgrade from old home reaches HEAD + runs toy task', () => {
  let h: Harness
  let label = ''
  beforeEach(() => {
    h = buildHarness(label)
  })
  afterEach(() => h?.cleanup())

  test('HEAD journal has 78 entries (sanity — locks the freeze target indices)', () => {
    // If a future migration is added, raise FREEZE_TARGETS' upper index
    // accordingly or this assertion will block the cascade. RFC-058 PR-B T11
    // bumped to 31 with migration 0031_rfc058_clarify_rounds_unify; RFC-059 T2
    // bumped to 32 with migration 0032_rfc059_clarify_rounds_question_scopes;
    // RFC-067 T2 bumped to 33 with migration 0033_rfc067_task_git_identity;
    // RFC-066 PR-A T2 bumped to 34 with migration 0034_rfc066_task_repos;
    // RFC-064 T9 bumped to 35 with migration 0035_rfc064_unify_clarify_iteration;
    // RFC-070 T4 bumped to 36 with migration 0036_rfc070_clarify_consumed_by_run;
    // RFC-072 T1 bumped to 37 with migration 0037_rfc072_node_run_output_kind;
    // RFC-072 follow-up bumped to 38 with 0038_rfc072_backfill_review_output_kind;
    // RFC-075 PR-A bumped to 39 with 0039_rfc075_working_branch_commit_push;
    // RFC-074 PR-B bumped to 40 with 0040_rfc074_provenance_consumed_runs.
    // RFC-074 PR-C bumped to 41 with 0041_rfc074_drop_clarify_iteration.
    // RFC-079 PR-A bumped to 42 with 0042_rfc079_review_multidoc.
    // RFC-098 B3 bumped to 43 with 0043_rfc098_shard_value_hash.
    // RFC-098 B4 (WP-10) bumped to 44 with 0044_rfc098_rerun_cause.
    // RFC-099 B1 bumped to 45 with 0045_rfc099_ownership_acl.
    // RFC-099 B3 bumped to 46 with 0046_rfc099_drop_node_assignments.
    // RFC-101 PR-A bumped to 47 with 0047_rfc101_skill_versioning.
    // RFC-101 PR-B bumped to 48 with 0048_rfc101_fusion.
    // RFC-104 bumped to 49 with 0049_rfc104_builtin_flag.
    // RFC-109 bumped to 50 with 0050_rfc109_task_workflow_version.
    // RFC-108 T9 bumped to 51 with 0051_rfc108_node_run_spawn_binary.
    // RFC-108 T3 bumped to 52 with 0052_rfc108_recovery_events.
    // RFC-108 PR-D bumped to 53 with 0053_rfc108_task_auto_recovery_breaker.
    // RFC-111 PR-B bumped to 54 with 0054_rfc111_runtime.
    // RFC-112 PR-A bumped to 55 with 0055_rfc112_runtimes.
    // RFC-113 PR-A bumped to 56 with 0056_rfc113_runtime_profile.
    // RFC-115 PR-C bumped to 57 with 0057_rfc115_drop_agent_params.
    // RFC-115 PR-E bumped to 58 with 0058_rfc115_drop_agent_snapshot.
    // RFC-118 bumped to 59 with 0059_rfc118_runtime_enabled.
    // RFC-120 PR-A bumped to 60 with 0060_rfc120_task_questions.
    // RFC-120 v2 bumped to 61 with 0061_rfc120_task_questions_staged.
    // RFC-120 T9 bumped to 62 with 0062_rfc120_deferred_dispatch.
    // RFC-120 §18 bumped to 63 with 0063_rfc120_dispatched_at.
    // RFC-122 bumped to 64 with 0064_rfc122_task_node_clarify_directive.
    // RFC-120 §15 bumped to 65 with 0065_rfc120_manual_questions.
    // RFC-126 bumped to 66 with 0066_rfc126_unabandon_clarify_rounds.
    // RFC-127 bumped to 67 with 0067_rfc127_agent_override.
    // RFC-128 P1 bumped to 68 with 0068_rfc128_task_question_sealed.
    // RFC-129 bumped to 69 with 0069_rfc129_review_selection_stale.
    // RFC-129 bumped to 70 with 0070_rfc129_review_round_generation (impl-gate P2 split).
    // RFC-130 PR-A T2 bumped to 71 with 0071_rfc130_node_run_iso.
    // RFC-130 PR-C bumped to 72 with 0072_rfc130_drop_agent_readonly;
    // RFC-132 PR-F bumped to 73 with 0073_rfc132_drop_consumed_by_and_flag.
    // RFC-140 W2 bumped to 74 with 0074_rfc140_auto_dispatch_deferred.
    // flag-audit §8 bumped to 75 with 0075_flag_audit_markdown_file_backfill.
    // RFC-144 T5 bumped to 76 with 0076_rfc144_abandon_superseded_merge_state.
    // RFC-145 T2 bumped to 77 with 0077_rfc145_failure_code.
    // RFC-153 bumped to 78 with 0078_rfc153_drop_runtime_builtin.
    expect(HEAD_TOTAL_MIGRATIONS).toBe(78)
  })

  for (const target of FREEZE_TARGETS) {
    test(`from journal idx ${target.idx} (${target.tag}): partial apply + upgrade + toy task`, async () => {
      label = `idx${target.idx}`
      const dbPath = join(h.home, 'db.sqlite')

      // 1. Freeze: create a DB stopped at this migration.
      freezeAt(target.idx, dbPath)

      // 2. Partial state should match — N + 1 migrations applied.
      expect(countAppliedMigrations(dbPath)).toBe(target.idx + 1)

      // 3. Open with full migrations folder → drizzle applies the rest.
      const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })

      try {
        // 4. Post-upgrade verification: full journal applied.
        expect(countAppliedMigrations(dbPath)).toBe(HEAD_TOTAL_MIGRATIONS)

        // Key HEAD-state tables must be present (each was added in a
        // migration AFTER our latest freeze target idx 19, so all three
        // freeze points must produce them after the upgrade run).
        const tableNames = listTables(dbPath)
        expect(tableNames.has('users')).toBe(true) // 0018
        expect(tableNames.has('task_collaborators')).toBe(true) // 0020
        expect(tableNames.has('memories')).toBe(true) // 0023
        expect(tableNames.has('lifecycle_alerts')).toBe(true) // 0028

        // 5. Toy task — proves the upgraded DB is operationally usable end-to-
        // end (writes accepted by current schema, scheduler can dispatch a
        // single-node DAG, runner integration with mock-opencode lands done).
        const worktreePath = join(h.home, 'wt')
        mkdirSync(worktreePath, { recursive: true })
        await seedToyAgent(db)
        const { taskId } = await seedToyTask(db, worktreePath)

        await withMockEnv(
          { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'rolling upgrade output' }) },
          () =>
            runTask({
              taskId,
              db,
              appHome: h.home,
              opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
            }),
        )

        const finalTask = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
        expect(finalTask?.status).toBe('done')

        const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
        const a1 = runs.find((r) => r.nodeId === 'a1')
        expect(a1?.status).toBe('done')
      } finally {
        /* db isn't explicitly closed — Bun teardown handles it; the home
           rmSync in afterEach removes the .sqlite + WAL files. */
      }
    })
  }
})

// ---------------------------------------------------------------------------
// RFC-120 §18 — migration 0063 rolling-upgrade backfill (Codex ship-gate H1).
// A row dispatched under the PRIOR (pre-§18) contract has trigger_run_id set +
// the new dispatched_at NULL. The corrected park gate keys on dispatched_at, so
// 0063 must BACKFILL dispatched_at for such rows (scoped to deferred tasks) or
// the gate re-parks / duplicate-mints them on upgrade.
// ---------------------------------------------------------------------------
describe('RFC-120 §18 — migration 0063 dispatched_at backfill', () => {
  test('0063 backfills dispatched_at for pre-§18 deferred bound rows; leaves unbound + non-deferred NULL', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'aw-0063-backfill-')), 'db.sqlite')

    // 1. Freeze at idx 61 (0062_rfc120_deferred_dispatch) — schema BEFORE dispatched_at.
    freezeAt(61, dbPath)

    // 2. Insert pre-§18 rows with raw SQL (the dispatched_at column does not exist yet).
    {
      const sqlite = new Database(dbPath)
      sqlite.exec('PRAGMA foreign_keys = OFF;')
      const insTask = (id: string, deferred: number): void => {
        sqlite.run(
          `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch, status, inputs, started_at, deferred_question_dispatch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            'n',
            'wf',
            '{}',
            '/tmp',
            '',
            'main',
            `b_${id}`,
            'running',
            '{}',
            Date.now(),
            deferred,
          ],
        )
      }
      insTask('t_def', 1)
      insTask('t_nondef', 0)
      const insTQ = (id: string, taskId: string, trigger: string | null): void => {
        // distinct origin per row → satisfies UNIQUE(origin, question_id, role_kind).
        sqlite.run(
          `INSERT INTO task_questions (id, task_id, origin_node_run_id, question_id, question_title, source_kind, role_kind, trigger_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, taskId, `o_${id}`, 'q1', 't', 'cross', 'designer', trigger, 1000, 1000],
        )
      }
      insTQ('tq_def_bound', 't_def', 'run_x') // deferred + bound → BACKFILL
      insTQ('tq_def_unbound', 't_def', null) // deferred + never bound → stays NULL
      insTQ('tq_nondef_bound', 't_nondef', 'run_y') // non-deferred → golden-lock NULL
      sqlite.close()
    }

    // 3. Apply the full migrations folder → drizzle applies ONLY 0063 (ALTER + backfill).
    {
      const sqlite = new Database(dbPath)
      sqlite.exec('PRAGMA foreign_keys = ON;')
      migrate(drizzle(sqlite, {}), { migrationsFolder: MIGRATIONS })
      sqlite.close()
    }

    // 4. Assert the backfill.
    {
      const sqlite = new Database(dbPath, { readonly: true })
      const dispatchedAt = (id: string): number | null =>
        (
          sqlite.query(`SELECT dispatched_at AS d FROM task_questions WHERE id = ?`).get(id) as {
            d: number | null
          } | null
        )?.d ?? null
      // deferred + bound → backfilled to the row's own created_at (1000).
      expect(dispatchedAt('tq_def_bound')).toBe(1000)
      // deferred + never bound (trigger_run_id NULL) → NOT backfilled (still undispatched).
      expect(dispatchedAt('tq_def_unbound')).toBeNull()
      // non-deferred → untouched (golden-lock; that contract never set trigger_run_id this way).
      expect(dispatchedAt('tq_nondef_bound')).toBeNull()
      sqlite.close()
    }
  })
})
