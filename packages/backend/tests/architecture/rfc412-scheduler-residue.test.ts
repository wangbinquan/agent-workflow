// RFC-412: structural locks for the last task-execution mechanics that left services/scheduler.ts — the automatic
// commit&push tail (engine/node/commit-push/) and the read-only member inspection (engine/task/) on their own ports —
// and for the execution state type that moved into composition. Reads the production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const COMMIT = TE + 'engine/node/commit-push/runCommitPush.ts'
const INSPECTION = TE + 'engine/task/readonlyInspection.ts'
const COMMIT_PORT = TE + 'application/ports/commitPush.ts'
const INSPECTION_PORT = TE + 'application/ports/readonlyInspection.ts'
const BINDING = TE + 'composition/commitPushBinding.ts'
const STATE = TE + 'composition/taskMechanicsState.ts'
const DELETED = [
  PREFIX + 'services/scheduler.ts',
  PREFIX + 'services/execution/taskMechanicsState.ts',
  // RFC-475: the commit tail's legacy helpers left services/ by owner — the commit attempt is
  // task-execution infrastructure, the built-in commit agent task-execution domain, the git half
  // source-control's workspace change publication.
  PREFIX + 'services/commitPush.ts',
  PREFIX + 'services/commitPushRunner.ts',
]
/** Every moved symbol and its one owner. */
const OWNERS = new Map([
  ['runAutoCommitPush', COMMIT],
  ['inspectReadonlyRepos', INSPECTION],
  ['AutoCommitPushPorts', COMMIT_PORT],
  ['AutoCommitPushRequest', COMMIT_PORT],
  ['ReadonlyInspectionPorts', INSPECTION_PORT],
  ['createAutoCommitPushPorts', BINDING],
  ['createReadonlyInspectionPorts', BINDING],
  ['readCommitExcludePatterns', BINDING],
  ['TaskMechanicsState', STATE],
])
const UNITS = backendUnits(ROOT)

const scans = new WeakMap<SourceUnit, ReadonlyMap<string, number>>()

function declared(unit: SourceUnit): ReadonlyMap<string, number> {
  const cached = scans.get(unit)
  if (cached !== undefined) return cached
  const found = new Map<string, number>()
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      OWNERS.has(node.name.text)
    )
      found.set(node.name.text, (found.get(node.name.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  scans.set(unit, found)
  return found
}

function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const owners = new Map<string, string[]>()
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    for (const [name, count] of declared(unit))
      for (let index = 0; index < count; index += 1)
        owners.set(name, [...(owners.get(name) ?? []), unit.path])
  }
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name) ?? []
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

/** A deleted file back, or the execution state type named outside composition. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (
      unit.path.startsWith(PREFIX) &&
      !unit.path.startsWith(TE + 'composition/') &&
      /\bTaskMechanicsState\b/.test(unit.text)
    )
      found.push('state-outside-composition:' + unit.path)
  }
  return found.sort()
}

/** The two engine files import only module layers and shared; nothing imports a deleted file. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const shared = (target: string) =>
    target === '@agent-workflow/shared' || target.startsWith('packages/shared/src/')
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    if (from === COMMIT || from === INSPECTION) {
      const inner = [TE + 'domain/', TE + 'application/', TE + 'engine/'].some((prefix) =>
        target.startsWith(prefix),
      )
      if (!inner && !shared(target) && !target.startsWith('node:'))
        found.push('layer-import:' + from + ' -> ' + target)
    }
  }
  return found.sort()
}

test('live corpus: the commit tail and the inspection run on ports, the state lives in composition', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of new Set(OWNERS.values()))
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(shapeViolations(UNITS)).toEqual([])
  expect(importViolations(UNITS)).toEqual([])
})

test('negative fixtures: a missing, duplicated or relocated owner is detected', () => {
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const extra = sourceUnit(PREFIX + 'services/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  const outside = PREFIX + 'services/revived.ts'
  expect(shapeViolations([sourceUnit(outside, 'export type S = TaskMechanicsState')])).toContain(
    'state-outside-composition:' + outside,
  )
  for (const [from, target] of [
    [COMMIT, '@/services/commitPushRunner'],
    [COMMIT, '@/modules/source-control/public/participants'],
    [INSPECTION, '../../composition/taskMechanicsState'],
  ] as const)
    expect(
      importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
        v.startsWith('layer-import:'),
      ),
      from,
    ).toBe(true)
  for (const target of [
    '@/services/scheduler',
    '@/services/execution/taskMechanicsState',
    '@/services/commitPush',
    '@/services/commitPushRunner',
  ]) {
    const file = TE + 'composition/revived.ts'
    expect(importViolations([sourceUnit(file, `import { x } from '${target}'`)])).toContain(
      'deleted-reference:' + file,
    )
  }
})
