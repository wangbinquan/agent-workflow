// RFC-423: task-execution composition only assembles. The schedule launch / trigger participant, the hosted recovery
// selection and the preparation GC routing left for infrastructure, and this lock pins the composition's assembly
// shape: no loop and no switch, a try only in the drive entry (it reclaims the task-scoped permit registrations), and
// an exact ledger of the files that throw (mostly the injected receivers' completeness checks).
// New logic written into composition changes these facts and fails here. Reads the production sources without
// importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const COMPOSITION = TE + 'composition/'
const TRIGGER = TE + 'infrastructure/taskExecutionTrigger.ts'
const RECOVERY_SELECTION = TE + 'infrastructure/taskRecoverySelection.ts'
const HOSTED_RECOVERY = TE + 'infrastructure/crewstation/hostedRecoverySelection.ts'
const PREPARATION_GC = TE + 'infrastructure/workspacePreparationGc.ts'
/**
 * Composition files that throw, and how often. RFC-510 moved the injected receivers' completeness checks (TypeError) to
 * application; RFC-514 moved the last three (the local configuration bridge's unknown-reference check, the
 * dynamic-workflow operations guard and the digital employee's task-not-found mapping) to application, and the drive's
 * try / finally to engine/task/driveTaskRun.ts, so the ledger is empty and composition has no try. Changing a count means
 * changing composition's assembly shape: update the ledger with the reason.
 */
const THROW_LEDGER: Readonly<Record<string, number>> = {}
/** Every moved symbol (and the composition entries that stay for bootstrap) and its one owner. */
const OWNERS = new Map([
  ['createTaskExecutionTriggerParticipant', TRIGGER],
  ['createBuildScheduleLaunch', TRIGGER],
  ['TaskExecutionTriggerParticipant', TRIGGER],
  ['TaskRecoveryDeploymentSelection', RECOVERY_SELECTION],
  ['TaskRecoveryProviderSelection', RECOVERY_SELECTION],
  ['createHostedRecoverySelection', HOSTED_RECOVERY],
  ['createWorkspacePreparationMaintenance', PREPARATION_GC],
  ['createWorkerWorkspaceMaintenance', PREPARATION_GC],
  ['composeCrewStationRecovery', COMPOSITION + 'crewstationRecovery.ts'],
  ['composeWorkspacePreparationMaintenance', COMPOSITION + 'workspacePreparationMaintenance.ts'],
  ['createWorkerWorkspaceMaintenanceCommand', COMPOSITION + 'workspacePreparationMaintenance.ts'],
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

interface CompositionShape {
  readonly loops: string[]
  readonly tries: string[]
  readonly throws: Map<string, number>
}

/** Loops / switches and try owners of every composition file, and the files that throw. */
function compositionShape(units: readonly SourceUnit[]): CompositionShape {
  const loops: string[] = []
  const tries: string[] = []
  const throws = new Map<string, number>()
  for (const unit of units) {
    if (!unit.path.startsWith(COMPOSITION)) continue
    const visit = (node: ts.Node, owner: string) => {
      let current = owner
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name !== undefined
      )
        current = node.name.getText(unit.source)
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        current = node.name.getText(unit.source)
      if (
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isSwitchStatement(node)
      )
        loops.push(unit.path + '#' + current)
      if (ts.isTryStatement(node)) tries.push(unit.path + '#' + current)
      if (ts.isThrowStatement(node)) throws.set(unit.path, (throws.get(unit.path) ?? 0) + 1)
      ts.forEachChild(node, (child) => visit(child, current))
    }
    visit(unit.source, 'module')
  }
  return { loops: loops.sort(), tries: tries.sort(), throws }
}

function shapeViolations(units: readonly SourceUnit[]): string[] {
  const shape = compositionShape(units)
  const found = [
    ...shape.loops.map((site) => 'composition-loop:' + site),
    ...shape.tries.map((site) => 'composition-try:' + site),
  ]
  const files = new Set([...Object.keys(THROW_LEDGER), ...shape.throws.keys()])
  for (const file of files) {
    const expected = THROW_LEDGER[file] ?? 0
    const actual = shape.throws.get(file) ?? 0
    if (actual !== expected) found.push(`composition-throw:${file} ${actual} (ledger ${expected})`)
  }
  return found.sort()
}

test('live corpus: composition only assembles, and the moved logic has one infrastructure owner', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(UNITS.filter((unit) => unit.path.startsWith(COMPOSITION)).length).toBeGreaterThanOrEqual(
    90,
  )
  for (const path of new Set(OWNERS.values()))
    expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  expect(existsSync(resolve(ROOT, COMPOSITION + 'triggerExecution.ts'))).toBe(false)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(shapeViolations(UNITS)).toEqual([])
  expect(compositionShape(UNITS).tries).toEqual([])
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

test('negative fixtures: a loop, a switch, an unregistered try or throw in composition is reported', () => {
  const path = COMPOSITION + 'fabricated.ts'
  for (const [body, error] of [
    [
      'export function f(xs: number[]) { for (const x of xs) void x }',
      'composition-loop:' + path + '#f',
    ],
    ['export function f() { while (Math.random() > 2) break }', 'composition-loop:' + path + '#f'],
    [
      'export function f(k: string) { switch (k) { default: return k } }',
      'composition-loop:' + path + '#f',
    ],
    [
      'export const f = () => { try { return 1 } finally { void 0 } }',
      'composition-try:' + path + '#f',
    ],
    [
      'export function f() { throw new Error("logic") }',
      'composition-throw:' + path + ' 1 (ledger 0)',
    ],
  ] as const)
    expect(shapeViolations([sourceUnit(path, body)]), body).toContain(error)
  // RFC-514: the files that left the ledger count from zero again, and the drive entry is no longer exempt from try.
  const formerlyLedgered = COMPOSITION + 'localTaskRunSelection.ts'
  expect(
    shapeViolations([
      sourceUnit(
        formerlyLedgered,
        'export function f() { throw new TypeError("x"); throw new Error("y") }',
      ),
    ]),
  ).toContain(`composition-throw:${formerlyLedgered} 2 (ledger 0)`)
  const driveEntry = COMPOSITION + 'taskEngineApplication.ts'
  expect(
    shapeViolations([
      sourceUnit(
        driveEntry,
        'export async function driveTaskEngineApplication() { try { await 0 } finally { void 0 } }',
      ),
    ]),
  ).toContain(`composition-try:${driveEntry}#driveTaskEngineApplication`)
  // Infrastructure is outside the lock: the moved logic may branch, loop and throw there.
  expect(
    shapeViolations([
      sourceUnit(PREPARATION_GC, 'export function f() { try { throw 1 } finally {} }'),
    ]),
  ).toEqual([])
})
