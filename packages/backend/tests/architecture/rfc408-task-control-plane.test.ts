// RFC-408: structural locks for the task control plane that left composition/taskEngineApplication.ts
// for engine/task/, and for the DAG structural graph that moved to engine/scope/. Reads the
// production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const TASK = TE + 'engine/task/'
const SCOPE = TE + 'engine/scope/'
const RUN = TASK + 'runTask.ts'
const SETTLEMENT = TASK + 'taskSettlement.ts'
const GRAPH = SCOPE + 'dagGraph.ts'
const BINDING = TE + 'composition/taskEngineApplication.ts'
const PORT = TE + 'application/ports/taskRun.ts'
const DELETED = [TE + 'composition/taskDagGraph.ts']
/** Every moved symbol and its one owner. */
const OWNERS = new Map([
  ['runTask', RUN],
  ['failTaskRun', SETTLEMENT],
  ['cancelTaskRun', SETTLEMENT],
  ['settleTaskScopeOutcome', SETTLEMENT],
  ['buildScopeUpstreams', GRAPH],
  ['findScopeCycle', GRAPH],
  ['createTaskRunPorts', BINDING],
  ['TaskRunPorts', PORT],
  ['PreparedTaskDrive', PORT],
  ['TaskDrivePreparation', PORT],
])
/** The composition-owned control plane's names; none may come back in task-execution source. */
const RETIRED = ['runTaskEngineOrchestratorInner', 'failRuntimeTask', 'cancelRuntimeTask']
/** Lifecycle reasons only the control plane writes; the binding must not regain the flow. */
const CONTROL_PLANE_REASONS = [
  "'runTask-start'",
  "'scope-awaiting-review'",
  "'scope-awaiting-human'",
  "'task-done'",
  "'cancelTaskRow'",
]
const UNITS = backendUnits(ROOT)

// One AST walk per unit, cached by unit identity (the negative fixtures re-run the checks over the
// same live corpus; only replaced or added units are new objects).
interface UnitScan {
  readonly identifiers: ReadonlySet<string>
  readonly declared: ReadonlyMap<string, number>
}
const scans = new WeakMap<SourceUnit, UnitScan>()

function scan(unit: SourceUnit): UnitScan {
  const cached = scans.get(unit)
  if (cached !== undefined) return cached
  const identifiers = new Set<string>()
  const declared = new Map<string, number>()
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      OWNERS.has(node.name.text)
    )
      declared.set(node.name.text, (declared.get(node.name.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  const result = { identifiers, declared }
  scans.set(unit, result)
  return result
}

/** Each moved symbol has exactly one declaration in task-execution, at its owner. */
function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const owners = new Map<string, string[]>([...OWNERS.keys()].map((name) => [name, []]))
  for (const unit of units) {
    if (!unit.path.startsWith(TE)) continue
    for (const [name, count] of scan(unit).declared)
      for (let index = 0; index < count; index += 1) owners.get(name)!.push(unit.path)
  }
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name)!
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

/** The deleted graph file, retired names, or the control-plane flow back in the binding. */
function flowViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (!unit.path.startsWith(TE)) continue
    const { identifiers } = scan(unit)
    for (const name of RETIRED)
      if (identifiers.has(name)) found.push('retired-name:' + name + ':' + unit.path)
    if (unit.path === BINDING)
      for (const reason of CONTROL_PLANE_REASONS)
        if (unit.text.includes(reason)) found.push('binding-flow:' + reason)
  }
  const binding = units.find((unit) => unit.path === BINDING)
  if (
    binding !== undefined &&
    !binding.text.includes('runTask(createTaskRunPorts(opts, topology, runtimeComponents))')
  )
    found.push('binding-drive')
  return found.sort()
}

/** The control plane and the scope layer import only their own module's inner layers. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + edge.from.path)
    if (!edge.from.path.startsWith(TASK) && !edge.from.path.startsWith(SCOPE)) continue
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

test('live corpus: the control plane lives in engine/task/, the graph in engine/scope/, the binding only binds', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of [RUN, SETTLEMENT, GRAPH, BINDING, PORT])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(flowViolations(UNITS)).toEqual([])
  expect(importViolations(UNITS)).toEqual([])
})

test('negative fixtures: a missing, duplicated or relocated owner is detected', () => {
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const extra = sourceUnit(TE + 'composition/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  expect(
    ownershipViolations([sourceUnit(BINDING, 'export async function runTask() {}')]),
  ).toContain('owner:runTask')
  for (const name of RETIRED)
    expect(
      flowViolations([sourceUnit(TE + 'composition/revived.ts', `async function ${name}() {}`)]),
      name,
    ).toContain('retired-name:' + name + ':' + TE + 'composition/revived.ts')
  for (const reason of CONTROL_PLANE_REASONS)
    expect(flowViolations([sourceUnit(BINDING, `const write = { reason: ${reason} }`)])).toEqual(
      expect.arrayContaining(['binding-flow:' + reason, 'binding-drive']),
    )
  for (const path of DELETED)
    expect(flowViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  for (const [from, target] of [
    [RUN, '@/services/scheduler'],
    [SETTLEMENT, '../../infrastructure/taskRepositorySurface'],
    [RUN, '../../composition/taskDagScope'],
    [GRAPH, '@/modules/collaboration/public/types'],
  ] as const)
    expect(importViolations([sourceUnit(from, `import { x } from '${target}'`)]).length, from).toBe(
      1,
    )
  expect(
    importViolations([
      sourceUnit(TE + 'composition/revived.ts', "import { x } from './taskDagGraph'"),
    ]),
  ).toContain('deleted-reference:' + TE + 'composition/revived.ts')
})

test('negative fixtures: the binding regaining the flow or skipping the control plane is detected', () => {
  const revived = replaceUnit(
    UNITS,
    BINDING,
    'runTask(createTaskRunPorts(opts, topology, runtimeComponents))',
    'runTaskEngineOrchestratorInner(opts, topology, runtimeComponents)',
  )
  expect(flowViolations(revived)).toEqual(
    expect.arrayContaining([
      'binding-drive',
      'retired-name:runTaskEngineOrchestratorInner:' + BINDING,
    ]),
  )
  // Comments and strings are not identifiers: history notes may keep naming the old functions.
  expect(
    flowViolations(
      replaceUnit(
        UNITS,
        BINDING,
        'export function createTaskRunPorts(',
        "// failRuntimeTask moved\nconst note = 'cancelRuntimeTask'\nexport function createTaskRunPorts(",
      ),
    ),
  ).toEqual([])
})
