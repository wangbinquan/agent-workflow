// RFC-426: the scheduled backup has one source — the System Operations module's `scheduledBackup`, built on the
// deployment's backup coordinator. This lock pins the shape: the provider adapter table declares no scheduled backup, the
// daemon session hands the backup ticker the module participant, the ticker never snapshots SQLite itself, and the
// execution availability gate carries no deployment literal. Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const ADAPTERS = PREFIX + 'bootstrap/daemonSessionAdapters.ts'
const SESSION = PREFIX + 'bootstrap/daemonSession.ts'
const SCHEDULER = PREFIX + 'platform/background/providerBackupScheduler.ts'
const AVAILABILITY = PREFIX + 'platform/http/executionAvailability.ts'
const SESSION_WIRING = 'createScheduledBackup: application.core.systemOperations.scheduledBackup'
const DEPLOYMENT_LITERALS = new Set(['standalone', 'crewstation'])
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function memberName(node: ts.Node): string | null {
  if (
    !ts.isPropertySignature(node) &&
    !ts.isMethodSignature(node) &&
    !ts.isPropertyAssignment(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isShorthandPropertyAssignment(node)
  )
    return null
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
}

export function scheduledBackupSourceViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const adapters = byPath.get(ADAPTERS)
  if (adapters !== undefined)
    walk(adapters.source, (node) => {
      if (memberName(node) === 'scheduledBackup') found.add('adapter-table-scheduled-backup')
    })
  const scheduler = byPath.get(SCHEDULER)
  if (scheduler !== undefined)
    walk(scheduler.source, (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(scheduler.source) === 'createBackup')
        found.add('scheduler-creates-backup')
      if (
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'BackupSchedulerOptions' &&
        node.members.some((member) => memberName(member) === 'db')
      )
        found.add('scheduler-db-option')
    })
  const availability = byPath.get(AVAILABILITY)
  if (availability !== undefined)
    walk(availability.source, (node) => {
      if (ts.isStringLiteralLike(node) && DEPLOYMENT_LITERALS.has(node.text))
        found.add('availability-deployment-literal')
    })
  if (!(byPath.get(SESSION)?.text ?? '').includes(SESSION_WIRING))
    found.add('session-backup-not-module')
  return [...found].sort()
}

test('live corpus: one scheduled backup source and no deployment fallback in the gate', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(scheduledBackupSourceViolations(UNITS)).toEqual([])
})

test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    scheduledBackupSourceViolations(
      replace(ADAPTERS, (text) =>
        text.replace(
          '  recoveryProofGeneration(provider: DaemonApplicationProvider<P>): string',
          '  scheduledBackup(input: object): object\n  recoveryProofGeneration(provider: DaemonApplicationProvider<P>): string',
        ),
      ),
    ),
  ).toEqual(['adapter-table-scheduled-backup'])
  expect(
    scheduledBackupSourceViolations(
      replace(SESSION, (text) =>
        text.replace(SESSION_WIRING, 'createScheduledBackup: () => adapter.backup()'),
      ),
    ),
  ).toEqual(['session-backup-not-module'])
  expect(
    scheduledBackupSourceViolations(
      replace(SCHEDULER, (text) =>
        text.replace(
          'export interface BackupSchedulerOptions {',
          'export interface BackupSchedulerOptions {\n  db?: object',
        ),
      ),
    ),
  ).toEqual(['scheduler-db-option'])
  expect(
    scheduledBackupSourceViolations(
      replace(
        AVAILABILITY,
        (text) => text + "\nexport const fallback = { mode: 'standalone', state: 'active' }\n",
      ),
    ),
  ).toEqual(['availability-deployment-literal'])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) =>
    scheduledBackupSourceViolations([sourceUnit(path, text)])
  expect(
    only(ADAPTERS, 'export const table = { sqlite: { scheduledBackup: ({ db }) => ({ db }) } }'),
  ).toContain('adapter-table-scheduled-backup')
  expect(
    only(SCHEDULER, "export async function tick() { await createBackup({ kind: 'scheduled' }) }"),
  ).toContain('scheduler-creates-backup')
  expect(only(SCHEDULER, 'export interface BackupSchedulerOptions { db: object }')).toContain(
    'scheduler-db-option',
  )
  expect(
    only(AVAILABILITY, "export const read = () => ({ mode: 'crewstation', state: 'active' })"),
  ).toContain('availability-deployment-literal')
  expect(only(SESSION, 'startBackupScheduler({ ...adapter.scheduledBackup() })')).toContain(
    'session-backup-not-module',
  )
})
