// RFC-421: the agent invocation stack left task-execution composition — the two-phase preparation, the system agent run
// core and the runtime smoke core with its material declaration are application; the local agent invocation adapter
// and the local invocation preparation are infrastructure/local. Six composition files are gone. Reads the production
// sources without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const PREPARATION = TE + 'application/agentInvocationPreparation.ts'
const SYSTEM_AGENT = TE + 'application/systemAgentRun.ts'
const SMOKE = TE + 'application/runtimeSmoke.ts'
const LOCAL_INVOCATION = TE + 'infrastructure/local/agentInvocation.ts'
const LOCAL_PREPARATION = TE + 'infrastructure/local/agentInvocationPreparation.ts'
const APPLICATION_FILES = [PREPARATION, SYSTEM_AGENT, SMOKE]
/** The composition files the stack left; none may come back. */
const DELETED = [
  'agentInvocation',
  'agentInvocationPreparation',
  'localAgentInvocationPreparation',
  'systemAgentRunFamily',
  'runtimeSmokeRunFamily',
  'runtimeSmoke',
].map((name) => TE + 'composition/' + name + '.ts')
/** Every moved symbol and its one owner. */
const OWNERS = new Map([
  ['createAgentInvocationPreparation', PREPARATION],
  ['createSystemAgentRunFamily', SYSTEM_AGENT],
  ['createRuntimeSmokeRunFamily', SMOKE],
  ['createRuntimeSmokeMaterialIntent', SMOKE],
  ['runPreparedRuntimeSmoke', SMOKE],
  ['bindNativeAgentInvocation', LOCAL_INVOCATION],
  ['createLocalAgentInvocationPreparation', LOCAL_PREPARATION],
])
/** Import targets the moved application files may not reach. */
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

/** A retired composition file present again. */
function deletedViolations(units: readonly SourceUnit[]): string[] {
  return units
    .filter((unit) => DELETED.includes(unit.path))
    .map((unit) => 'revived:' + unit.path)
    .sort()
}

/** The moved application files import no composition, infrastructure or horizontal layer. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    if (!APPLICATION_FILES.includes(from)) continue
    if (FORBIDDEN_TARGET.test(edge.target))
      found.push('layer-import:' + from + ' -> ' + edge.target)
  }
  return found.sort()
}

test('live corpus: the invocation stack lives in application and infrastructure/local', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of new Set(OWNERS.values()))
    expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(ownershipViolations(UNITS)).toEqual([])
  expect(deletedViolations(UNITS)).toEqual([])
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
    expect(deletedViolations([sourceUnit(path, 'export const revived = 1')])).toEqual([
      'revived:' + path,
    ])
  for (const from of APPLICATION_FILES) {
    for (const specifier of [
      '@/modules/task-execution/composition/localSystemAgentRunFamily',
      '@/modules/task-execution/infrastructure/local/agentInvocation',
      '@/services/runtime',
      '@/routes/tasks',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${specifier}'`)]).some((v) =>
          v.startsWith('layer-import:' + from + ' -> '),
        ),
        from + ' ' + specifier,
      ).toBe(true)
    expect(
      importViolations([
        sourceUnit(
          from,
          "import type { X } from '@/modules/runtime-management/public/participants'",
        ),
      ]),
    ).toEqual([])
  }
})
