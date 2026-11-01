// RFC-407: structural locks for the fan-out shard / aggregator assembly lines (RFC-287 L5 / L6) that
// left composition/wrapperMechanics.ts for engine/node/agent-single/. Reads the production owners
// without importing them. Import layering and the TaskMechanicsState ban for every agent-single file
// stay with rfc405-agent-single-executor.test.ts.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const AGENT = TE + 'engine/node/agent-single/'
const SHARD = AGENT + 'runFanoutShard.ts'
const AGGREGATOR = AGENT + 'runFanoutAggregator.ts'
const ATTEMPTS = AGENT + 'fanoutAttempts.ts'
const WRAPPER = TE + 'composition/wrapperMechanics.ts'
const BINDING = TE + 'composition/agentNodeExecution.ts'
/** Every symbol that moved, and its one owner. */
const OWNERS = new Map([
  ['dispatchFanoutShard', SHARD],
  ['dispatchFanoutShardAttempt', SHARD],
  ['DispatchShardArgs', SHARD],
  ['dispatchFanoutAggregator', AGGREGATOR],
  ['dispatchFanoutAggregatorAttempt', AGGREGATOR],
  ['DispatchAggregatorArgs', AGGREGATOR],
  ['createFanoutAttempts', ATTEMPTS],
  // Shared by the wrapper data binding and the agent ports' `resources.sourcePortKind`.
  ['sourcePortKindOf', BINDING],
])
/** The lines' bodies; none of them may come back to the wrapper composition. */
const LINE_FUNCTIONS = [
  'dispatchFanoutShard',
  'dispatchFanoutShardAttempt',
  'dispatchFanoutAggregator',
  'dispatchFanoutAggregatorAttempt',
]
const ARGS = new Map([
  ['DispatchShardArgs', SHARD],
  ['DispatchAggregatorArgs', AGGREGATOR],
])
const WIRING =
  'const fanoutAttempts = createFanoutAttempts(createAgentNodeExecutionPorts(state), executionLog)'
const POOLS = 'pools: [ports.agentSem, ports.subprocessSem],'
const UNITS = backendUnits(ROOT)

// One AST walk per unit, cached by unit identity (the negative fixtures re-run the checks over the
// same live corpus; only replaced or added units are new objects).
interface UnitScan {
  readonly identifiers: ReadonlySet<string>
  readonly declared: ReadonlyMap<string, number>
  /** `ports` member type text of the line argument interfaces declared in this unit. */
  readonly argsPorts: ReadonlyMap<string, string | null>
}
const scans = new WeakMap<SourceUnit, UnitScan>()

