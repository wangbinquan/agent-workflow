// RFC-404: structural locks for the call-workflow / call-workgroup executors, their shared body and
// the helpers that left nodeMechanics.ts. Reads the production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const NODE = TE + 'engine/node/'
const SHARED = NODE + 'shared/child-call/'
const MECHANICS = TE + 'composition/nodeMechanics.ts'
const COMPOSITION = TE + 'composition/nodeExecution.ts'
const BODY = SHARED + 'runChildCallNode.ts'
const EXECUTORS = [
  ['call-workflow', 'CallWorkflow'],
  ['call-workgroup', 'CallWorkgroup'],
] as const
const DELETED = [NODE + 'childCallNodeExecutors.ts']
/** Every call-node symbol nodeMechanics.ts used to declare. */
const MOVED_FROM_MECHANICS = [
  'runCallWorkflowNode',
  'failCallRow',
  'parseCallLedger',
  'isShutdownAbort',
  'awaitShutdownAbort',
  'buildChildRuntime',
  'inheritedCallSpace',
  'launchCallChild',
  'renderCallGoal',
  'launchCallWorkgroupChild',
  'delegatedCallActor',
  'parseIsoSubmodules',
  'CALL_CHILD_OBSERVE_MS',
  'SHUTDOWN_CONFIRM_MS',
  'OWNERLESS_LEGACY_ACTOR',
]
const HELPERS = new Map([
  ['parseIsoSubmodules', TE + 'domain/isoSubmodules.ts'],
  ['decodeCallHumanWait', TE + 'domain/resourceLimitUsage.ts'],
  ['encodeCallHumanWait', TE + 'domain/resourceLimitUsage.ts'],
  ['childLaunchFailureCode', TE + 'application/childCallErrors.ts'],
  ['isToleratedChildCancelRace', TE + 'application/childCallErrors.ts'],
  ['childCallRefusal', TE + 'application/childCallErrors.ts'],
  ['runChildCallNode', BODY],
  ['inheritedCallSpace', SHARED + 'launchChildCall.ts'],
  // RFC-420: the child runtime and the delegated owner actor left the binding for application/.
  ['buildChildRuntime', TE + 'application/childCallInheritance.ts'],
  ['delegatedCallActor', TE + 'application/childCallInheritance.ts'],
])
const UNITS = backendUnits(ROOT)
const LEAF_DIRECTORIES = [SHARED, ...EXECUTORS.map(([key]) => NODE + key + '/')]
const isCallLeaf = (path: string) => LEAF_DIRECTORIES.some((prefix) => path.startsWith(prefix))

function boundaryViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) violations.push('deleted-file:' + unit.path)
    if (
      isCallLeaf(unit.path) &&
      /\b(?:legacyArgs|TaskMechanicsState|SchedulerState|OneNodeArgs)\b/.test(unit.text)
    )
      violations.push('leaf-bag:' + unit.path)
    if (
      unit.path === MECHANICS &&
      MOVED_FROM_MECHANICS.some((name) => new RegExp(`\\b${name}\\b`).test(unit.text))
    )
      violations.push('legacy-body:' + unit.path)
  }
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      violations.push('deleted-reference:' + edge.from.path)
    if (!isCallLeaf(edge.from.path)) continue
    const ownDirectory = edge.from.path.slice(0, edge.from.path.lastIndexOf('/') + 1)
    if (
      ![
        TE + 'domain/',
        TE + 'application/',
        TE + 'engine/kernel/',
        NODE + 'shared/',
        ownDirectory,
        PREFIX + 'platform/contracts/',
      ].some((prefix) => target.startsWith(prefix)) &&
      target !== NODE + 'nodeExecutor.ts' &&
      target !== NODE + 'nodeExecutor' &&
      target !== '@agent-workflow/shared' &&
      !target.startsWith('packages/shared/src/') &&
      !target.startsWith('node:')
    )
      violations.push('leaf-import:' + edge.from.path + ' -> ' + target)
  }
  return violations.sort()
}

// One AST walk per unit, cached by unit identity: the negative fixtures re-run the owner check over
// the same live corpus many times, and only the replaced or added units are new objects (RFC-403's
// structure lock exceeded bun's 5 s default on the Windows runner without this).
interface HelperScan {
  readonly declared: ReadonlyMap<string, number>
  readonly reexported: ReadonlyMap<string, number>
}
const helperScans = new WeakMap<SourceUnit, HelperScan>()

function scanHelpers(unit: SourceUnit): HelperScan {
  const cached = helperScans.get(unit)
  if (cached !== undefined) return cached
  const declared = new Map<string, number>()
  const reexported = new Map<string, number>()
  const bump = (counts: Map<string, number>, name: string) =>
    counts.set(name, (counts.get(name) ?? 0) + 1)
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      HELPERS.has(node.name.text)
    )
      bump(declared, node.name.text)
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const elements = node.exportClause.elements
      for (const name of HELPERS.keys())
        if (elements.some((entry) => entry.name.text === name || entry.propertyName?.text === name))
          bump(reexported, name)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  const scan = { declared, reexported }
  helperScans.set(unit, scan)
  return scan
}

function executorPath(key: string, stem: string): string {
  return NODE + key + '/' + stem[0]!.toLowerCase() + stem.slice(1) + 'NodeExecutor.ts'
}

