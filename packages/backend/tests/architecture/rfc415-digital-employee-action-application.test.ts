// RFC-415: the digital employee Reaction execution core and the digital employee action executors are task-execution
// application on their own ports; composition only binds the provider (the root launch kernel behind `launchHost`, the
// action environment's status read and entry check). Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const CORE = TE + 'application/digitalEmployeeExecution.ts'
const CORE_PORTS = TE + 'application/ports/digitalEmployeeExecution.ts'
const RUNNERS = TE + 'application/actionExecutionRunners.ts'
const RUNNER_PORTS = TE + 'application/ports/actionExecution.ts'
const APPLICATION_FILES = [CORE, CORE_PORTS, RUNNERS, RUNNER_PORTS]
const DELETED = [TE + 'composition/actionExecutionRunners.ts']
/** Every moved symbol (and the new port / binding symbols) and its one owner. */
const OWNERS = new Map([
  ['createDigitalEmployeeExecutionCore', CORE],
  ['buildDigitalEmployeeFixedPrompt', CORE],
  ['buildDigitalEmployeePlanPrompt', CORE],
  ['digitalEmployeeExecutionIsLive', CORE],
  ['parsedPlanOutputPath', CORE],
  ['resultFailure', CORE],
  ['programSourceFailure', CORE],
  ['DigitalEmployeeHostLaunch', CORE_PORTS],
  ['DigitalEmployeeExecutionPorts', CORE_PORTS],
  ['createAgentActionExecutionRunner', RUNNERS],
  ['createScriptActionExecutionRunner', RUNNERS],
  ['assertWorkspace', RUNNERS],
  ['parseScriptRef', RUNNERS],
  ['watchTerminal', RUNNERS],
  ['ActionExecutionEnvironment', RUNNER_PORTS],
  ['ActionHostTaskLaunch', RUNNER_PORTS],
  ['ActionWorkspaceEntries', RUNNER_PORTS],
  ['AgentExecutionFailure', RUNNER_PORTS],
  // RFC-419: the launch request mapping moved to the infrastructure host launch adapter.
  ['launchDigitalEmployeeHost', TE + 'infrastructure/hostTaskLaunch.ts'],
])
/** Steps of the two executors that may not reappear in task-execution composition. */
const FLOW_TOKENS = [
  'planSchema',
  'attemptSchema',
  'synthesizeDigitalEmployeeHostSnapshot(',
  'synthesizeDigitalEmployeeScriptHostSnapshot(',
  'synthesizeReviewedDigitalEmployeeHostSnapshot(',
  'buildExecutionContractAgentPrompt(',
  'parseScriptRef(',
  'assertWorkspace(',
]
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
  const owners = new Map<string, string[]>()
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    for (const [name, count] of declared(unit))
      for (let index = 0; index < count; index += 1)
        owners.set(name, [...(owners.get(name) ?? []), unit.path])
  }
  const found: string[] = []
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name) ?? []
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

/** A deleted file back, or an executor step written in task-execution composition. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (unit.path.startsWith(TE + 'composition/'))
      for (const token of FLOW_TOKENS)
        if (unit.text.includes(token)) found.push('composition-flow:' + unit.path + ' ' + token)
  }
  return found.sort()
}

/** The application files import neither infrastructure nor composition (the required-ports types excepted). */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    if (!APPLICATION_FILES.includes(from)) continue
    const layer = /\/modules\/[^/]+\/(infrastructure|composition)(?:\/|\.|$)/.exec(target)?.[1]
    if (layer === undefined) continue
    if (
      layer === 'composition' &&
      edge.kind === 'type' &&
      /\/composition\/required-ports(?:\.ts)?$/.test(target)
    )
      continue
    found.push(`${layer}-import:` + from + ' -> ' + target)
  }
  return found.sort()
}

test('live corpus: both executors are task-execution application on their ports; composition binds', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of new Set(OWNERS.values()))
    expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(shapeViolations(UNITS)).toEqual([])
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
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  const composition = TE + 'composition/revived.ts'
  for (const token of FLOW_TOKENS)
    expect(shapeViolations([sourceUnit(composition, `const x = ${token}`)])).toContain(
      'composition-flow:' + composition + ' ' + token,
    )
  expect(
    shapeViolations([sourceUnit(TE + 'application/revived.ts', 'const x = planSchema')]),
  ).toEqual([])
  for (const from of APPLICATION_FILES) {
    const up = from.includes('/application/ports/') ? '../../' : '../'
    for (const target of [
      up + 'infrastructure/taskExecutionTaskReads',
      up + 'infrastructure/local/fileProgramToolSource',
      up + 'composition/actionExecutionEnvironment',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
          /^(?:infrastructure|composition)-import:/.test(v),
        ),
        `${from} -> ${target}`,
      ).toBe(true)
  }
  expect(
    importViolations([
      sourceUnit(
        CORE_PORTS,
        "import type { DigitalEmployeeWorkspacePort } from '../../composition/required-ports'",
      ),
    ]),
  ).toEqual([])
  const file = TE + 'composition/revived.ts'
  expect(
    importViolations([sourceUnit(file, "import { x } from './actionExecutionRunners'")]),
  ).toContain('deleted-reference:' + file)
})
