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

import { runSqlite } from '../../../e2e/command'

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

const [dbPath, readyPath, holdMs] = Bun.argv.slice(2)
const db = new Database(dbPath)
db.exec('PRAGMA busy_timeout = 5000;')
db.exec('BEGIN IMMEDIATE;')
db.exec("INSERT INTO fixture_rows (id) VALUES ('holder');")
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

    const holder = Bun.spawn([process.execPath, holderPath, dbPath, readyPath, String(HOLD_MS)], {
      cwd: REPO_ROOT,
      stderr: 'pipe',
      stdout: 'pipe',
    })

    try {
      await waitForFile(readyPath, 10_000)

      // The lock is held right now. Pre-fix this throws
      // "stepping, database is locked (5)" without waiting at all.
      const startedAt = Date.now()
      runSqlite(dbPath, "INSERT INTO fixture_rows (id) VALUES ('fixture');")
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
