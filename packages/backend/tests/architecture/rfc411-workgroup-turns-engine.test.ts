// RFC-411: structural locks for the workgroup turn engine that left resource-catalog for task-execution:
// the drive loop and prompts in engine/task/workgroup/, the snapshot / ledger / persistence-port types in
// application/ports/, the pure protocol / system-message / turn-context helpers and the transition tables in
// domain/workgroup/, the persistence adapter in infrastructure/, the assembly in composition/. Reads the
// production owners without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const RC = PREFIX + 'modules/resource-catalog/'
const ENGINE = TE + 'engine/task/workgroup/workgroupTurns.ts'
const PROMPTS = TE + 'engine/task/workgroup/turnPrompts.ts'
const PORTS = TE + 'application/ports/workgroupTurns.ts'
const TRANSITIONS = TE + 'domain/workgroup/turnTransitions.ts'
const PROTOCOL = TE + 'domain/workgroup/protocol.ts'
const SYSTEM_MESSAGES = TE + 'domain/workgroup/systemMessages.ts'
const CONTEXT = TE + 'domain/workgroup/turnContext.ts'
const ADAPTER = TE + 'infrastructure/workgroupTurnsPersistence.ts'
const QUEUE = TE + 'infrastructure/workgroupCommitQueue.ts'
const COMPOSITION = TE + 'composition/workgroupTurns.ts'
const ROOM = RC + 'application/workgroups/workgroupRoomProjection.ts'
const DELETED = [
  RC + 'application/workgroups/workgroupTurnsDriver.ts',
  RC + 'application/workgroups/workgroupTurnPrompts.ts',
  RC + 'application/workgroups/workgroupProtocol.ts',
  RC + 'application/workgroups/workgroupSystemMessages.ts',
  RC + 'application/workgroups/workgroupTurnContext.ts',
  RC + 'infrastructure/workgroupTurnsOperations.ts',
  RC + 'infrastructure/workgroupCommitQueue.ts',
  RC + 'composition/workgroupTurns.ts',
]
/** Every moved symbol and its one owner. */
const OWNERS = new Map([
  ['createWorkgroupTurnsOperations', ENGINE],
  ['deriveWakeSet', ENGINE],
  ['decideWorkgroupOutcome', ENGINE],
  ['messageDraft', ENGINE],
  ['composeLeaderPrompt', PROMPTS],
  ['composeMemberPrompt', PROMPTS],
  ['WorkgroupTurnsSnapshot', PORTS],
  ['WorkgroupTurnsPersistencePort', PORTS],
  ['WorkgroupTurnLedgerOperation', PORTS],
  ['WorkgroupClarifyAllowedPort', PORTS],
  ['WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS', TRANSITIONS],
  ['WORKGROUP_TURN_GATE_TRANSITIONS', TRANSITIONS],
  ['renderWgProtocolBlock', PROTOCOL],
  ['wgHostRolePorts', PROTOCOL],
  ['buildSystemMessage', SYSTEM_MESSAGES],
  ['selectMemberSlices', CONTEXT],
  ['createWorkgroupTurnsPersistence', ADAPTER],
  ['runWorkgroupCommit', QUEUE],
  ['composeWorkgroupTurnsOperations', COMPOSITION],
  ['createWorkgroupTurnsPersistenceOperations', COMPOSITION],
  ['resolveMessageTurnTriggerId', ROOM],
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

/** Each moved symbol has exactly one declaration in the backend, at its owner. */
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

/** A deleted resource-catalog file back. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  return units
    .filter((unit) => DELETED.includes(unit.path))
    .map((unit) => 'deleted-file:' + unit.path)
    .sort()
}

/**
 * The engine imports only its module's inner layers and shared; the domain helpers only the domain and
 * shared; the adapter reads the resource catalog only through its public surface; the resource catalog no
 * longer imports the turn / host-ledger SPI; nobody imports a deleted file.
 */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  const shared = (target: string) =>
    target === '@agent-workflow/shared' || target.startsWith('packages/shared/src/')
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      found.push('deleted-reference:' + from)
    if (from === ENGINE || from === PROMPTS) {
      const inner = [TE + 'domain/', TE + 'application/', TE + 'engine/'].some((prefix) =>
        target.startsWith(prefix),
      )
      if (!inner && !shared(target) && !target.startsWith('node:'))
        found.push('layer-import:' + from + ' -> ' + target)
    }
    if ([TRANSITIONS, PROTOCOL, SYSTEM_MESSAGES, CONTEXT].includes(from)) {
      if (!target.startsWith(TE + 'domain/') && !shared(target))
        found.push('layer-import:' + from + ' -> ' + target)
    }
    if (from === ADAPTER && target.startsWith(RC) && !target.startsWith(RC + 'public/'))
      found.push('catalog-internal:' + from + ' -> ' + target)
  }
  // Import edges carry no symbol names: the turn / host-ledger SPI check reads the import statements.
  const turnSpi =
    /import\s[^;]*?\b(?:WorkgroupTurn\w*|WorkgroupHostLedger\w*)\b[^;]*?from\s*'@\/modules\/task-execution\/public\//
  for (const unit of units)
    if (unit.path.startsWith(RC) && turnSpi.test(unit.text)) found.push('turn-spi:' + unit.path)
  return found.sort()
}

test('live corpus: the turn engine, its ports, helpers, adapter and assembly live in task-execution', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  for (const path of new Set(OWNERS.values()))
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
    const extra = sourceUnit(
      RC + 'application/workgroups/duplicate.ts',
      `export function ${name}() {}`,
    )
    expect(ownershipViolations([...UNITS, extra])).toContain('owner:' + name)
  }
})

test('negative fixtures: fabricated sources alone are judged by the same checks', () => {
  for (const path of DELETED)
    expect(shapeViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
  for (const [from, target] of [
    [ENGINE, '@/platform/nodeRunAttempt'],
    [ENGINE, 'ulid'],
    [PROMPTS, '@/modules/resource-catalog/public/queries'],
    [PROTOCOL, '../../application/ports/workgroupTurns'],
    [CONTEXT, '@/modules/task-execution/public/commands'],
  ] as const)
    expect(importViolations([sourceUnit(from, `import { x } from '${target}'`)]).length, from).toBe(
      1,
    )
  expect(
    importViolations([
      sourceUnit(
        ADAPTER,
        "import { loadAgentPersistenceRows } from '@/modules/resource-catalog/infrastructure/agentPersistence'",
      ),
    ]),
  ).toContain('catalog-internal:' + ADAPTER + ' -> ' + RC + 'infrastructure/agentPersistence')
  expect(
    importViolations([
      sourceUnit(
        RC + 'infrastructure/revivedTurns.ts',
        "import type { WorkgroupTurnsOperations } from '@/modules/task-execution/public/commands'",
      ),
    ]),
  ).toContain('turn-spi:' + RC + 'infrastructure/revivedTurns.ts')
  for (const target of [
    '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver',
    '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations',
  ]) {
    const file = TE + 'composition/revived.ts'
    expect(importViolations([sourceUnit(file, `import { x } from '${target}'`)])).toContain(
      'deleted-reference:' + file,
    )
  }
})
