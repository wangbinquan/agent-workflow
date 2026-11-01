// RFC-410: structural locks for the dynamic-workflow generation engine that left services/ for
// task-execution engine/task/ (the generation pass) and domain/ (orchestrator agent, generation rules),
// with the layer-two validator in @agent-workflow/shared. Reads the production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const ENGINE = TE + 'engine/task/dynamicWorkflowGenerate.ts'
const GENERATION = TE + 'domain/dynamicWorkflowGeneration.ts'
const ORCHESTRATOR = TE + 'domain/dynamicWorkflowOrchestrator.ts'
const PORT = TE + 'application/ports/dynamicWorkflowGenerate.ts'
const BINDING = TE + 'composition/taskEngineApplication.ts'
const CONTROL_PLANE = TE + 'engine/task/runTask.ts'
const CONTROL_PORTS = TE + 'application/ports/taskRun.ts'
const VALIDATION_COMPOSITION = PREFIX + 'modules/resource-catalog/composition/workflowOperations.ts'
const SHARED = 'packages/shared/src/dynamicWorkflow.ts'
const DELETED = [
  PREFIX + 'services/dynamicWorkflowRunner.ts',
  PREFIX + 'services/orchestratorAgent.ts',
]
/** The files on the generation path, which must not carry the resource catalog's inventory type. */
const VALIDATION_PATH = [
  ENGINE,
  GENERATION,
  ORCHESTRATOR,
  PORT,
  BINDING,
  TE + 'composition/taskEngineRuntimeOptions.ts',
  TE + 'infrastructure/taskExecutionRuntimeParticipants.ts',
]
const INVENTORY_MARKERS = [
  'ValidatorContext',
  'DynamicWorkflowValidationContextSource',
  'workflow.validator',
]
/** Every moved symbol and its one backend owner. */
const OWNERS = new Map([
  ['runDynamicWorkflowGenerate', ENGINE],
  ['DW_MAX_GENERATE_ATTEMPTS', GENERATION],
  ['DW_MAX_REJECT_ROUNDS', GENERATION],
  ['DW_GENERATE_CAUSE', GENERATION],
  ['DW_GATE_CAUSE', GENERATION],
  ['extractJsonPayload', GENERATION],
  ['dwCallNodeRejections', GENERATION],
  ['evaluateGeneratedWorkflow', GENERATION],
  ['GeneratedWorkflowLayerOneValidator', GENERATION],
  ['ORCHESTRATOR_WORKFLOW_PORT', ORCHESTRATOR],
  ['DW_ORCHESTRATOR_NODE_ID', ORCHESTRATOR],
  ['buildDynamicWorkflowGenerateSnapshot', ORCHESTRATOR],
  ['buildOrchestratorAgent', ORCHESTRATOR],
  ['DwPoolMember', ORCHESTRATOR],
  ['buildDwPoolMembers', ORCHESTRATOR],
  ['dwPoolTokenMap', ORCHESTRATOR],
  ['buildOrchestratorPrompt', ORCHESTRATOR],
  ['DynamicWorkflowGeneratePorts', PORT],
  ['DynamicWorkflowGenerateArgs', PORT],
  ['DynamicWorkflowLayerOneValidation', PORT],
  ['composeDynamicWorkflowLayerOneValidation', VALIDATION_COMPOSITION],
])
/** Moved to shared: no backend declaration may remain. */
const SHARED_ONLY = ['validateDynamicWorkflowDef']
/** The generation pass's own machinery; the binding must not regain it. */
const PASS_MARKERS = [
  'evaluateGeneratedWorkflow(',
  'DW_MAX_GENERATE_ATTEMPTS',
  'openDwGate',
  'buildOrchestratorPrompt(',
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
      (OWNERS.has(node.name.text) || SHARED_ONLY.includes(node.name.text))
    )
      found.set(node.name.text, (found.get(node.name.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  scans.set(unit, found)
  return found
}

/** Each moved symbol has exactly one backend declaration, at its owner; shared-only symbols have none. */
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
  for (const name of SHARED_ONLY)
    if ((owners.get(name) ?? []).length > 0) found.push('backend-copy:' + name)
  return found.sort()
}

/** The deleted files back, the pass back in the binding, the control-plane port back, or the inventory type on the path. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (unit.path === BINDING)
      for (const marker of PASS_MARKERS)
        if (unit.text.includes(marker)) found.push('binding-pass:' + marker)
    if (
      (unit.path === CONTROL_PLANE || unit.path === CONTROL_PORTS) &&
      unit.text.includes('dynamicWorkflowOrchestratorNodeId')
    )
      found.push('control-plane-port:' + unit.path)
    if (VALIDATION_PATH.includes(unit.path))
      for (const marker of INVENTORY_MARKERS)
        if (unit.text.includes(marker)) found.push('inventory-type:' + unit.path + ':' + marker)
  }
  const binding = units.find((unit) => unit.path === BINDING)
  if (
    binding !== undefined &&
    !binding.text.includes('runDynamicWorkflowGenerate(dynamicWorkflowPorts(), {')
  )
    found.push('binding-drive')
  return found.sort()
}

/** The engine imports only its module's inner layers; the domain files only the domain; nobody imports the deleted files. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const shared = (target: string) =>
    target === '@agent-workflow/shared' || target.startsWith('packages/shared/src/')
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + edge.from.path)
    if (edge.from.path === ENGINE) {
      const inner = [TE + 'domain/', TE + 'application/', TE + 'engine/'].some((prefix) =>
        target.startsWith(prefix),
      )
      if (!inner && !shared(target) && !target.startsWith('node:'))
        found.push('layer-import:' + edge.from.path + ' -> ' + target)
    }
    if (edge.from.path === GENERATION || edge.from.path === ORCHESTRATOR) {
      if (!target.startsWith(TE + 'domain/') && !shared(target))
        found.push('layer-import:' + edge.from.path + ' -> ' + target)
    }
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

test('live corpus: the generation pass lives in engine/task/, its rules in domain/, the layer-two validator in shared', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of [ENGINE, GENERATION, ORCHESTRATOR, PORT, BINDING, VALIDATION_COMPOSITION])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(readFileSync(resolve(ROOT, SHARED), 'utf8')).toContain(
    'export function validateDynamicWorkflowDef(',
  )
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(shapeViolations(UNITS)).toEqual([])
  expect(importViolations(UNITS)).toEqual([])
})

test('negative fixtures: a missing, duplicated or relocated owner, or a backend copy of the shared validator, is detected', () => {
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const extra = sourceUnit(PREFIX + 'services/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
  const copy = sourceUnit(
    PREFIX + 'services/duplicate.ts',
    'export function validateDynamicWorkflowDef() {}',
  )
  expect(ownershipViolations([...UNITS, copy])).toContain('backend-copy:validateDynamicWorkflowDef')
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  expect(
    ownershipViolations([
      sourceUnit(
        PREFIX + 'services/orchestratorAgent.ts',
        'export function buildOrchestratorAgent() {}',
      ),
    ]),
  ).toContain('owner:buildOrchestratorAgent')
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  for (const marker of PASS_MARKERS)
    expect(shapeViolations([sourceUnit(BINDING, `const pass = () => ${marker}`)])).toEqual(
      expect.arrayContaining(['binding-pass:' + marker, 'binding-drive']),
    )
  for (const path of [CONTROL_PLANE, CONTROL_PORTS])
    expect(
      shapeViolations([
        sourceUnit(path, 'const id = ports.rules.dynamicWorkflowOrchestratorNodeId'),
      ]),
    ).toContain('control-plane-port:' + path)
  for (const path of VALIDATION_PATH)
    for (const marker of INVENTORY_MARKERS)
      expect(shapeViolations([sourceUnit(path, `type T = ${marker}`)])).toContain(
        'inventory-type:' + path + ':' + marker,
      )
  for (const [from, target] of [
    [ENGINE, '@/services/execution/triggerPreflight'],
    [ENGINE, '@/modules/resource-catalog/public/queries'],
    [GENERATION, '../application/ports/dynamicWorkflowGenerate'],
    [ORCHESTRATOR, '@/modules/task-execution/public/queries'],
  ] as const)
    expect(importViolations([sourceUnit(from, `import { x } from '${target}'`)]).length, from).toBe(
      1,
    )
  for (const target of ['@/services/dynamicWorkflowRunner', '@/services/orchestratorAgent']) {
    const file = TE + 'composition/revived.ts'
    expect(importViolations([sourceUnit(file, `import { x } from '${target}'`)])).toContain(
      'deleted-reference:' + file,
    )
  }
})

test('negative fixtures: the binding running the pass itself instead of the engine is detected', () => {
  const revived = replaceUnit(
    UNITS,
    BINDING,
    'runDynamicWorkflowGenerate(dynamicWorkflowPorts(), {',
    'evaluateGeneratedWorkflow(dynamicWorkflowPorts(), {',
  )
  expect(shapeViolations(revived)).toEqual(
    expect.arrayContaining(['binding-drive', 'binding-pass:evaluateGeneratedWorkflow(']),
  )
})
