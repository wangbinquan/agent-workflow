// Locks the migration stall found on 2026-09-03 by the 4.5GB / 100-client
// evidence run: the daemon's event loop froze for **18.1s** locally and 11.1s on
// the hosted Linux runner during the migration, and every one of the 100 status
// clients timed out at once (`migration status errors=101 ≈ 100 × 1 stall`).
//
// The stall was the safety backup's integrity check. `PRAGMA quick_check` reads
// the whole file and bun:sqlite is synchronous — measured 4.4s on a 4.2GB
// database — and the backup ran it TWICE: once on the temporary file and again
// on the destination, which `renameSync` had just moved without changing a byte.
//
// RFC-311 §6.6 had already removed this class of stall for `VACUUM INTO` by
// moving it to a worker; the verify stayed behind on the main thread. It now
// uses the same worker, and runs once.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { quickCheckOffThread } from '../src/services/backup'

function seedDatabase(path: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  db.exec("INSERT INTO rows (value) VALUES ('a'), ('b')")
  db.close()
}

const backendRoot = resolve(import.meta.dir, '..')

describe('RFC-349 safety-backup integrity check runs off the daemon thread', () => {
  test('a healthy database verifies, and the worker is what did it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc349-verify-'))
    const path = join(dir, 'db.sqlite')
    seedDatabase(path)

    const result = await quickCheckOffThread(path)

    expect(result.offThread, 'the worker must be the one reading the whole file').toBe(true)
  })

  test('a corrupt file still fails: moving the check off-thread must not weaken it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc349-verify-bad-'))
    const path = join(dir, 'db.sqlite')
    writeFileSync(path, 'this is not a SQLite database', 'utf8')

    await expect(quickCheckOffThread(path)).rejects.toThrow()
  })

  test('a real verify failure is not swallowed by the main-thread fallback', () => {
    // The fallback exists for a worker that cannot START (RFC-311 P0-1: the
    // compiled binary once shipped without the worker entry at all). A check
    // that ran and said "not ok" must propagate, never be retried inline and
    // re-reported as a fallback.
    const source = readFileSync(
      resolve(backendRoot, 'src/platform/persistence/sqlite/systemProviderBackup.ts'),
      'utf8',
    )
    expect(source).toContain("error.message.startsWith('backup quick-check failed:')")
  })

  test('the safety backup does not run quick_check inline, and runs it once', () => {
    const source = readFileSync(
      resolve(
        backendRoot,
        'src/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup.ts',
      ),
      'utf8',
    )
    expect(
      source,
      '内联 PRAGMA quick_check 就是把整个多 GB 文件的读放回 daemon 主线程',
    ).not.toContain("query('PRAGMA quick_check')")
    expect(source).toContain('quickCheckOffThread')
    // 一次备份最多校验一次：临时文件校验通过后 renameSync 只是移动同样的字节。
    expect(source.split('await verifySqlite(').length - 1).toBe(2)
  })

  test('the worker still accepts both jobs on one entrypoint', () => {
    const worker = readFileSync(resolve(backendRoot, 'src/services/backupVacuumWorker.ts'), 'utf8')
    expect(worker).toContain('quickCheckPath')
    expect(worker).toContain('vacuumSqliteInto')
    // Same entry the build script already ships (RFC-311 P0-1 lock).
    const build = readFileSync(
      resolve(backendRoot, '..', '..', 'scripts', 'build-binary.ts'),
      'utf8',
    )
    expect(build).toContain("join(backendSrc, 'services', 'backupVacuumWorker.ts')")
  })
})
