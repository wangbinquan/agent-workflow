// RFC-416: the hosted (CrewStation) agent invocation adapter and the hosted MCP diagnostic sessions are task-execution
// infrastructure; composition keeps only the binding that runs a diagnostic turn through the System Agent core. Reads
// the production sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const PREPARATION = TE + 'infrastructure/crewstation/agentInvocationPreparation.ts'
const SESSIONS = TE + 'infrastructure/crewstation/mcpDiagnosticSessions.ts'
const BINDING = TE + 'composition/crewstationMcpDiagnosticRunner.ts'
const INFRASTRUCTURE_FILES = [PREPARATION, SESSIONS]
const DELETED = [TE + 'composition/crewstationAgentInvocation.ts']
/** Every moved symbol (and the new session / binding symbols) and its one owner. */
const OWNERS = new Map([
  ['createHostedAgentInvocationPreparation', PREPARATION],
  ['createHostedAgentParticipants', PREPARATION],
  ['HostedAgentProfile', PREPARATION],
  ['HostedAgentParticipants', PREPARATION],
  ['createHostedMcpDiagnosticSessions', SESSIONS],
  ['HostedMcpDiagnosticInput', SESSIONS],
  ['HostedMcpDiagnosticTurn', SESSIONS],
  ['createCrewStationMcpDiagnosticRunner', BINDING],
])
/** Steps of the two adapters that may not reappear in task-execution composition. */
const ADAPTER_TOKENS = [
  'hosted-runtime-profile-unmapped',
  'hosted-capability-unavailable',
  'hosted-material-exceeds-platform-limit',
  'hosted-agent-binding-kind-mismatch',
  'hosted-agent-execution-participant-unavailable',
  'compileHostedNativeMaterial(',
  'createHostedProcessEffectProjection(',
  'mcp-test-unexpected-skill-material',
  '/work/system/shared/',
]
/** Platform, hosted execution and helper calls the MCP binding no longer makes itself. */
const BINDING_TOKENS = [
  '.listFiles(',
  '.getSubtask(',
  '.adopt(',
  '.workspaceSettled(',
  '.call(',
  'isTerminalSubtaskState',
  'createHostedAgentInvocationPreparation',
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

/** A deleted file back, an adapter step written in composition, or a hosted call made by the binding itself. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) found.push('deleted-file:' + unit.path)
    if (unit.path.startsWith(TE + 'composition/'))
      for (const token of ADAPTER_TOKENS)
        if (unit.text.includes(token)) found.push('composition-adapter:' + unit.path + ' ' + token)
    if (unit.path === BINDING)
      for (const token of BINDING_TOKENS)
        if (unit.text.includes(token)) found.push('binding-hosted-call:' + token)
  }
  return found.sort()
}

/** The new infrastructure files import no composition; the sessions leave the System Agent core to the binding. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    if (!INFRASTRUCTURE_FILES.includes(from)) continue
    if (/\/modules\/[^/]+\/composition(?:\/|\.|$)/.test(target))
      found.push('composition-import:' + from + ' -> ' + target)
    if (from === SESSIONS && /\/application\/systemAgentRun(?:\.ts)?$/.test(target))
      found.push('core-import:' + from)
  }
  return found.sort()
}

test('live corpus: the hosted adapters are task-execution infrastructure; composition binds', () => {
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
  for (const token of ADAPTER_TOKENS)
    expect(shapeViolations([sourceUnit(composition, `const x = '${token}'`)])).toContain(
      'composition-adapter:' + composition + ' ' + token,
    )
  expect(
    shapeViolations([
      sourceUnit(TE + 'infrastructure/crewstation/revived.ts', "const x = '/work/system/shared/'"),
    ]),
  ).toEqual([])
  for (const token of BINDING_TOKENS)
    expect(shapeViolations([sourceUnit(BINDING, `const x = ${token}`)])).toContain(
      'binding-hosted-call:' + token,
    )
  expect(
    shapeViolations([
      sourceUnit(TE + 'composition/crewstationTaskRunSelection.ts', 'helper.call(x)'),
    ]),
  ).toEqual([])
  for (const from of INFRASTRUCTURE_FILES)
    for (const target of [
      '../../composition/crewstationMcpDiagnosticRunner',
      '@/modules/runtime-management/composition/crewstationSystemAgentMaterial',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
          v.startsWith('composition-import:'),
        ),
        `${from} -> ${target}`,
      ).toBe(true)
  expect(
    importViolations([
      sourceUnit(SESSIONS, "import { runSystemAgentCore } from '../../application/systemAgentRun'"),
    ]),
  ).toContain('core-import:' + SESSIONS)
  expect(
    importViolations([
      sourceUnit(
        SESSIONS,
        "import type { SystemAgentCoreInvocation } from '../../application/ports/systemAgentRun'",
      ),
    ]),
  ).toEqual([])
  const file = TE + 'composition/revived.ts'
  expect(
    importViolations([sourceUnit(file, "import { x } from './crewstationAgentInvocation'")]),
  ).toContain('deleted-reference:' + file)
})
