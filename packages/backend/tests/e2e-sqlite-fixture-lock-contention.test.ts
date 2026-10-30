import {
  executeSqliteFixtureSql,
  sqliteFixtureStatements,
} from '../../../e2e/fixtures/sqlite-statements'
// Guard: the Playwright fixture SQLite boundary must wait out a concurrent
// writer instead of failing the shard.
//
// WHY THIS EXISTS (nightly e2e-webkit run 30440683412, 2026-07-29)
// ----------------------------------------------------------------
// `e2e/command.ts:runSqlite` writes to the DB file of a LIVE daemon
// (diagnose-repair, lifecycle-diagnose,
// rfc229-workgroup-message-quotes, business-workgroup-scenarios all plant
// state that way). The daemon opens the same file in WAL with
// `PRAGMA busy_timeout = 5000` (packages/backend/src/db/client.ts) so it
// waits for the write lock — but the fixture side did NOT. Any daemon write
// overlapping a fixture write failed instantly with
// `Error: stepping, database is locked (5)`, and the shard went red:
//
//   diagnose-repair.spec.ts › R1 happy: approve-run resolves the alert
//     at clearStuckState (afterEach) → runSql → runSqlite
//
// RFC-254 T29 replaced the `sqlite3` CLI with Bun's embedded SQLite (the CLI
// is absent from the windows-latest runner image). The SUBJECT of this guard is
// unchanged and still load-bearing: whatever the fixture boundary is built on,
// it must set busy_timeout FIRST and wait the concurrent writer out rather than
// failing the shard.
//
// It reproduced on the retry too, because the repair the test had just
// applied leaves the daemon writing while `afterEach` cleans up. The same
// nightly went red on 2026-07-17, -20 and -21 — an intermittent contention
// bug, not a product regression.
//
// The lock below is behavioural, not textual: a separate process holds a
// real `BEGIN IMMEDIATE` write transaction on the same file while
// `runSqlite` runs. With busy_timeout = 0 the CLI returns SQLITE_BUSY at
// once and this test reds (verified by reverting the fix); with the busy
// timeout it blocks until the holder commits and both rows land.
//
// Deliberately NOT wrapping caller SQL in a transaction here: callers may
// carry their own (`rfc229-workgroup-message-quotes.spec.ts` passes
// `PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; …; COMMIT;`), so the helper
// only sets the timeout and leaves statement grouping to the caller.

import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { querySqlite, runSqlite } from '../../../e2e/command'
import {
  patchTaskFixtureSql,
  taskFixtureSql,
  workflowFixtureSql,
} from '../../../e2e/fixtures/model'
import { createTestDb } from './helpers/testDatabase'
import type { TaskFixtureSpec } from './helpers/model'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

/** How long the competing writer keeps the write lock. The real discriminator
 * below is throw-vs-return, not wall clock; this window only has to be wide
 * enough that the lock is still demonstrably held when `runSqlite` starts, with
 * slack for a loaded CI runner between the ready marker and that call. */
const HOLD_MS = 1_500

/** Separate PROCESS on purpose: `execFileSync` blocks this thread, so an
 * in-process holder could never release the lock while `runSqlite` waits. */
const HOLDER_SOURCE = `import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'

const [dbPath, readyPath, holdMs, sql] = Bun.argv.slice(2)
const db = new Database(dbPath)
db.exec('PRAGMA busy_timeout = 5000;')
db.exec('BEGIN IMMEDIATE;')
if (sql) db.exec(sql)
writeFileSync(readyPath, 'ready')
await Bun.sleep(Number(holdMs))
db.exec('COMMIT;')
db.close()
`

const scratch: string[] = []

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { force: true, recursive: true })
})

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-sqlite-busy-'))
  scratch.push(dir)
  return dir
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(25)
  }
  throw new Error(`competing writer never acquired the lock: ${path}`)
}

