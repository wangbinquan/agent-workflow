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
    readonly: true,
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

  test('HEAD journal has 32 entries (sanity — locks the freeze target indices)', () => {
    // If a future migration is added, raise FREEZE_TARGETS' upper index
    // accordingly or this assertion will block the cascade. RFC-058 PR-B T11
    // bumped to 31 with migration 0031_rfc058_clarify_rounds_unify; RFC-059 T2
    // bumped to 32 with migration 0032_rfc059_clarify_rounds_question_scopes.
    expect(HEAD_TOTAL_MIGRATIONS).toBe(32)
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
