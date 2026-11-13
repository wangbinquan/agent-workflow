// RFC-422: the run family openers left task-execution composition — the local system agent / runtime smoke / task
// agent openers are infrastructure/local, the hosted system agent opener and runtime probe are
// infrastructure/crewstation, and other modules' implementations reach them through task-execution's own provider
// ports. The four composition files only select providers and inject them (RFC-489: the providers themselves come from
// bootstrap). Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const LOCAL = TE + 'infrastructure/local/'
const HOSTED = TE + 'infrastructure/crewstation/'
const NATIVE_PORTS = LOCAL + 'nativeRunFamilyProviders.ts'
const HOSTED_PORTS = HOSTED + 'hostedRunFamilyProviders.ts'
const LOCAL_SYSTEM = LOCAL + 'systemAgentRunFamily.ts'
const LOCAL_SMOKE = LOCAL + 'runtimeSmokeRunFamily.ts'
const LOCAL_TASK = LOCAL + 'taskAgentRunFamily.ts'
const HOSTED_SYSTEM = HOSTED + 'systemAgentRunFamily.ts'
const HOSTED_SMOKE = HOSTED + 'runtimeSmokeRunFamily.ts'
const OPENER_FILES = [
  NATIVE_PORTS,
  HOSTED_PORTS,
  LOCAL_SYSTEM,
  LOCAL_SMOKE,
  LOCAL_TASK,
  HOSTED_SYSTEM,
  HOSTED_SMOKE,
]
const BINDINGS = [
  'localSystemAgentRunFamily',
  'localRuntimeSmokeRunFamily',
  'localTaskAgentRunFamily',
  'crewstationSystemAgentRunFamily',
  // RFC-489: the hosted runtime-management root is gone — runtime-management assembles it, bootstrap pairs the probe.
].map((name) => TE + 'composition/' + name + '.ts')
/** Every moved symbol (and the composition entries that stay) and its one owner. */
const OWNERS = new Map([
  ['NativeMaterialDefinition', NATIVE_PORTS],
  ['NativeMaterialContents', NATIVE_PORTS],
  ['NativeSystemAgentContents', NATIVE_PORTS],
  ['NativeTaskAgentWorkspaceContents', NATIVE_PORTS],
  ['HostedRunFamilyInput', HOSTED_PORTS],
  ['HostedSystemAgentContents', HOSTED_PORTS],
  ['createLocalSystemAgentRunFamily', LOCAL_SYSTEM],
  ['LocalSystemAgentRunFamilyInput', LOCAL_SYSTEM],
  ['createLocalRuntimeSmokeRunFamily', LOCAL_SMOKE],
  ['createLocalTaskAgentRunFamily', LOCAL_TASK],
  ['createHostedSystemAgentRunFamily', HOSTED_SYSTEM],
  ['createHostedRuntimeSmokeProbe', HOSTED_SMOKE],
  ['HOSTED_RUNTIME_PROBE_BUDGET_MS', HOSTED_SMOKE],
  ['composeLocalSystemAgentRunFamily', BINDINGS[0]!],
  ['composeLocalRuntimeSmokeRunFamily', BINDINGS[1]!],
  ['composeLocalTaskAgentRunFamily', BINDINGS[2]!],
  ['createCrewStationSystemAgentRunFamily', BINDINGS[3]!],
])
/** Steps of the openers the four composition files no longer contain. */
const OPENER_TOKENS = [
  '-content-reference-unavailable',
  'persona-skill-content-unavailable',
  'smoke-skill-unavailable',
  'createLocalAgentInvocationPreparation(',
  'createHostedAgentInvocationPreparation(',
  'nativeFixtureRequest',
  'canRelease',
]
/** Import targets the opener files may not reach: other modules' internals and this module's composition. */
const FORBIDDEN_TARGET =
  /\/modules\/(?!task-execution\/)[^/]+\/(?:composition|infrastructure)(?:\/|\.|$)|\/modules\/task-execution\/composition(?:\/|\.|$)/
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

/** An opener step written in one of the four composition files. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units)
    if (BINDINGS.includes(unit.path))
      for (const token of OPENER_TOKENS)
        if (unit.text.includes(token)) found.push('binding-opener:' + unit.path + ' ' + token)
  return found.sort()
}

/** The opener files import no other module's composition / infrastructure and no composition of their own. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    if (!OPENER_FILES.includes(from)) continue
    if (FORBIDDEN_TARGET.test(edge.target))
      found.push('provider-import:' + from + ' -> ' + edge.target)
  }
  return found.sort()
}

test('live corpus: the openers live in infrastructure and reach other modules only through the ports', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of new Set([...OWNERS.values(), ...OPENER_FILES]))
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
    for (const token of OPENER_TOKENS)
      expect(
        shapeViolations([sourceUnit(binding, `const x = ${JSON.stringify(token)}`)]),
      ).toContain('binding-opener:' + binding + ' ' + token)
  expect(shapeViolations([sourceUnit(LOCAL_SYSTEM, "'-content-reference-unavailable'")])).toEqual(
    [],
  )
  for (const from of OPENER_FILES) {
    for (const specifier of [
      '@/modules/runtime-management/composition/localAgentMaterial',
      '@/modules/source-control/infrastructure/local/taskAgentWorkspaceContents',
      '@/modules/task-execution/composition/portOutputValidation',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${specifier}'`)]).some((v) =>
          v.startsWith('provider-import:' + from + ' -> '),
        ),
        from + ' ' + specifier,
      ).toBe(true)
    for (const allowed of [
      "import type { X } from '@/modules/runtime-management/public/participants'",
      "import { y } from '@/modules/task-execution/infrastructure/local/agentInvocation'",
    ])
      expect(importViolations([sourceUnit(from, allowed)]), from + ' ' + allowed).toEqual([])
  }
})
