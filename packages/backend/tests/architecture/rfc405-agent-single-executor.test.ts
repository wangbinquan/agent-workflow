// RFC-405: structural locks for the agent-single executor, its body and the helpers that left
// nodeMechanics.ts. Reads the production owners without importing them.
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
const AGENT = NODE + 'agent-single/'
const MECHANICS = TE + 'composition/nodeMechanics.ts'
const COMPOSITION = TE + 'composition/nodeExecution.ts'
const BINDING = TE + 'composition/agentNodeExecution.ts'
const PORT = TE + 'application/ports/agentNodeExecution.ts'
const BODY = AGENT + 'runAgentSingleNode.ts'
const EXECUTOR = AGENT + 'agentSingleNodeExecutor.ts'
const DELETED = [NODE + 'agentNodeExecutor.ts']
/**
 * Every agent-path symbol nodeMechanics.ts used to declare. `priorDoneGenerationsForRun` is not
 * listed: the workgroup host still calls it (imported from its owner).
 */
const MOVED_FROM_MECHANICS = [
  'runAgentSingleNode',
  'PreviousAttemptShape',
  'EnvelopeFollowupDecision',
  'FRAMEWORK_AUDIT_EVENT_PREFIX',
  'decideEnvelopeFollowup',
  'shouldRetryNodeFailure',
  'countAgentTextEvents',
  'composePriorOutputBlock',
  'freshestPriorRunWithOutput',
  'lineageCausesNewestFirst',
  'readPriorAgentSessionId',
  'readStderrText',
  'recordClarifyInlineEvent',
  'Binding',
  'readBindings',
  'OneNodeArgs',
  'legacyArgs',
]
const POLICY = TE + 'domain/envelopeRetryPolicy.ts'
const HISTORY = TE + 'application/agentRunHistory.ts'
const HELPERS = new Map([
  ['PreviousAttemptShape', POLICY],
  ['EnvelopeFollowupDecision', POLICY],
  ['FRAMEWORK_AUDIT_EVENT_PREFIX', POLICY],
  ['decideEnvelopeFollowup', POLICY],
  ['shouldRetryNodeFailure', POLICY],
  ['countAgentTextEvents', HISTORY],
  ['composePriorOutputBlock', HISTORY],
  ['freshestPriorRunWithOutput', HISTORY],
  ['lineageCausesNewestFirst', HISTORY],
  ['priorDoneGenerationsForRun', HISTORY],
  ['readPriorAgentSessionId', HISTORY],
  ['readStderrText', HISTORY],
  ['recordClarifyInlineEvent', HISTORY],
  ['borrowDuplicateExecutionRejection', TE + 'application/agentNodeErrors.ts'],
  ['runAgentSingleNode', BODY],
  ['AgentNodeExecutionPorts', PORT],
  ['createAgentNodeExecutionPorts', BINDING],
  // The dispatch arguments moved with their last consumer, `executeNode`.
  ['OneNodeArgs', COMPOSITION],
])
/**
 * Task-execution-owned contracts the move created: they declare what the body needs and may not lean
 * on the legacy layer or on collaboration (the binding hands those implementations in).
 */
const OWNED_CONTRACTS = [PORT, HISTORY]
const UNITS = backendUnits(ROOT)
const isAgentLeaf = (path: string) => path.startsWith(AGENT)

function boundaryViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) violations.push('deleted-file:' + unit.path)
    if (
      isAgentLeaf(unit.path) &&
      /\b(?:legacyArgs|TaskMechanicsState|SchedulerState|OneNodeArgs)\b/.test(unit.text)
    )
      violations.push('leaf-bag:' + unit.path)
    if (
      unit.path === MECHANICS &&
      MOVED_FROM_MECHANICS.some((name) => new RegExp(`\\b${name}\\b`).test(unit.text))
    )
      violations.push('legacy-body:' + unit.path)
    if (unit.path === COMPOSITION && /\blegacyArgs\b|\brunAgentSingleNode\(/.test(unit.text))
      violations.push('legacy-adapter:' + unit.path)
  }
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      violations.push('deleted-reference:' + edge.from.path)
    if (
      OWNED_CONTRACTS.includes(edge.from.path) &&
      (target.startsWith(PREFIX + 'services/') ||
        target.startsWith(PREFIX + 'modules/collaboration/'))
    )
      violations.push('contract-import:' + edge.from.path + ' -> ' + target)
    if (!isAgentLeaf(edge.from.path)) continue
    if (
      ![
        TE + 'domain/',
        TE + 'application/',
        TE + 'engine/kernel/',
        NODE + 'shared/',
        AGENT,
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

// One AST walk per unit, cached by unit identity (the negative fixtures re-run the owner check over
// the same live corpus many times; only replaced or added units are new objects).
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

const EXECUTOR_ANCHORS = [
  'class AgentSingleNodeExecutor implements AgentNodeExecutor',
  "execute(request: NodeStepRequest<'agent-single'>): Promise<NodeStepOutcome>",
  'return runAgentSingleNode(this.ports, request)',
  // RFC-406: the workgroup host lane runs its own body on the same ports.
  'executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult>',
  'return runWorkgroupHost(this.ports, request)',
] as const

function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const executor = byPath.get(EXECUTOR)
  if (executor === undefined || EXECUTOR_ANCHORS.some((anchor) => !executor.text.includes(anchor)))
    violations.push('executor-owner')
  const composition = (byPath.get(COMPOSITION)?.text ?? '')
    .replace(/\s+/g, '')
    .replace(/,(?=\))/g, '')
  if (
    !composition.includes(
      "'agent-single':newAgentSingleNodeExecutor(createAgentNodeExecutionPorts(state))",
    )
  )
    violations.push('explicit-binding')
  if (!byPath.get(BODY)?.text.includes('export async function runAgentSingleNode('))
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

test('live corpus: the executor runs its own body through explicit ports, helpers have one owner', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(UNITS.filter((unit) => isAgentLeaf(unit.path)).map((unit) => unit.path)).toEqual(
    expect.arrayContaining([BODY, EXECUTOR]),
  )
  expect(boundaryViolations(UNITS)).toEqual([])
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: the agent leaf rejects nested bags and imports outside the permitted layers', () => {
  const file = AGENT + 'nested/bad.ts'
  for (const name of ['legacyArgs', 'TaskMechanicsState', 'SchedulerState', 'OneNodeArgs'])
    expect(boundaryViolations([sourceUnit(file, `const x: ${name} = input`)])).toContain(
      'leaf-bag:' + file,
    )
  for (const target of [
    '@/services/clarifyRounds',
    '@/services/nodeRunMint',
    '@/modules/task-execution/composition/agentNodeExecution',
    '@/modules/task-execution/infrastructure/nodeStatusEvents',
    '@/modules/task-execution/public/queries',
    '@/modules/collaboration/public/participants',
    '@/util/errors',
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
})

test('negative fixtures: the port and the run-history reads reject legacy services and collaboration imports', () => {
  for (const file of OWNED_CONTRACTS)
    for (const target of [
      '@/services/clarifyRounds',
      '@/services/sessionModeFallback',
      '@/services/execution/triggerPreflight',
      '@/modules/collaboration/public/participants',
    ])
      for (const text of [`import type { X } from '${target}'`, `export * from '${target}'`])
        expect(
          boundaryViolations([sourceUnit(file, text)]).some((item) =>
            item.startsWith('contract-import:' + file),
          ),
          `${file}: ${text}`,
        ).toBe(true)
})

test('negative fixtures: the deleted shell, references to it, the legacy adapter and every moved symbol in nodeMechanics are rejected', () => {
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
  for (const text of [
    'function legacyArgs(state, request) {}',
    'return runAgentSingleNode(state, args, mechanics)',
  ])
    expect(boundaryViolations([sourceUnit(COMPOSITION, text)])).toContain(
      'legacy-adapter:' + COMPOSITION,
    )
})

test('negative fixtures: a missing executor, body or explicit binding is detected', () => {
  expect(ownershipViolations(UNITS.filter((unit) => unit.path !== EXECUTOR))).toContain(
    'executor-owner',
  )
  for (const [from, to] of [
    ['implements AgentNodeExecutor', 'implements LegacyExecutor'],
    ["execute(request: NodeStepRequest<'agent-single'>)", 'execute(request: LegacyRequest)'],
    ['return runAgentSingleNode(this.ports, request)', 'return this.port.execute(request)'],
    ['return runWorkgroupHost(this.ports, request)', 'return this.host.executeHost(request)'],
  ])
    expect(ownershipViolations(replaceUnit(UNITS, EXECUTOR, from!, to!))).toContain(
      'executor-owner',
    )
  expect(
    ownershipViolations(
      replaceUnit(UNITS, COMPOSITION, 'createAgentNodeExecutionPorts(state)', 'agents'),
    ),
  ).toContain('explicit-binding')
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