function scan(unit: SourceUnit): UnitScan {
  const cached = scans.get(unit)
  if (cached !== undefined) return cached
  const identifiers = new Set<string>()
  const declared = new Map<string, number>()
  const argsPorts = new Map<string, string | null>()
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
    if (ts.isInterfaceDeclaration(node) && ARGS.has(node.name.text)) {
      const ports = node.members.find(
        (member) =>
          ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === 'ports',
      )
      const type = ports !== undefined && ts.isPropertySignature(ports) ? ports.type : undefined
      argsPorts.set(
        node.name.text,
        type === undefined ? null : unit.text.slice(type.pos, type.end).trim(),
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  const result = { identifiers, declared, argsPorts }
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

/**
 * The wrapper composition neither declares nor calls a line body and builds the attempt port from the
 * agent ports; each line takes those ports and declares both node pools on its assembly.
 */
function wiringViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const wrapper = byPath.get(WRAPPER)
  if (wrapper === undefined) found.push('wrapper-missing')
  else {
    const { identifiers } = scan(wrapper)
    for (const name of LINE_FUNCTIONS) if (identifiers.has(name)) found.push('wrapper-line:' + name)
    if (!wrapper.text.includes(WIRING)) found.push('wrapper-wiring')
  }
  for (const [name, path] of ARGS) {
    const unit = byPath.get(path)
    if (unit === undefined) {
      found.push('line-missing:' + path)
      continue
    }
    if (scan(unit).argsPorts.get(name) !== 'AgentNodeExecutionPorts')
      found.push('line-ports:' + name)
    if (unit.text.split(POOLS).length - 1 !== 1) found.push('line-pools:' + path)
  }
  const attempts = byPath.get(ATTEMPTS)?.text ?? ''
  if (
    !/dispatchShard\(input\) \{\s*return dispatchFanoutShard\(\{\s*ports,/.test(attempts) ||
    !/dispatchAggregator\(input\) \{\s*return dispatchFanoutAggregator\(\{\s*ports,/.test(attempts)
  )
    found.push('attempt-port')
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

test('live corpus: both lines and the attempt port live in engine/node/agent-single/ on the agent ports', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of [SHARD, AGGREGATOR, ATTEMPTS, WRAPPER, BINDING])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(wiringViolations(UNITS)).toEqual([])
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

test('negative fixtures: a line body back in the wrapper composition or bypassed wiring is detected', () => {
  for (const name of LINE_FUNCTIONS) {
    const revived = replaceUnit(
      UNITS,
      WRAPPER,
      WIRING,
      `${WIRING}\nasync function ${name}() { return null }`,
    )
    expect(wiringViolations(revived), name).toContain('wrapper-line:' + name)
    const called = replaceUnit(UNITS, WRAPPER, WIRING, `${WIRING}\nvoid ${name}`)
    expect(wiringViolations(called), name).toContain('wrapper-line:' + name)
  }
  expect(
    wiringViolations(
      replaceUnit(UNITS, WRAPPER, WIRING, 'const fanoutAttempts = createFanoutAttempts(state)'),
    ),
  ).toContain('wrapper-wiring')
  // Comments and strings are not identifiers: history notes may keep naming the old functions.
  expect(
    wiringViolations(
      replaceUnit(
        UNITS,
        WRAPPER,
        WIRING,
        `${WIRING}\n// dispatchFanoutShard moved\nvoid 'dispatchFanoutAggregator'`,
      ),
    ),
  ).toEqual([])
})

test('negative fixtures: a line that reads the task state, drops a pool or a port that skips the agent ports is detected', () => {
  for (const [name, path] of ARGS) {
    const stateful = replaceUnit(
      UNITS,
      path,
      'ports: AgentNodeExecutionPorts\n',
      'ports: TaskMechanicsState\n',
    )
    expect(wiringViolations(stateful), name).toContain('line-ports:' + name)
    const onePool = replaceUnit(UNITS, path, POOLS, 'pools: [ports.agentSem],')
    expect(wiringViolations(onePool), path).toContain('line-pools:' + path)
    expect(wiringViolations(UNITS.filter((unit) => unit.path !== path))).toContain(
      'line-missing:' + path,
    )
  }
  for (const [from, to] of [
    [
      'return dispatchFanoutShard({\n        ports,',
      'return dispatchFanoutShard({\n        ports: other,',
    ],
    [
      'return dispatchFanoutAggregator({\n        ports,',
      'return dispatchFanoutAggregator({\n        ports: other,',
    ],
  ])
    expect(wiringViolations(replaceUnit(UNITS, ATTEMPTS, from!, to!))).toContain('attempt-port')
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  // A declaration outside its owner, and nothing else, is a wrong owner for every moved symbol.
  expect(
    ownershipViolations([
      sourceUnit(
        TE + 'composition/wrapperMechanics.ts',
        'export async function dispatchFanoutShard() {}',
      ),
    ]),
  ).toContain('owner:dispatchFanoutShard')
  // A wrapper composition that declares a line body and skips the attempt-port wiring.
  expect(
    wiringViolations([
      sourceUnit(WRAPPER, 'async function dispatchFanoutAggregatorAttempt() { return null }'),
    ]),
  ).toEqual(
    expect.arrayContaining(['wrapper-line:dispatchFanoutAggregatorAttempt', 'wrapper-wiring']),
  )
  // A line whose arguments carry the task state instead of the agent ports and that declares no pools.
  expect(
    wiringViolations([
      sourceUnit(SHARD, 'export interface DispatchShardArgs {\n  ports: TaskMechanicsState\n}\n'),
    ]),
  ).toEqual(expect.arrayContaining(['line-ports:DispatchShardArgs', 'line-pools:' + SHARD]))
})
