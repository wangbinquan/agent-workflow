// RFC-413: structural locks for the execution mechanics that left task-execution composition/ — the pre-drive merge
// recovery and the wrapper iso create / merge-back (engine/kernel/), the wrapper workspace and the wrapper run ledger
// (engine/wrapper/) — on their own ports, with the composition reduced to binding. Reads the production owners without
// importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const RECOVERY = TE + 'engine/kernel/mergeRecovery.ts'
const ISOLATION = TE + 'engine/kernel/wrapperIsolation.ts'
const WORKSPACE = TE + 'engine/wrapper/wrapperWorkspace.ts'
const LEDGER = TE + 'engine/wrapper/wrapperRunLedger.ts'
const ISOLATION_PORTS = TE + 'application/ports/isolationMechanics.ts'
const WORKSPACE_PORTS = TE + 'application/ports/wrapperWorkspace.ts'
const LEDGER_PORTS = TE + 'application/ports/wrapperRunLedger.ts'
const BINDING = TE + 'composition/isolationMechanicsBinding.ts'
const MECHANICS = TE + 'composition/wrapperMechanics.ts'
const RUNTIME = TE + 'composition/wrapperRuntime.ts'
const DELETED = [
  TE + 'composition/executionMergeRecovery.ts',
  TE + 'composition/wrapperRunLifecycle.ts',
]
/** Every moved symbol (and the new port / binding symbols) and its one owner. */
const OWNERS = new Map([
  ['recoverMergesBeforeScope', RECOVERY],
  ['completeFrameMerges', RECOVERY],
  ['completeInterruptedMerge', RECOVERY],
  ['replayPendingMerge', RECOVERY],
  ['completeInterruptedRun', RECOVERY],
  ['replayConflictHumanResolutions', RECOVERY],
  ['abandonSupersededRuns', RECOVERY],
  ['scopeBaseHeads', RECOVERY],
  ['replaySubmodulesMissing', RECOVERY],
  ['createOrRebuildWrapperIso', ISOLATION],
  ['mergeBackWrapperIso', ISOLATION],
  ['createWrapperWorkspace', WORKSPACE],
  ['captureHead', WORKSPACE],
  ['captureGitPreDirty', WORKSPACE],
  ['createWrapperRunLedger', LEDGER],
  ['settleTerminal', LEDGER],
  ['supersedingWrapperOutcome', LEDGER],
  ['clearWrapperReuseDisabled', LEDGER],
  ['isSupersedableTransitionError', LEDGER],
  ['IsolationMechanicsPorts', ISOLATION_PORTS],
  ['IsolationRestoreRequest', ISOLATION_PORTS],
  ['IsolationScope', ISOLATION_PORTS],
  ['HumanConflictOutcome', ISOLATION_PORTS],
  ['WrapperWorkspaceEnginePorts', WORKSPACE_PORTS],
  ['WrapperWorkspaceScenes', WORKSPACE_PORTS],
  ['WrapperGitScope', WORKSPACE_PORTS],
  ['WrapperRunLedgerPorts', LEDGER_PORTS],
  ['createIsolationMechanicsPorts', BINDING],
  ['composeExecutionMergeRecovery', BINDING],
  ['createWrapperRunLedgerPorts', RUNTIME],
  ['createWrapperStatusPublisher', RUNTIME],
])
/** The binding files may build ports and nested state only: no isolation / merge / ledger flow of their own. */
const BINDING_FILES = [BINDING, MECHANICS, RUNTIME]
const FLOW_CALLS = [
  'writeSem.run(',
  'mergeStates.transition(',
  'mergeStates.tryTransition(',
  'nodeRuns.set(',
  'nodeRuns.mint(',
  'nodeRuns.transition(',
  'createIsoUnderLock(',
  'persistIsoBase(',
  'persistIsoNodeTree(',
  'mergeBackAndSettle(',
  'markMergeFailed(',
  'discardNodeIso(',
  'snapshotIsolatedWorkspace(',
  'mergeIsolatedWorkspace(',
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
  const found: string[] = []
  const owners = new Map<string, string[]>()
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    for (const [name, count] of declared(unit))
      for (let index = 0; index < count; index += 1)
        owners.set(name, [...(owners.get(name) ?? []), unit.path])
  }
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name) ?? []
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

/** A deleted file back, or a binding file running a mechanism step itself. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (BINDING_FILES.includes(unit.path))
      for (const call of FLOW_CALLS)
        if (unit.text.includes(call)) found.push('binding-flow:' + unit.path + ' ' + call)
  }
  return found.sort()
}

/** Kernel files import inward only (RFC-402); wrapper files import module layers, platform contracts and shared. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const shared = (target: string) =>
    target === '@agent-workflow/shared' || target.startsWith('packages/shared/src/')
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    const allowed =
      from === RECOVERY || from === ISOLATION
        ? [
            TE + 'domain/',
            TE + 'application/ports/',
            TE + 'engine/kernel/',
            PREFIX + 'platform/contracts/',
          ]
        : from === WORKSPACE || from === LEDGER
          ? [TE + 'domain/', TE + 'application/', TE + 'engine/', PREFIX + 'platform/contracts/']
          : null
    if (
      allowed !== null &&
      !allowed.some((prefix) => target.startsWith(prefix)) &&
      !shared(target) &&
      !target.startsWith('node:')
    )
      found.push('layer-import:' + from + ' -> ' + target)
  }
  return found.sort()
}

test('live corpus: recovery, wrapper isolation, workspace and ledger run on ports; composition only binds', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of new Set([...OWNERS.values(), ...BINDING_FILES]))
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(shapeViolations(UNITS)).toEqual([])
  expect(importViolations(UNITS)).toEqual([])
})

test('negative fixtures: a missing, duplicated or relocated owner is detected', () => {
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const extra = sourceUnit(PREFIX + 'services/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  for (const path of BINDING_FILES)
    for (const call of FLOW_CALLS)
      expect(
        shapeViolations([sourceUnit(path, `export const step = () => state.${call}x)`)]),
        `${path} ${call}`,
      ).toContain('binding-flow:' + path + ' ' + call)
  for (const [from, target] of [
    [RECOVERY, '../../composition/isolationMechanicsBinding'],
    [RECOVERY, '../../infrastructure/isolationWorkspaceView'],
    [RECOVERY, '../../application/frameChain'],
    [RECOVERY, '../node/shared/resolveMergeConflicts'],
    [ISOLATION, '@/modules/source-control/public/types'],
    [ISOLATION, '@/util/log'],
    [WORKSPACE, '../../infrastructure/isolationWorkspaceView'],
    [WORKSPACE, '../../composition/taskMechanicsState'],
    [LEDGER, '@/util/log'],
    [LEDGER, '../../infrastructure/consumedInputsParticipant'],
    [LEDGER, '@/services/scheduler'],
  ] as const)
    expect(
      importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
        v.startsWith('layer-import:'),
      ),
      `${from} -> ${target}`,
    ).toBe(true)
  for (const target of [
    '@/modules/task-execution/composition/executionMergeRecovery',
    '@/modules/task-execution/composition/wrapperRunLifecycle',
  ]) {
    const file = TE + 'composition/revived.ts'
    expect(importViolations([sourceUnit(file, `import { x } from '${target}'`)])).toContain(
      'deleted-reference:' + file,
    )
  }
})
