// RFC-398 T9 / §7.5: every registry tag/build/provider and history seed is actually registered; approvals are exact and machine-readable.
import { expect, test, setDefaultTimeout } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { persistenceHistory } from '@/bootstrap/persistenceHead'
import { FIXTURES, readRegistry, readL2Approvals } from '../../../scripts/release-upgrade/lib/io'
import {
  readApprovedExemptions,
  readSeed,
  SEEDS,
} from '../../../scripts/release-upgrade/lib/seed-ledger'
import type { CoverageLedger } from '../../../scripts/release-upgrade/lib/seed-model'
import { matrixCases } from './helpers/releaseUpgrade/cases'
import { equal, invariant } from './helpers/releaseUpgrade/data'
import { readOracle } from './helpers/releaseUpgrade/oracle'

function matrixInvocationsInSource(text: string): string[] {
  return [...text.matchAll(/^registerMatrixCase\('([^']+)'\)/gm)].map((match) => match[1]!)
}

function assertMatrixInvocations(invocations: readonly string[], expected: readonly string[]) {
  equal(
    [...invocations].sort(),
    [...expected].sort(),
    'every declared case has exactly one shard invocation',
  )
}

setDefaultTimeout(60_000)
test('registry -> real shard -> exact build/provider mapping, with no dropped tags', () => {
  const registry = readRegistry()
  const shardFiles = readdirSync(import.meta.dir).filter((f) =>
    /^release-upgrade-matrix-.*\.test\.ts$/.test(f),
  )
  // RFC-398 design §7.3 / §7.5: 41 epoch-1 SQLite builds plus native/provider shards.
  expect(shardFiles.length).toBeGreaterThanOrEqual(41)
  const invocations = shardFiles.flatMap((file) =>
    matrixInvocationsInSource(readFileSync(join(import.meta.dir, file), 'utf8')),
  )
  assertMatrixInvocations(
    invocations,
    matrixCases.map((c) => c.id),
  )
  for (const build of registry.l1Builds) {
    const release = registry.releases.find((r) => r.tag === build.representative)!
    const cases = matrixCases.filter((c) => c.buildKey === build.buildKey)
    equal(
      cases.map((c) => c.provider).sort(),
      release.epoch2 || release.epoch1?.postgresql ? ['postgresql', 'sqlite'] : ['sqlite'],
      'provider completeness',
    )
    for (const item of cases) {
      equal(item.tags, build.tags, 'tag aliases')
      equal(item.representative, build.representative, 'representative')
    }
  }
  equal(
    registry.releases.map((r) => r.tag).sort(),
    matrixCases
      .filter((c) => c.provider === 'sqlite')
      .flatMap((c) => [...c.tags])
      .sort(),
    'every registry entry executed',
  )
  const coverage = JSON.parse(
    readFileSync(join(FIXTURES, 'coverage.json'), 'utf8'),
  ) as CoverageLedger
  const exemptions = readApprovedExemptions(),
    oracle = readOracle()
  equal(
    coverage.builds.map((b) => b.buildKey).sort(),
    registry.l1Builds.map((b) => b.buildKey).sort(),
    'coverage build roster',
  )
  for (const build of coverage.builds) {
    equal(build.failures, [], 'seed reconstruction failures')
    for (const table of build.tables) {
      invariant(
        table.rows > 0 ||
          exemptions.some((e) => e.build === build.buildKey && e.table === table.table),
        `uncovered ${build.buildKey}/${table.table}`,
      )
      if (build.epoch === 1)
        invariant(
          oracle.some((e) => e.table === table.table && (!e.provider || e.provider === 'sqlite')),
          `oracle omits ${table.table}`,
        )
    }
  }
})
test('every native history version has a seed and lies on an executed installation or upgrade interval', () => {
  const registry = readRegistry(),
    history = persistenceHistory()
  const installed = matrixCases
    .filter((c) => c.provider === 'sqlite')
    .flatMap((c) => {
      const release = registry.releases.find((r) => r.tag === c.representative)!
      return release.epoch2 ? [release.epoch2.version] : []
    })
  invariant(installed.length > 0, 'no native history execution')
  for (const version of history) {
    readSeed(
      join(SEEDS, 'epoch2', `${String(version.contract.version).padStart(4, '0')}.json`),
      2,
      `${String(version.contract.version).padStart(4, '0')}_${version.contract.slug}`,
    )
    invariant(
      installed.some((start) => start <= version.contract.version),
      'native version is neither installed nor applied by any matrix case',
    )
  }
})
test('only approved exemptions and approved L2 exclusions are authority', () => {
  const exemptions = readApprovedExemptions(),
    approvals = readL2Approvals(),
    registry = readRegistry()
  equal(exemptions.length, 18, 'approved native metadata exemptions')
  for (const e of exemptions)
    equal(
      [e.status, e.approvedBy, e.approvedAt],
      ['approved', 'user', '2026-10-31'],
      'exemption approval',
    )
  equal(approvals.length, 14, 'approved official runtime exclusions')
  const excluded = registry.releases.filter((r) => r.l2.unsupported)
  equal(
    excluded.map((r) => r.tag).sort(),
    approvals.map((a) => a.tag).sort(),
    'exact L2 approval membership',
  )
  for (const release of excluded) {
    const approval = approvals.find((a) => a.tag === release.tag)!
    equal(
      release.l2.approval,
      { approvedBy: approval.approvedBy, approvedAt: approval.approvedAt },
      'registry retains approval',
    )
    equal(release.l2.unsupported, approval.reason, 'approval binds exact reason')
  }
})

// RFC-398 design §7.5: the same roster oracle must reject a dropped or duplicated shard.
test('negative fixture: missing and duplicate matrix invocations are rejected', () => {
  const complete = "registerMatrixCase('fixture-a')\nregisterMatrixCase('fixture-b')"
  const missing = "registerMatrixCase('fixture-a')"
  const duplicate = complete + "\nregisterMatrixCase('fixture-a')"
  const expected = ['fixture-a', 'fixture-b']
  expect(() => assertMatrixInvocations(matrixInvocationsInSource(complete), expected)).not.toThrow()
  expect(() => assertMatrixInvocations(matrixInvocationsInSource(missing), expected)).toThrow(
    'every declared case has exactly one shard invocation',
  )
  expect(() => assertMatrixInvocations(matrixInvocationsInSource(duplicate), expected)).toThrow(
    'every declared case has exactly one shard invocation',
  )
})
