// RFC-213 PR-2 — fail-closed boot integrity gate.
//
// design/RFC-213-disaster-recovery/design.md §4/§7 (design-gate blocker #4):
// a truncated / header-clobbered DB throws at OPEN or the first PRAGMA — BEFORE
// quick_check — so it does NOT exercise the quick_check gate. Only a
// header-INTACT, page-corrupt DB reaches quick_check. This fixture builds that
// exact shape so the gate has REAL behavioural coverage.
//
// MUTATION CHECKS (manually verified):
//   - delete the quick_check block in openDb → the page-corrupt DB opens
//     silently → the "should throw DbCorruptionError" case reds.
//   - change db/integrity.ts to `{ readonly: false }` → the readonly source lock reds.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Database } from 'bun:sqlite'
import { ulid } from 'ulid'
import { openDb, DbCorruptionError, type DbClient } from '../src/db/client'
import { quickCheckDbFile } from '../src/db/integrity'
import { workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-boot-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

/** A healthy, consolidated (no -wal) DB file with several content pages. */
async function seedManyPages(dbPath: string): Promise<number> {
  const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
  for (let i = 0; i < 120; i++) {
    await db.insert(workflows).values({
      id: ulid(),
      name: `wf-${i}`,
      definition: JSON.stringify({
        $schema_version: 3,
        inputs: [],
        nodes: [],
        edges: [],
        pad: 'x'.repeat(300),
      }),
    })
  }
  const s = sqliteOf(db)
  const { rootPage } = s
    .query("SELECT rootpage AS rootPage FROM sqlite_schema WHERE name = 'workflows'")
    .get() as { rootPage: number }
  s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  s.close()
  // Keep the (now-empty) -wal/-shm sidecars: a checkpoint folds all frames into
  // db.sqlite, so corrupting db.sqlite is the sole source of truth, and openDb
  // reopens the WAL DB exactly as the daemon does on boot.
  return rootPage
}

/** Make a live table b-tree structurally invalid without touching the DB header. */
function corruptBtreeRootPage(dbPath: string, rootPage: number) {
  const bytes = readFileSync(dbPath)
  const encodedPageSize = bytes.readUInt16BE(16)
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize
  const pageOffset = (rootPage - 1) * pageSize
  if (rootPage <= 1 || pageOffset >= bytes.length) {
    throw new Error(`invalid workflows root page ${rootPage}`)
  }
  // Valid b-tree page types are 0x02, 0x05, 0x0a, and 0x0d. Invalidating the
  // live workflows root is deterministic; flipping an arbitrary midpoint may
  // only alter payload/free space, which quick_check is not required to flag.
  bytes[pageOffset] = 0xff
  writeFileSync(dbPath, bytes)
  return bytes
}

describe('RFC-213 boot integrity gate (fail-closed)', () => {
  test('a healthy DB opens with no throw and quick_check ok', async () => {
    const dbPath = join(tmp(), 'db.sqlite')
    await seedManyPages(dbPath)
    expect(quickCheckDbFile(dbPath).ok).toBe(true)
    // Re-open (the gate runs) — must not throw.
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    sqliteOf(db).close()
  })

  test('a header-intact, page-corrupt DB throws DbCorruptionError at the gate', async () => {
    const dbPath = join(tmp(), 'db.sqlite')
    const rootPage = await seedManyPages(dbPath)
    corruptBtreeRootPage(dbPath, rootPage)

    // Sanity: the fixture really is page-corrupt (reaches quick_check, not open).
    expect(quickCheckDbFile(dbPath).ok).toBe(false)

    expect(() => openDb({ path: dbPath, migrationsFolder: MIGRATIONS })).toThrow(DbCorruptionError)
  })

  test('a truncated / non-DB file throws DbCorruptionError (normalized at open)', () => {
    const dbPath = join(tmp(), 'db.sqlite')
    writeFileSync(dbPath, Buffer.from('SQLite format 3\x00 but truncated garbage'))
    expect(() => openDb({ path: dbPath, migrationsFolder: MIGRATIONS })).toThrow(DbCorruptionError)
  })

  test('skipIntegrityCheck bypasses the gate (last-resort escape hatch)', async () => {
    const dbPath = join(tmp(), 'db.sqlite')
    const rootPage = await seedManyPages(dbPath)
    corruptBtreeRootPage(dbPath, rootPage)

    // With the check skipped AND migrations skipped (which would read corrupt
    // pages), openDb returns without the gate throwing.
    const db = openDb({
      path: dbPath,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
      skipMigrations: true,
    })
    sqliteOf(db).close()
  })
})

describe('RFC-213 doctor DB-integrity check (AC-10, read-only)', () => {
  const savedHome = process.env.AGENT_WORKFLOW_HOME
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = savedHome
  })

  test('reports ok for a healthy DB and FAILS with restore guidance for a corrupt one', async () => {
    const home = tmp()
    process.env.AGENT_WORKFLOW_HOME = home
    const dbPath = join(home, 'db.sqlite')
    const rootPage = await seedManyPages(dbPath)

    const { checkDbIntegrity } = await import('../src/cli/doctor')
    const healthy = checkDbIntegrity()
    expect(healthy.ok).toBe(true)

    const bytes = corruptBtreeRootPage(dbPath, rootPage)
    const corrupt = checkDbIntegrity()
    expect(corrupt.ok).toBe(false)
    expect(corrupt.message).toContain('restore')
    // The check must NOT have repaired/rewritten the file (read-only).
    expect(readFileSync(dbPath)).toEqual(bytes)
  })

  test('db/integrity.ts opens the DB read-only (config-invariant source lock)', () => {
    // byte-equality can NOT prove read-only-ness (quick_check never writes — design
    // gate blocker #5), so lock the actual invariant: the shared checker opens with
    // `{ readonly: true }`. MUTATION: flip to false → this reds.
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'db', 'integrity.ts'), 'utf-8')
    expect(src.includes('{ readonly: true }')).toBe(true)
    expect(src.includes('readonly: false')).toBe(false)
  })
})
