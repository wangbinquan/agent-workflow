import {
  executableReachability,
  EPOCH2_RUNTIME_ENTRIES,
} from '../helpers/epochMigrationReachability'
// RFC-395 V2: module-free mechanisms and unreachable offline conversion assembly.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { resolve } from 'node:path'
import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'
import { BACKEND_PREFIX } from './rfc294Gates'

// Converter and runtime reachability walk the whole backend import graph: 3.5 s on Ubuntu CI and
// 5.5 s on the macOS nightly (run 40302273687, timed out at the 5 s default); allow 20 s.
setDefaultTimeout(20_000)

function isV2(path: string): boolean {
  return (
    /\/platform\/persistence\/migration\/(conversion|archives)\//.test(path) ||
    /\/platform\/content\/migration\//.test(path) ||
    /\/modules\/[^/]+\/infrastructure\/migration\//.test(path) ||
    path.endsWith('/bootstrap/conversionRules.ts') ||
    path.endsWith('/composition/conversion.ts')
  )
}
function violations(
  units: readonly SourceUnit[],
  entries: readonly string[] = EPOCH2_RUNTIME_ENTRIES,
): string[] {
  const { corpus, reachable } = executableReachability(units, entries)
  const out = corpus.edges
    .filter(
      (edge) =>
        isV2(edge.from.path) &&
        edge.from.path.includes('/platform/') &&
        edge.target.startsWith(BACKEND_PREFIX + 'modules/'),
    )
    .map((edge) => `platform-to-module: ${edge.from.path} -> ${edge.target}`)
  for (const unit of corpus.backend)
    if (isV2(unit.path) && reachable.has(unit.path))
      out.push(`runtime-reaches-conversion: ${unit.path}`)
  return out.sort()
}
describe('RFC-395 V2 migration entry boundary', () => {
  test('runtime entries cannot reach any V2 engine, domain migration or assembly file', () => {
    const units = packageSrcUnits(resolve(import.meta.dir, '../../../..'), 'backend')
    expect(units.length).toBeGreaterThan(1000)
    expect(units.filter((unit) => isV2(unit.path)).length).toBeGreaterThan(30)
    expect(violations(units)).toEqual([])
  })
  test('negative platform import, re-export, dynamic import and relative-import fixtures are rejected', () => {
    const from = BACKEND_PREFIX + 'platform/persistence/migration/conversion/negative.ts'
    const target = BACKEND_PREFIX + 'modules/task-execution/domain/facts.ts'
    for (const text of [
      "import type { Fact } from '@/modules/task-execution/domain/facts'",
      "export * from '@/modules/task-execution/domain/facts'",
      "const p=import('@/modules/task-execution/domain/facts')",
      "const p=require('../../../../modules/task-execution/domain/facts')",
    ]) {
      const result = violations(
        [
          sourceUnit(BACKEND_PREFIX + 'main.ts', ''),
          sourceUnit(from, text),
          sourceUnit(target, 'export type Fact=string'),
        ],
        [BACKEND_PREFIX + 'main.ts'],
      )
      expect(result.some((value) => value.startsWith('platform-to-module:'))).toBe(true)
    }
  })
  test('negative transitive runtime paths through CLI and bootstrap composition cannot load conversion', () => {
    for (const destination of [
      'platform/persistence/migration/conversion/engine.ts',
      'modules/task-execution/infrastructure/migration/run/index.ts',
      'bootstrap/conversionRules.ts',
    ]) {
      const units = [
        sourceUnit(BACKEND_PREFIX + 'main.ts', "import './cli'"),
        sourceUnit(BACKEND_PREFIX + 'cli.ts', "export * from './bootstrap/runtime'"),
        sourceUnit(BACKEND_PREFIX + 'bootstrap/runtime.ts', `export * from '@/${destination}'`),
        sourceUnit(BACKEND_PREFIX + destination, 'export const value=1'),
      ]
      expect(violations(units, [BACKEND_PREFIX + 'main.ts'])).toContain(
        `runtime-reaches-conversion: ${BACKEND_PREFIX + destination}`,
      )
    }
  })
})

test('CLI converter is executable while content codecs and stores are runtime', () => {
  const units = packageSrcUnits(resolve(import.meta.dir, '../../../..'), 'backend')
  const runtime = executableReachability(units, EPOCH2_RUNTIME_ENTRIES).reachable
  expect(runtime.has(BACKEND_PREFIX + 'platform/content/contentRefCodec.ts')).toBe(true)
  expect(runtime.has(BACKEND_PREFIX + 'platform/content/contentStore.ts')).toBe(true)
  const cli = executableReachability(units, [
    BACKEND_PREFIX + 'bootstrap/epochMigrationEntry.ts',
  ]).reachable
  expect(cli.has(BACKEND_PREFIX + 'platform/persistence/migration/conversion/engine.ts')).toBe(true)
  expect(
    cli.has(BACKEND_PREFIX + 'modules/system-operations/application/epochSwitch/runner.ts'),
  ).toBe(true)
})

// AF-D18: deployment profiles execute before daemonStart and must be traversed.
test('both deployment profile roots reject transitive migration imports', () => {
  for (const root of ['bootstrap/standalone.ts', 'bootstrap/crewstation.ts']) {
    expect(EPOCH2_RUNTIME_ENTRIES).toContain(BACKEND_PREFIX + root)
    const target = BACKEND_PREFIX + 'platform/persistence/migration/conversion/engine.ts'
    const units = EPOCH2_RUNTIME_ENTRIES.map((entry) =>
      sourceUnit(entry, entry === BACKEND_PREFIX + root ? "export * from './profileChild'" : ''),
    )
    units.push(
      sourceUnit(
        BACKEND_PREFIX + 'bootstrap/profileChild.ts',
        "const module = import('@/platform/persistence/migration/conversion/engine.ts')",
      ),
      sourceUnit(target, 'export const value = 1'),
    )
    expect(violations(units)).toContain(`runtime-reaches-conversion: ${target}`)
  }
})
