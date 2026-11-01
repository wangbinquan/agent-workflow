// RFC-406: structural locks for the workgroup host lane of the agent-single executor and the deletion of
// composition/nodeMechanics.ts. Reads the production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const AGENT = TE + 'engine/node/agent-single/'
const HOST = AGENT + 'runWorkgroupHost.ts'
const EXECUTOR = AGENT + 'agentSingleNodeExecutor.ts'
const COMPOSITION = TE + 'composition/nodeExecution.ts'
const DELETED = [TE + 'composition/nodeMechanics.ts']
/** Names that only existed for the composition-owned host lane; none may come back. */
const RETIRED = [
  'executeWorkgroupHostMechanics',
  'buildWorkgroupEngineSupport',
  'legacyHostPort',
  'SchedulerState',
  'OneNodeResult',
]
const OWNERS = new Map([
  ['runWorkgroupHost', HOST],
  ['workgroupEngineSupport', COMPOSITION],
])
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

/** Deleted file recreated, or a retired name used as an identifier in production source. */
function nameViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    // The retired names were task-execution's own (legacy services may keep unrelated local aliases).
    if (!unit.path.startsWith(TE)) continue
    const { identifiers } = scan(unit)
    for (const name of RETIRED)
      if (identifiers.has(name)) found.push('retired-name:' + name + ':' + unit.path)
  }
  return found.sort()
}

/** Any import / re-export / dynamic import of the deleted file. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges)
    if (DELETED.some((path) => edge.target === path || edge.target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + edge.from.path)
  return found.sort()
}

/** Both executor lanes run their own bodies on the ports; each moved function has one owner. */
function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const executor = byPath.get(EXECUTOR)?.text ?? ''
  if (
    !executor.includes('constructor(private readonly ports: AgentNodeExecutionPorts) {}') ||
    !executor.includes('return runAgentSingleNode(this.ports, request)') ||
    !executor.includes('return runWorkgroupHost(this.ports, request)') ||
    executor.includes('WorkgroupHostExecutionPort')
  )
    found.push('executor-lanes')
  if (!byPath.get(HOST)?.text.includes('export async function runWorkgroupHost('))
    found.push('host-owner')
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

function replaceUnit(units: readonly SourceUnit[], path: string, from: string, to: string) {
  const original = units.find((unit) => unit.path === path)
  if (original === undefined || !original.text.includes(from))
    throw new Error('fixture anchor missing: ' + path + ':' + from)
  return units.map((unit) =>
    unit.path === path ? sourceUnit(path, unit.text.replace(from, to)) : unit,
  )
}

test('live corpus: nodeMechanics.ts is gone, both lanes run on the ports, retired names are extinct', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(UNITS.some((unit) => unit.path === HOST)).toBe(true)
  expect(nameViolations(UNITS)).toEqual([])
  expect(importViolations(UNITS)).toEqual([])
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: recreating nodeMechanics.ts or importing it is rejected', () => {
  for (const path of DELETED) {
    expect(nameViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
    const target = '@/' + path.slice(PREFIX.length).replace(/\.ts$/, '')
    for (const text of [
      `import { X } from '${target}'`,
      `export * from '${target}'`,
      `const shell = import('${target}')`,
    ]) {
      const file = TE + 'composition/revived.ts'
      expect(importViolations([sourceUnit(file, text)])).toContain('deleted-reference:' + file)
    }
  }
})

test('negative fixtures: every retired name is rejected wherever it reappears in task-execution source', () => {
  for (const name of RETIRED)
    for (const text of [
      `export function ${name}() {}`,
      `export type ${name} = unknown`,
      `const lane = ${name}`,
    ]) {
      const file = TE + 'composition/revived.ts'
      expect(nameViolations([sourceUnit(file, text)]), `${name}: ${text}`).toContain(
        'retired-name:' + name + ':' + file,
      )
    }
  // Comments and strings are not identifiers: history notes may keep naming the old file.
  expect(
    nameViolations([
      sourceUnit(TE + 'composition/history.ts', "// legacyHostPort\nconst s = 'SchedulerState'"),
    ]),
  ).toEqual([])
})

test('negative fixtures: a host port on the executor, a missing lane or a missing owner is detected', () => {
  for (const [from, to] of [
    ['return runWorkgroupHost(this.ports, request)', 'return this.host.executeHost(request)'],
    ['return runAgentSingleNode(this.ports, request)', 'return this.dag.executeAgent(request)'],
    [
      'constructor(private readonly ports: AgentNodeExecutionPorts) {}',
      'constructor(private readonly ports: AgentNodeExecutionPorts, private readonly host: WorkgroupHostExecutionPort) {}',
    ],
  ])
    expect(ownershipViolations(replaceUnit(UNITS, EXECUTOR, from!, to!))).toContain(
      'executor-lanes',
    )
  expect(ownershipViolations(UNITS.filter((unit) => unit.path !== HOST))).toContain('host-owner')
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const extra = sourceUnit(TE + 'application/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
})
