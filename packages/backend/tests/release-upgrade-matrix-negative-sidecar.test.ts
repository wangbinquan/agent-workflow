// RFC-398 T9 / §7.5 negative proof 2: a copied helper forced to readonly cannot read the no-sidecar release build.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
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
    expect(() => {
      const db = copy.openSqliteForRead(built.sourcePath)
      try {
        db.query('SELECT count(*) FROM tasks').get()
      } finally {
        db.close()
      }
    }).toThrow()
    equal(readFileSync(built.sourcePath), bytes, 'negative does not change source bytes')
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
