// RFC-398 T9 / §7.5 negative proof 2: a copied helper forced to readonly is observably wrong on the
// no-sidecar release build (macOS: cannot read it; Linux / Windows: leaves sidecars behind).
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as OpenForReadModule from '@/platform/persistence/sqlite/openForRead'
import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'
import { readRegistry, REPO_ROOT } from '../../../scripts/release-upgrade/lib/io'
import { buildReleaseHome } from './helpers/releaseUpgrade/build'
import { equal, invariant } from './helpers/releaseUpgrade/data'

setDefaultTimeout(60_000)
test('plain readonly negative and production helper positive on the same WAL bytes', async () => {
  const built = await buildReleaseHome(
    readRegistry().releases.find((r) => r.tag === 'v0.1.0')!,
    'sqlite-no-sidecar',
  )
  try {
    const bytes = readFileSync(built.sourcePath)
    const original = readFileSync(
      join(REPO_ROOT, 'packages/backend/src/platform/persistence/sqlite/openForRead.ts'),
      'utf8',
    )
    const mutated = original.replace('{ readwrite: true, create: false }', '{ readonly: true }')
    invariant(mutated !== original, 'sidecar negative mutation did not apply')
    const path = join(built.home, 'plain-readonly.ts')
    writeFileSync(path, mutated)
    const copy = (await import(pathToFileURL(path).href)) as typeof OpenForReadModule
    let refused: unknown = null
    try {
      const db = copy.openSqliteForRead(built.sourcePath)
      try {
        db.query('SELECT count(*) FROM tasks').get()
      } finally {
        db.close()
      }
    } catch (error) {
      refused = error
    }
    // Bun on macOS links the system SQLite, which refuses a read-only WAL database without
    // sidecars (the S4 defect). Bun's bundled SQLite on Linux and Windows reads it but leaves
    // -wal/-shm behind the read-only handle (CI run 41287820486, ubuntu shard 25), which the
    // production helper does not: either way the readonly mutation is observable.
    const sidecars = () =>
      existsSync(`${built.sourcePath}-wal`) || existsSync(`${built.sourcePath}-shm`)
    if (process.platform === 'darwin')
      expect(String(refused)).toContain('unable to open database file')
    else expect(sidecars()).toBe(refused === null)
    equal(readFileSync(built.sourcePath), bytes, 'negative does not change source bytes')
    // The positive half starts from the same sidecar-less state.
    rmSync(`${built.sourcePath}-wal`, { force: true })
    rmSync(`${built.sourcePath}-shm`, { force: true })
    const db = openSqliteForRead(built.sourcePath)
    try {
      equal(
        (db.query('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
        1,
        'production helper reads release history',
      )
    } finally {
      db.close()
    }
    equal(readFileSync(built.sourcePath), bytes, 'positive does not change source bytes')
  } finally {
    await built.close()
  }
})
