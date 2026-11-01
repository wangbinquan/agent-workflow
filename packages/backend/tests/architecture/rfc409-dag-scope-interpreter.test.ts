// RFC-409: structural locks for the DAG scope interpreter that left composition/ and services/ for
// engine/scope/ (scope loop, frontier, frontier rules) and domain/ (definition-only wrapper graph).
// Reads the production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const SCOPE = TE + 'engine/scope/'
const LOOP = SCOPE + 'runScope.ts'
const FRONTIER = SCOPE + 'dagFrontier.ts'
const RULES = SCOPE + 'frontierRules.ts'
const GRAPH = TE + 'domain/wrapperGraph.ts'
const PROGRESS = TE + 'domain/wrapperProgress.ts'
const BINDING = TE + 'composition/taskDagScope.ts'
const PORT = TE + 'application/ports/dagScope.ts'
const DELETED = [PREFIX + 'services/dispatchFrontier.ts', TE + 'composition/dagFrontier.ts']
/** Every moved symbol and its one owner. */
const OWNERS = new Map([
  ['runScope', LOOP],
  ['deriveFrontier', FRONTIER],
  ['WRAPPER_KINDS', RULES],
  ['isReviewSupersededRow', RULES],
  ['wrapperRevivalEvidence', RULES],
  ['wrapperHasFreshInnerWork', RULES],
  ['isDispatchable', RULES],
  ['decideScopeOutcome', RULES],
  ['wrapperInnerDescendants', GRAPH],
  ['wrapperExternalUpstreamSources', GRAPH],
  ['readWrapperRevivalIteration', PROGRESS],
  ['createDagScopePorts', BINDING],
  ['driveDagScope', BINDING],
  ['DagScopePorts', PORT],
  ['DagScopeArgs', PORT],
  ['DagNodeOutcome', PORT],
])
/** The scope loop's own machinery; the binding must not regain it. */
const LOOP_MARKERS = ['deriveFrontier(', 'Promise.race(', 'drainCommitPush', 'decideScopeOutcome(']
const UNITS = backendUnits(ROOT)

// One AST walk per unit, cached by unit identity (the negative fixtures re-run the checks over the
// same live corpus; only replaced or added units are new objects).
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

/** Each moved symbol has exactly one declaration in the backend, at its owner. */
function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const owners = new Map<string, string[]>([...OWNERS.keys()].map((name) => [name, []]))
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    for (const [name, count] of declared(unit))
      for (let index = 0; index < count; index += 1) owners.get(name)!.push(unit.path)
  }
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name)!
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

/** The deleted files back, or the scope loop back in the binding. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (unit.path === BINDING)
      for (const marker of LOOP_MARKERS)
        if (unit.text.includes(marker)) found.push('binding-loop:' + marker)
  }
  const binding = units.find((unit) => unit.path === BINDING)
  if (
    binding !== undefined &&
    !binding.text.includes(
      'return runScope(createDagScopePorts(state, wrapperRuntimeFactory), args)',
    )
  )
    found.push('binding-drive')
  return found.sort()
}

/** The scope layer imports only its own module's inner layers; nobody imports the deleted files. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + edge.from.path)
    if (!edge.from.path.startsWith(SCOPE)) continue
    if (
      ![TE + 'domain/', TE + 'application/', TE + 'engine/'].some((prefix) =>
        target.startsWith(prefix),
      ) &&
      target !== '@agent-workflow/shared' &&
      !target.startsWith('packages/shared/src/') &&
      !target.startsWith('node:')
    )
      found.push('layer-import:' + edge.from.path + ' -> ' + target)
  }
  return found.sort()
}

function replaceUnit(units: readonly SourceUnit[], path: string, from: string, to: string) {
  const original = units.find((unit) => unit.path === path)
  if (original === undefined || !original.text.includes(from))
    throw new Error('fixture anchor missing: ' + path + ':' + from)
  return units.map((unit) =>
    unit.path === path ? sourceUnit(path, unit.text.replace(from, to)) : unit,
  )
}

test('live corpus: the scope interpreter lives in engine/scope/, the wrapper graph in domain/, the binding only binds', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of [LOOP, FRONTIER, RULES, GRAPH, BINDING, PORT])
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
  expect(
    ownershipViolations([
      sourceUnit(PREFIX + 'services/dispatchFrontier.ts', 'export function isDispatchable() {}'),
    ]),
  ).toContain('owner:isDispatchable')
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  for (const marker of LOOP_MARKERS)
    expect(shapeViolations([sourceUnit(BINDING, `const loop = () => ${marker}`)])).toEqual(
      expect.arrayContaining(['binding-loop:' + marker, 'binding-drive']),
    )
  for (const [from, target] of [
    [LOOP, '@/services/scheduler'],
    [RULES, '../../infrastructure/runSelection/table/reader'],
    [FRONTIER, '../../composition/nodeExecution'],
    [LOOP, '@/modules/collaboration/public/types'],
  ] as const)
    expect(importViolations([sourceUnit(from, `import { x } from '${target}'`)]).length, from).toBe(
      1,
    )
  for (const target of ['@/services/dispatchFrontier', './dagFrontier']) {
    const file = TE + 'composition/revived.ts'
    expect(importViolations([sourceUnit(file, `import { x } from '${target}'`)])).toContain(
      'deleted-reference:' + file,
    )
  }
})

test('negative fixtures: the binding regaining the loop or skipping the engine is detected', () => {
  const revived = replaceUnit(
    UNITS,
    BINDING,
    'return runScope(createDagScopePorts(state, wrapperRuntimeFactory), args)',
    'return Promise.race([])',
  )
  expect(shapeViolations(revived)).toEqual(
    expect.arrayContaining(['binding-drive', 'binding-loop:Promise.race(']),
  )
})
