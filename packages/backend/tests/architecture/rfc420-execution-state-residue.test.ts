// RFC-420: the residual logic of the execution state bindings left task-execution composition — the closure port
// read and the prior fan-out provenance (application/nodeInputs.ts), the fan-out agent and source-port-kind
// resolution (application/fanoutAgentResolution.ts), the wrapper body's entry (engine/wrapper/wrapperBodyScope.ts),
// the call node's delegated actor and child runtime (application/childCallInheritance.ts), the call row's iso rebuild
// (engine/kernel/mergeRecovery.ts) and the collaborator projection (domain/taskCollaborators.ts). The four bindings
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
const NODE_INPUTS = TE + 'application/nodeInputs.ts'
const RESOLUTION = TE + 'application/fanoutAgentResolution.ts'
const INHERITANCE = TE + 'application/childCallInheritance.ts'
const BODY_SCOPE = TE + 'engine/wrapper/wrapperBodyScope.ts'
const MERGE_RECOVERY = TE + 'engine/kernel/mergeRecovery.ts'
const COLLABORATORS = TE + 'domain/taskCollaborators.ts'
const WRAPPER = TE + 'composition/wrapperMechanics.ts'
const AGENT = TE + 'composition/agentNodeExecution.ts'
const CHILD_CALL = TE + 'composition/childCallNodeExecution.ts'
const APPLICATION = TE + 'composition/taskEngineApplication.ts'
const STATE = TE + 'composition/taskMechanicsState.ts'
const MOVED_FILES = [
  NODE_INPUTS,
  RESOLUTION,
  INHERITANCE,
  BODY_SCOPE,
  MERGE_RECOVERY,
  COLLABORATORS,
]
const BINDINGS = [WRAPPER, AGENT, CHILD_CALL, APPLICATION]
/** Every moved symbol (and the binding symbols that stay) and its one owner. */
const OWNERS = new Map([
  ['readPortInScope', NODE_INPUTS],
  ['priorFanoutConsumedJson', NODE_INPUTS],
  ['FanoutAgentResources', RESOLUTION],
  ['resolveFanoutAgent', RESOLUTION],
  ['sourcePortKindOf', RESOLUTION],
  ['delegatedCallActor', INHERITANCE],
  ['buildChildRuntime', INHERITANCE],
  ['ChildRuntimeParent', INHERITANCE],
  ['OWNERLESS_LEGACY_ACTOR', INHERITANCE],
  ['WrapperBodyMounts', BODY_SCOPE],
  ['wrapperBodyMounts', BODY_SCOPE],
  ['WrapperBodyScopePorts', BODY_SCOPE],
  ['createWrapperScopeDriver', BODY_SCOPE],
  ['restoreNodeIso', MERGE_RECOVERY],
  ['collaboratorUserIdsOf', COLLABORATORS],
  ['createWrapperMechanicsPorts', WRAPPER],
  ['agentResolutionResources', AGENT],
  ['createChildCallNodeExecutionPorts', CHILD_CALL],
  ['createTaskRunPorts', APPLICATION],
  ['TaskScopeArgs', STATE],
])
/** Steps of the moved bodies the four bindings no longer contain. */
const LOGIC_TOKENS = [
  'closure-binding-unresolved',
  'resolveSourceFrameInScope',
  'familyHistory(',
  'handle.passthrough',
  'isoWorktreePath',
  'declaredPorts(',
  'OWNERLESS_SYSTEM_USER_ID',
  '.forCall(',
  'recoverKey(',
  'parseIsoSubmodules',
  "member.role !== 'owner'",
]
/** Import targets the moved application / engine / domain files may not reach. */
const FORBIDDEN_TARGET =
  /^packages\/backend\/src\/(?:services|routes|ws|mcp)\/|\/modules\/[^/]+\/(?:composition|infrastructure)(?:\/|\.|$)/
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

/** A moved step written in one of the four bindings, or the dead result type back in the state. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (BINDINGS.includes(unit.path))
      for (const token of LOGIC_TOKENS)
        if (unit.text.includes(token)) found.push('binding-logic:' + unit.path + ' ' + token)
    if (unit.path === STATE && /\bNodeMechanicsResult\b/.test(unit.text))
      found.push('dead-type:NodeMechanicsResult')
  }
  return found.sort()
}

/** The moved files import no composition, infrastructure or horizontal layer. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    if (!MOVED_FILES.includes(from)) continue
    if (FORBIDDEN_TARGET.test(edge.target))
      found.push('layer-import:' + from + ' -> ' + edge.target)
  }
  return found.sort()
}

test('live corpus: the execution state residue lives in application / engine / domain', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of new Set([...OWNERS.values(), ...MOVED_FILES]))
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
    for (const token of LOGIC_TOKENS)
      expect(
        shapeViolations([sourceUnit(binding, `const x = ${JSON.stringify(token)}`)]),
      ).toContain('binding-logic:' + binding + ' ' + token)
  expect(shapeViolations([sourceUnit(NODE_INPUTS, "'closure-binding-unresolved'")])).toEqual([])
  expect(
    shapeViolations([sourceUnit(STATE, 'export interface NodeMechanicsResult { kind: string }')]),
  ).toEqual(['dead-type:NodeMechanicsResult'])
  for (const from of MOVED_FILES) {
    for (const specifier of [
      '@/modules/task-execution/composition/wrapperMechanics',
      '@/modules/task-execution/infrastructure/consumedInputsParticipant',
      '@/services/ref/runtimeRef',
      '@/routes/tasks',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${specifier}'`)]).some((v) =>
          v.startsWith('layer-import:' + from + ' -> '),
        ),
        from + ' ' + specifier,
      ).toBe(true)
    expect(
      importViolations([sourceUnit(from, "import { x } from '@agent-workflow/shared'")]),
    ).toEqual([])
  }
})
