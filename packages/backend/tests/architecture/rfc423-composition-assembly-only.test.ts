// RFC-423: task-execution composition only assembles. The schedule launch / trigger participant, the hosted recovery
// selection and the preparation GC routing left for infrastructure, and this lock pins where the moved logic lives. The
// assembly-shape rules (no loop, no switch, no try, no throw) that this lock held for task-execution became the
// all-module gate `rfc515-composition-assembly-only` (RFC-515). Reads the production sources without importing them.
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

test('live corpus: the logic moved out of task-execution composition has one infrastructure owner', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(UNITS.filter((unit) => unit.path.startsWith(COMPOSITION)).length).toBeGreaterThanOrEqual(
    90,
  )
  for (const path of new Set(OWNERS.values()))
    expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  expect(existsSync(resolve(ROOT, COMPOSITION + 'triggerExecution.ts'))).toBe(false)
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: fabricated sources alone are judged by the same owner check', () => {
  // RFC-515: the shape fixtures moved to rfc515-composition-assembly-only; this keeps a fabricated-only fixture.
  expect(
    ownershipViolations([
      sourceUnit(COMPOSITION + 'relocated.ts', 'export function createBuildScheduleLaunch() {}'),
    ]),
  ).toContain('owner:createBuildScheduleLaunch')
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
