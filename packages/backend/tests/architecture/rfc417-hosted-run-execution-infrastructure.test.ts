// RFC-417: the hosted (CrewStation) task run scope, material references and the execution owner's adapter logic
// (workspace owner, capability cache, recovery proof, command reconciliation, Intent scratch release) are task-execution
// infrastructure, and the provider-neutral task material preparation is application; the two hosted composition files
// only construct and inject. Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const CS = TE + 'infrastructure/crewstation/'
const RUN_SCOPE = CS + 'taskAgentRunScope.ts'
const REFERENCES = CS + 'taskMaterialReferences.ts'
const WORKSPACES = CS + 'executionWorkspaces.ts'
const CAPABILITIES = CS + 'hostedCapabilities.ts'
const RECONCILIATION = CS + 'workspaceCommandReconciliation.ts'
const SCRATCH = CS + 'intentScratchRelease.ts'
const PREPARATION = TE + 'application/taskAgentMaterialPreparation.ts'
const MATERIAL_PORTS = TE + 'application/ports/taskAgentMaterial.ts'
const SELECTION = TE + 'composition/crewstationTaskRunSelection.ts'
const OWNER = TE + 'composition/crewstationExecution.ts'
const INFRASTRUCTURE_FILES = [
  RUN_SCOPE,
  REFERENCES,
  WORKSPACES,
  CAPABILITIES,
  RECONCILIATION,
  SCRATCH,
]
const APPLICATION_FILES = [PREPARATION]
const BINDINGS = [SELECTION, OWNER]
const DELETED = [TE + 'composition/taskAgentMaterialPreparation.ts']
/** Every moved symbol (and the new adapter / binding symbols) and its one owner. */
const OWNERS = new Map([
  ['openHostedTaskAgentRun', RUN_SCOPE],
  ['HostedTaskRunSelectionInput', RUN_SCOPE],
  ['createHostedTaskMaterialReferences', REFERENCES],
  ['createHostedExecutionWorkspaces', WORKSPACES],
  ['createOwnerRoutedWorkspaceHelper', WORKSPACES],
  ['OwnerRoutedWorkspaceHelper', WORKSPACES],
  ['createCachedHostedCapabilities', CAPABILITIES],
  ['hostedProfileCapability', CAPABILITIES],
  ['HostedProfileCapabilityName', CAPABILITIES],
  ['createHostedWorkspaceCommandReconciliation', RECONCILIATION],
  ['createHostedIntentScratchRelease', SCRATCH],
  ['createTaskAgentMaterialPreparation', PREPARATION],
  ['TaskAgentMaterialResources', MATERIAL_PORTS],
  ['TaskAgentMaterialDiagnostics', MATERIAL_PORTS],
  ['composeCrewStationTaskRunSelection', SELECTION],
  ['composeCrewStationExecutionOwner', OWNER],
  ['composeCrewStationIntentScratchRelease', OWNER],
])
/** Adapter steps the two hosted composition files no longer contain. */
const ADAPTER_TOKENS = [
  "'write-seeds'",
  "'git-control'",
  "'validate-output'",
  "'system-workspace'",
  'hosted-skill-version-required',
  'hosted-skill:',
  'project-skill:',
  'setTimeout(',
  'CAPABILITY_CACHE_MS',
  'SETTLEMENT_INTERVAL_MS',
  'readTaskWorkspaceRef(',
  'isTaskWorkspaceUnbound(',
  'hosted-intent-scratch-',
  '.agentProfiles.some(',
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

/** A deleted file back, or an adapter step written in one of the two hosted composition files. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (BINDINGS.includes(unit.path))
      for (const token of ADAPTER_TOKENS)
        if (unit.text.includes(token)) found.push('binding-adapter:' + unit.path + ' ' + token)
  }
  return found.sort()
}

/** Infrastructure files import no composition; the application file imports neither infrastructure nor composition. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    const layer = /\/modules\/[^/]+\/(infrastructure|composition)(?:\/|\.|$)/.exec(target)?.[1]
    if (layer === undefined) continue
    if (INFRASTRUCTURE_FILES.includes(from) && layer === 'composition')
      found.push('composition-import:' + from + ' -> ' + target)
    if (APPLICATION_FILES.includes(from)) found.push(`${layer}-import:` + from + ' -> ' + target)
  }
  return found.sort()
}

test('live corpus: the hosted run scope and owner logic are infrastructure; composition constructs and injects', () => {
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
  for (const binding of BINDINGS)
    for (const token of ADAPTER_TOKENS)
      expect(shapeViolations([sourceUnit(binding, `const x = ${token}`)])).toContain(
        'binding-adapter:' + binding + ' ' + token,
      )
  expect(shapeViolations([sourceUnit(RUN_SCOPE, "helper.call(x, 'write-seeds')")])).toEqual([])
  for (const from of INFRASTRUCTURE_FILES)
    for (const target of [
      '../../composition/crewstationExecution',
      '@/modules/runtime-management/composition/crewstationSystemAgentMaterial',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
          v.startsWith('composition-import:' + from + ' -> '),
        ),
        `${from} -> ${target}`,
      ).toBe(true)
  for (const target of [
    './ports/../../infrastructure/taskExecutionTaskReads',
    '../composition/portArtifacts',
  ])
    expect(
      importViolations([sourceUnit(PREPARATION, `import { x } from '${target}'`)]).some((v) =>
        /^(?:infrastructure|composition)-import:/.test(v),
      ),
      target,
    ).toBe(true)
  const file = TE + 'composition/revived.ts'
  expect(
    importViolations([sourceUnit(file, "import { x } from './taskAgentMaterialPreparation'")]),
  ).toContain('deleted-reference:' + file)
})
