// RFC-398 T9 / §7.5 negative proof 4: delete a non-exempt seed in an in-test copy; the real coverage guard fails.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry } from '../../../scripts/release-upgrade/lib/io'
import { buildSeedDatabase, SEEDS } from '../../../scripts/release-upgrade/lib/seed-ledger'
import type { SeedFile } from '../../../scripts/release-upgrade/lib/seed-model'
import { assertBuildCoverage } from './helpers/releaseUpgrade/build'
import { equal, sqliteSnapshot } from './helpers/releaseUpgrade/data'

setDefaultTimeout(60_000)
test('missing recent_repos seed is detected without changing fixture authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-matrix-negative-seed-'))
  try {
    const seeds = join(root, 'seeds')
    cpSync(SEEDS, seeds, { recursive: true })
    const path = join(seeds, 'epoch1/0000_mature_the_liberteens.json'),
      seed = JSON.parse(readFileSync(path, 'utf8')) as SeedFile
    const before = seed.rows.length
    seed.rows = seed.rows.filter((row) => row.table !== 'recent_repos')
    equal(seed.rows.length, before - 1, 'negative mutation removes one fixture row')
    writeFileSync(path, JSON.stringify(seed))
    const release = readRegistry().releases.find((r) => r.tag === 'v0.1.0')!,
      home = join(root, 'home')
    const report = buildSeedDatabase(release, home, { seeds })
    equal(report.failures, [], 'negative remains a valid historical database')
    equal(
      report.tables.find((t) => t.table === 'recent_repos')!.coverage,
      'missing',
      'coverage ledger catches seed deletion',
    )
    const db = new Database(join(home, 'db.sqlite'))
    try {
      expect(() => assertBuildCoverage(release, sqliteSnapshot(db))).toThrow(
        'uncovered table recent_repos',
      )
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
