// RFC-418: the provider-session background control (restartable loops, the five provider loops and the serialized
// session control) is task-execution application on its own ports; composition only binds the legacy sweeps, cadence
// constants, the file configuration source and the scheduled-task runner. Reads the production sources without
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
const CONTROL = TE + 'application/providerBackground.ts'
const PORTS = TE + 'application/ports/providerBackground.ts'
const BINDING = TE + 'composition/providerBackground.ts'
const APPLICATION_FILES = [CONTROL, PORTS]
/** Every moved symbol (and the new port / binding symbols) and its one owner. */
const OWNERS = new Map([
  ['createTaskExecutionProviderBackground', CONTROL],
  ['isPeriodicReconcileDue', CONTROL],
  ['createRestartableLoop', CONTROL],
  ['createProviderLoops', CONTROL],
  ['ProviderBackgroundModule', PORTS],
  ['ProviderBackgroundCadence', PORTS],
  ['ProviderBackgroundSweeps', PORTS],
  ['TaskExecutionProviderBackgroundPorts', PORTS],
  ['ProviderBackgroundStart', PORTS],
  ['ProviderBackgroundControl', PORTS],
  ['composeTaskExecutionProviderBackground', BINDING],
  ['TaskExecutionProviderBackgroundStartDependencies', BINDING],
  ['TaskExecutionProviderBackgroundControl', BINDING],
])
/** Loop and session-control steps the binding no longer contains. */
const FLOW_TOKENS = [
  'setTimeout(',
  'createRestartableLoop',
  'isPeriodicReconcileDue',
  'startupRun',
  'lastReconcileAt',
  'autoResumeOnBoot',
  'scheduledTasksEnabled',
  'autoKillStalledChild',
  'drainTickets',
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

/** A loop or session-control step written in the binding. */
function shapeViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units)
    if (unit.path === BINDING)
      for (const token of FLOW_TOKENS)
        if (unit.text.includes(token)) found.push('binding-flow:' + token)
  return found.sort()
}

/** The application files import neither infrastructure, composition nor legacy services. */
function importViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const edge of createGateCorpus(units).edges) {
    const from = edge.from.path
    if (!APPLICATION_FILES.includes(from)) continue
    const layer = /\/modules\/[^/]+\/(infrastructure|composition)(?:\/|\.|$)/.exec(edge.target)?.[1]
    if (layer !== undefined) found.push(`${layer}-import:` + from + ' -> ' + edge.target)
    if (edge.specifier.startsWith('@/services/'))
      found.push('legacy-import:' + from + ' -> ' + edge.specifier)
  }
  return found.sort()
}

test('live corpus: the provider background control is application; composition binds', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
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
  for (const token of FLOW_TOKENS)
    expect(shapeViolations([sourceUnit(BINDING, `const x = ${token}`)])).toContain(
      'binding-flow:' + token,
    )
  expect(shapeViolations([sourceUnit(CONTROL, 'setTimeout(run, delayMs)')])).toEqual([])
  for (const from of APPLICATION_FILES) {
    const up = from.includes('/application/ports/') ? '../../' : '../'
    for (const target of [
      up + 'infrastructure/local/fileTaskBackgroundConfiguration',
      up + 'composition/providerRuntime',
    ])
      expect(
        importViolations([sourceUnit(from, `import { x } from '${target}'`)]).some((v) =>
          /^(?:infrastructure|composition)-import:/.test(v),
        ),
        `${from} -> ${target}`,
      ).toBe(true)
    expect(
      importViolations([
        sourceUnit(from, "import { DAEMON_CADENCE } from '@/services/daemonCadence'"),
      ]),
    ).toContain('legacy-import:' + from + ' -> @/services/daemonCadence')
  }
})
