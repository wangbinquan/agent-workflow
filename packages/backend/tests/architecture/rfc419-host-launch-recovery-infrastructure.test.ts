// RFC-419: the host task launch adapters (digital employee and action), the borrowed workspace participant and the
// recovery administration face are task-execution infrastructure; the three composition files only construct and
// inject. Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const HOST_LAUNCH = TE + 'infrastructure/hostTaskLaunch.ts'
const RECOVERY = TE + 'infrastructure/taskRecoveryAdministration.ts'
const ACTION_ENVIRONMENT = TE + 'composition/actionExecutionEnvironment.ts'
const DIGITAL_EMPLOYEE = TE + 'composition/digitalEmployeeExecution.ts'
const PERSISTENCE = TE + 'composition/taskExecutionPersistence.ts'
const INFRASTRUCTURE_FILES = [HOST_LAUNCH, RECOVERY]
const BINDINGS = [ACTION_ENVIRONMENT, DIGITAL_EMPLOYEE, PERSISTENCE]
/** Every moved symbol (and the binding symbols that stay) and its one owner. */
const OWNERS = new Map([
  ['borrowedPostgresqlWorkspace', HOST_LAUNCH],
  ['launchActionHostTask', HOST_LAUNCH],
  ['launchDigitalEmployeeHost', HOST_LAUNCH],
  ['HostTaskLaunchDependencies', HOST_LAUNCH],
  ['createTaskRecoveryAdministration', RECOVERY],
  ['createActionExecutionEnvironment', ACTION_ENVIRONMENT],
  ['composeDigitalEmployeeExecutionCore', DIGITAL_EMPLOYEE],
  ['createTaskExecutionPersistence', PERSISTENCE],
])
/** Launch request, borrowed workspace and recovery steps the three bindings no longer contain. */
const ADAPTER_TOKENS = [
  "catalogVisibility: 'internal'",
  "invoker: { type: 'user'",
  'borrowed-workspace-already-',
  'admitTransferredWorkspace(',
  'interruptBootOrphanTask',
  "reason: 'reapOrphanRuns'",
  "reason: 'reconcileDeadRunningRuns'",
  'repairRuntimeSessionLeasesAfterOrphanReap(',
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

/** A launch, borrowed workspace or recovery step written in one of the three bindings. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units)
    if (BINDINGS.includes(unit.path))
      for (const token of ADAPTER_TOKENS)
        if (unit.text.includes(token)) found.push('binding-adapter:' + unit.path + ' ' + token)
  return found.sort()
}

/** The new infrastructure files import no composition, except the consumer-owned required-ports types. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    if (!INFRASTRUCTURE_FILES.includes(from)) continue
    if (!/\/modules\/[^/]+\/composition(?:\/|\.|$)/.test(edge.target)) continue
    if (edge.kind === 'type' && /\/composition\/required-ports(?:\.ts)?$/.test(edge.target))
      continue
    found.push('composition-import:' + from + ' -> ' + edge.target)
  }
  return found.sort()
}

test('live corpus: launch adapters, borrowed workspace and recovery administration are infrastructure', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
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
  for (const binding of BINDINGS)
    for (const token of ADAPTER_TOKENS)
      expect(
        shapeViolations([sourceUnit(binding, `const x = ${JSON.stringify(token)}`)]),
      ).toContain('binding-adapter:' + binding + ' ' + token)
  expect(shapeViolations([sourceUnit(HOST_LAUNCH, "catalogVisibility: 'internal'")])).toEqual([])
  for (const from of INFRASTRUCTURE_FILES)
    expect(
      importViolations([
        sourceUnit(from, "import { x } from '../composition/actionExecutionEnvironment'"),
      ]).some((v) => v.startsWith('composition-import:' + from + ' -> ')),
      from,
    ).toBe(true)
  expect(
    importViolations([
      sourceUnit(
        RECOVERY,
        "import type { TaskRecoveryHumanGateFactsPort } from '../composition/required-ports'",
      ),
    ]),
  ).toEqual([])
  expect(
    importViolations([
      sourceUnit(RECOVERY, "import { TASK_RECOVERY_SPI } from '../composition/required-ports'"),
    ]).some((v) => v.startsWith('composition-import:')),
  ).toBe(true)
})