function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const composition = (byPath.get(COMPOSITION)?.text ?? '')
    .replace(/\s+/g, '')
    .replace(/,(?=\))/g, '')
  for (const [key, stem] of EXECUTORS) {
    const executor = byPath.get(executorPath(key, stem))
    if (
      executor === undefined ||
      !executor.text.includes(`class ${stem}NodeExecutor implements NodeExecutor<'${key}'>`) ||
      !executor.text.includes(
        `execute(request: NodeStepRequest<'${key}'>): Promise<NodeStepOutcome>`,
      ) ||
      !executor.text.includes('return runChildCallNode(this.ports, request)')
    )
      violations.push('executor-owner:' + key)
    if (!composition.includes(`new${stem}NodeExecutor(createChildCallNodeExecutionPorts(state))`))
      violations.push('explicit-binding:' + key)
  }
  if (!byPath.get(BODY)?.text.includes('export async function runChildCallNode('))
    violations.push('body-owner')
  const found = new Map<string, string[]>([...HELPERS.keys()].map((name) => [name, []]))
  for (const unit of units) {
    if (!unit.path.startsWith(TE)) continue
    const scan = scanHelpers(unit)
    for (const [name, count] of scan.declared)
      for (let index = 0; index < count; index += 1) found.get(name)!.push(unit.path)
    for (const [name, count] of scan.reexported)
      for (let index = 0; index < count; index += 1) violations.push('helper-reexport:' + name)
  }
  for (const [name, owner] of HELPERS) {
    const owners = found.get(name)!
    if (owners.length !== 1 || owners[0] !== owner) violations.push('helper-owner:' + name)
  }
  return violations.sort()
}

function replaceUnit(units: readonly SourceUnit[], path: string, from: string, to: string) {
  const original = units.find((unit) => unit.path === path)
  if (original === undefined || !original.text.includes(from))
    throw new Error('fixture anchor missing: ' + path + ':' + from)
  return units.map((unit) =>
    unit.path === path ? sourceUnit(path, unit.text.replace(from, to)) : unit,
  )
}

test('live corpus: both executors run the shared body through explicit ports, helpers have one owner', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(UNITS.filter((unit) => isCallLeaf(unit.path)).length).toBeGreaterThanOrEqual(5)
  expect(boundaryViolations(UNITS)).toEqual([])
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: every call leaf rejects nested bags and imports outside the permitted layers', () => {
  for (const directory of LEAF_DIRECTORIES) {
    const file = directory + 'nested/bad.ts'
    for (const name of ['legacyArgs', 'TaskMechanicsState', 'SchedulerState', 'OneNodeArgs'])
      expect(boundaryViolations([sourceUnit(file, `const x: ${name} = input`)])).toContain(
        'leaf-bag:' + file,
      )
    for (const target of [
      '@/services/execution/childBudget',
      '@/modules/task-execution/composition/x',
      '@/modules/task-execution/infrastructure/legacyCallClosure',
      '@/modules/task-execution/public/commands',
      '@/modules/identity-access/public/participants',
      '@/util/errors',
      '@/auth/actor',
      'ulid',
    ])
      for (const text of [
        `import type { X } from '${target}'`,
        `export * from '${target}'`,
        `const module = import('${target}')`,
      ])
        expect(
          boundaryViolations([sourceUnit(file, text)]).some((item) =>
            item.startsWith('leaf-import:'),
          ),
          `${file}: ${text}`,
        ).toBe(true)
  }
})

test('negative fixtures: the deleted shell, references to it and every moved symbol in nodeMechanics are rejected', () => {
  for (const path of DELETED) {
    expect(boundaryViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
    const target = '@/' + path.slice(PREFIX.length).replace(/\.ts$/, '')
    for (const text of [
      `import { X } from '${target}'`,
      `export * from '${target}'`,
      `const shell = import('${target}')`,
    ])
      expect(boundaryViolations([sourceUnit(COMPOSITION, text)])).toContain(
        'deleted-reference:' + COMPOSITION,
      )
  }
  for (const name of MOVED_FROM_MECHANICS)
    expect(boundaryViolations([sourceUnit(MECHANICS, `export function ${name}() {}`)])).toContain(
      'legacy-body:' + MECHANICS,
    )
})

test('negative fixtures: a missing executor, body or explicit binding is detected', () => {
  for (const [key, stem] of EXECUTORS) {
    const executor = executorPath(key, stem)
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== executor))).toContain(
      'executor-owner:' + key,
    )
    for (const [from, to] of [
      [`implements NodeExecutor<'${key}'>`, 'implements LegacyExecutor'],
      [`execute(request: NodeStepRequest<'${key}'>)`, 'execute(request: LegacyRequest)'],
      ['return runChildCallNode(this.ports, request)', 'return this.port.execute(request)'],
    ])
      expect(ownershipViolations(replaceUnit(UNITS, executor, from!, to!))).toContain(
        'executor-owner:' + key,
      )
    expect(
      ownershipViolations(
        replaceUnit(
          UNITS,
          COMPOSITION,
          `new ${stem}NodeExecutor(createChildCallNodeExecutionPorts(state))`,
          `new ${stem}NodeExecutor(childCalls)`,
        ),
      ),
    ).toContain('explicit-binding:' + key)
  }
  expect(ownershipViolations(UNITS.filter((unit) => unit.path !== BODY))).toContain('body-owner')
})

test('negative fixtures: each moved helper rejects missing, duplicate and wrong owners and re-exports', () => {
  for (const [name, owner] of HELPERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'helper-owner:' + name,
    )
    const extra = sourceUnit(TE + 'application/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('helper-owner:' + name)
    expect(ownershipViolations([...UNITS.filter((unit) => unit.path !== owner), extra])).toContain(
      'helper-owner:' + name,
    )
    expect(
      ownershipViolations([
        ...UNITS,
        sourceUnit(TE + 'application/shim.ts', `export { ${name} } from './owner'`),
      ]),
    ).toContain('helper-reexport:' + name)
  }
})