describe('e2e sqlite fixture boundary under lock contention', () => {
  test('runSqlite waits out a concurrent write transaction instead of failing', async () => {
    const dir = tmpWorkspace()
    const dbPath = join(dir, 'db.sqlite')
    const readyPath = join(dir, 'holder.ready')
    const holderPath = join(dir, 'holder.ts')
    writeFileSync(holderPath, HOLDER_SOURCE)

    // WAL to match the daemon's journal mode — writer-vs-writer contention
    // is exactly the case WAL does not eliminate.
    const setup = new Database(dbPath)
    setup.exec('PRAGMA journal_mode = WAL;')
    setup.exec('CREATE TABLE fixture_rows (id TEXT PRIMARY KEY);')
    setup.close()

    const holder = Bun.spawn(
      [
        process.execPath,
        holderPath,
        dbPath,
        readyPath,
        String(HOLD_MS),
        "INSERT INTO fixture_rows (id) VALUES ('holder');",
      ],
      { cwd: REPO_ROOT, stderr: 'pipe', stdout: 'pipe' },
    )

    try {
      await waitForFile(readyPath, 10_000)

      // The lock is held right now. Pre-fix this throws
      // "stepping, database is locked (5)" without waiting at all.
      const startedAt = Date.now()
      runSqlite(
        dbPath,
        "BEGIN IMMEDIATE; SELECT id FROM fixture_rows; INSERT INTO fixture_rows (id) VALUES ('fixture'); COMMIT;",
      )
      const waitedMs = Date.now() - startedAt

      // Vacuity guard: proves the lock really was still held, so a green run
      // cannot come from the holder having released early. A zero-timeout CLI
      // returns in single-digit ms, so the threshold sits far from both sides.
      expect(waitedMs).toBeGreaterThan(200)
    } finally {
      await holder.exited
    }

    expect(holder.exitCode).toBe(0)

    // Read-write on purpose: two processes closing at once can lose the
    // close-time checkpoint and leave `-wal` behind, and a READONLY connection
    // cannot create the `-shm` it would then need — that surfaced as a
    // SQLITE_CANTOPEN flake on the macOS runner (CI run 30453546995).
    const verify = new Database(dbPath)
    const ids = verify
      .query<{ id: string }, []>('SELECT id FROM fixture_rows ORDER BY id;')
      .all()
      .map((row) => row.id)
    verify.close()
    expect(ids).toEqual(['fixture', 'holder'])
  }, 30_000)
})

test('fixture statements preserve quoted separators, comments and trigger bodies', () => {
  const raw = new Database(':memory:')
  const source = `
    CREATE TABLE "semi;colon" (value TEXT NOT NULL);
    CREATE TABLE seen(value TEXT);
    -- ; must not split a comment
    CREATE TRIGGER capture AFTER INSERT ON "semi;colon" BEGIN
      INSERT INTO seen VALUES (CASE WHEN NEW.value = 'a;''b' THEN 'yes;' ELSE 'no' END);
      INSERT INTO seen VALUES ('second');
    END;
    /* ignored ; */ INSERT INTO "semi;colon" VALUES ('a;''b');
  `
  try {
    expect(sqliteFixtureStatements(source)).toHaveLength(4)
    executeSqliteFixtureSql(raw, source)
    expect(raw.query('SELECT value FROM seen').all()).toEqual([
      { value: 'yes;' },
      { value: 'second' },
    ])
    expect(() =>
      raw.transaction(() =>
        executeSqliteFixtureSql(
          raw,
          `INSERT INTO "semi;colon" VALUES ('rolled back'); INSERT INTO "semi;colon" VALUES (NULL); INSERT INTO "semi;colon" VALUES ('unreachable');`,
        ),
      )(),
    ).toThrow('NOT NULL')
    expect(raw.query('SELECT value FROM "semi;colon"').all()).toEqual([{ value: "a;'b" }])
  } finally {
    raw.close()
  }
})

test('fixture child propagates the first constraint error and rolls back its caller transaction', () => {
  const root = tmpWorkspace(),
    path = join(root, 'constraint.sqlite')
  const raw = new Database(path)
  try {
    raw.exec('CREATE TABLE fixture_rows(id TEXT NOT NULL)')
    expect(() =>
      runSqlite(
        path,
        "BEGIN IMMEDIATE; INSERT INTO fixture_rows VALUES ('before'); INSERT INTO fixture_rows VALUES (NULL); INSERT INTO fixture_rows VALUES ('after'); COMMIT;",
      ),
    ).toThrow()
    expect(raw.query('SELECT id FROM fixture_rows').all()).toEqual([])
  } finally {
    raw.close()
  }
})

// T18 OPS-012: the real epoch-2 artifact is larger than Node's default 1 MiB buffer.
test('fixture queries preserve complete schema-history-sized JSON output', () => {
  const path = join(tmpWorkspace(), 'large-receipt.sqlite')
  const artifact = JSON.stringify({ contract: 'x'.repeat(2 * 1024 * 1024) })
  // The fixture child opens an existing database and deliberately never creates one.
  writeFileSync(path, '')
  // Use the same child-process fixture boundary for setup and reading the receipt.
  runSqlite(
    path,
    `CREATE TABLE receipt (artifact_json TEXT NOT NULL); INSERT INTO receipt VALUES ('${artifact}');`,
  )
  expect(querySqlite(path, 'SELECT artifact_json FROM receipt')).toEqual([
    { artifact_json: artifact },
  ])
})

// CI 40983740544 (macOS, diagnose-repair R1): `patchTaskFixtureSql` opened its savepoint by reading
// the selected ids into a temp table, so its UPDATE had to upgrade a read snapshot to a write.
// Inside a transaction SQLite does not busy-wait for that upgrade, and a daemon write in between
// failed the fixture with SQLITE_BUSY_SNAPSHOT. Here another process holds the write lock while
// the patch runs: before the fix the UPDATE fails at once, now the patch waits and lands. It reuses
// HOLDER_SOURCE with no statement, so the lock is all the holder takes.
test('an aggregate patch waits for a concurrent writer instead of failing its savepoint', async () => {
  const dir = tmpWorkspace()
  const dbPath = join(dir, 'db.sqlite')
  const readyPath = join(dir, 'holder.ready')
  const holderPath = join(dir, 'holder.ts')
  writeFileSync(holderPath, HOLDER_SOURCE)
  const task: TaskFixtureSpec = {
    id: 'busy-task',
    workflowId: 'wf',
    workflowSnapshot: { nodes: [], edges: [] },
    repoPath: '/repo',
    worktreePath: '/work',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'done',
    inputs: {},
    startedAt: 10,
  }
  const fixture = await createTestDb({ provider: 'sqlite', filename: dbPath })
  const raw: unknown = Reflect.get(fixture.db, '$client')
  if (!(raw instanceof Database)) throw new Error('expected SQLite fixture')
  try {
    raw.exec('PRAGMA journal_mode = WAL;')
    executeSqliteFixtureSql(
      raw,
      workflowFixtureSql({ id: 'wf', name: 'busy-wf', definition: { nodes: [], edges: [] } }) +
        taskFixtureSql(task),
    )
  } finally {
    await fixture.close()
  }

  const holder = Bun.spawn([process.execPath, holderPath, dbPath, readyPath, String(HOLD_MS)], {
    cwd: REPO_ROOT,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  try {
    await waitForFile(readyPath, 10_000)
    const startedAt = Date.now()
    runSqlite(dbPath, patchTaskFixtureSql({ id: 'busy-task' }, { status: 'running' }))
    // The lock was still held, so a pass cannot come from the holder releasing early.
    expect(Date.now() - startedAt).toBeGreaterThan(200)
  } finally {
    await holder.exited
  }
  expect(holder.exitCode).toBe(0)
  expect(querySqlite(dbPath, "SELECT status FROM tasks WHERE id = 'busy-task'")).toEqual([
    { status: 'running' },
  ])
}, 30_000)
