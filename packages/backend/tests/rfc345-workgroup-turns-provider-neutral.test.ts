import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backendRoot = resolve(import.meta.dir, '..')

function source(path: string): string {
  return readFileSync(resolve(backendRoot, path), 'utf8')
}

describe('RFC-345/349 provider-neutral workgroup turn ledger', () => {
  const publicCommands = source('src/modules/task-execution/public/commands.ts')
  const driver = source(
    'src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
  )
  const postgresql = source(
    'src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts',
  )
  const composition = source('src/modules/resource-catalog/composition/workgroupTurns.ts')
  const sqlite = source(
    'src/modules/task-execution/infrastructure/sqliteWorkgroupTurnsOperations.ts',
  )

  test('both providers implement the one authoritative TaskExecution public contract', () => {
    expect(publicCommands).toContain('export interface WorkgroupTurnsOperations')
    expect(publicCommands).toContain('export interface WorkgroupHostLedgerParticipantInTx')
    expect(driver).toContain('): WorkgroupTurnsOperations')
    expect(driver).toContain("from '@/modules/task-execution/public/commands'")
    expect(postgresql).toContain('export function createPostgresqlWorkgroupTurnsOperations(')
    expect(postgresql).toContain('): WorkgroupTurnsOperations')
    expect(postgresql).toContain("from '@/modules/task-execution/public/commands'")
    expect(sqlite).toContain('export function createSqliteWorkgroupTurnsOperations(')
    expect(sqlite).toContain('): WorkgroupTurnsOperations')
  })

  test('application driver owns the complete closed ledger surface without database shapes', () => {
    for (const operation of [
      'ensure-task-state',
      'seed-goal-if-empty',
      'mint-host-run',
      'stamp-host-run-round',
      'transition-assignment',
      'repoint-assignment-run',
      'create-assignment',
      'create-message',
      'advance-member-cursor',
      'transition-gate',
      'set-pause-reason',
      'set-dynamic-workflow-state',
      'stamp-result-anchor',
    ]) {
      expect(driver).toContain(`'${operation}'`)
    }
    for (const turn of [
      'driveLeaderTurn',
      'driveAssignmentTurn',
      'driveBatchTurn',
      'driveMessageTurn',
      'driveAdoptedRun',
      'reconcileRunningAssignments',
      'openCompletionGate',
      'finalizeDone',
    ]) {
      expect(driver).toContain(`function ${turn}`)
    }
    expect(driver).toContain('createWorkgroupTurnsOperations(')
    expect(driver).toContain('Promise.race(inflight.values())')
    expect(driver).toContain('leaderClarifyParked')
    expect(driver).toContain('resolveCompletionGate(')
    expect(driver).toContain('getCanonicalFilesChanged')
    expect(driver).not.toMatch(/@\/db\/|drizzle-orm|DbClient|DbTxSync|bun:sqlite/)
  })

  test('PostgreSQL adapter owns only RC snapshots and shares one reserved transaction', () => {
    for (const table of [
      'agents',
      'workgroupTaskState',
      'workgroupAssignments',
      'workgroupMessages',
      'workgroupMemberCursors',
    ]) {
      expect(postgresql).toContain(table)
    }
    expect(postgresql).toContain('WorkgroupRuntimeConfigSchema.safeParse')
    expect(postgresql).toContain('agentFromPersistenceRow')
    expect(postgresql).toContain('renderAgentCapabilityCard')
    expect(postgresql).toContain('runPostgresqlResourceCatalogTransaction')
    expect(postgresql).toContain('for (const operation of input.operations)')
    expect(postgresql).toContain('dependencies.hostLedgerFactory.inTransaction(transaction)')
    expect(postgresql).toContain('hostLedger.load(taskId)')
    expect(postgresql).toContain('await hostLedger.apply({')
    expect(postgresql).toContain('GREATEST(')
    expect(postgresql).toContain('returning({ id: workgroupAssignments.id })')
    expect(postgresql).toContain('returning({ taskId: workgroupTaskState.taskId })')
    expect(postgresql).not.toMatch(/\btasks\b|\bnodeRuns\b|\bclarifyRounds\b/)
    expect(postgresql).not.toMatch(
      /@\/services\/|\/legacy\/|@\/modules\/task-execution\/(?:application|infrastructure)\/|createSqlite|\bDbClient\b|\bDbTxSync\b|bun:sqlite| as unknown| as Postgresql/,
    )
  })

  test('composition binds the TaskExecution participant to the RC-reserved transaction', () => {
    expect(composition).toContain(
      'hostLedgerFactory: PostgresqlWorkgroupHostLedgerParticipantFactory',
    )
    expect(composition).toContain('createPostgresqlWorkgroupTurnsOperations({')
    expect(composition).toContain(
      'inTransaction: (transaction) => hostLedgerFactory.inTransaction(transaction)',
    )
    expect(composition).not.toMatch(
      /@\/services\/|\/legacy\/|@\/modules\/task-execution\/(?:application|composition|infrastructure)\/| as unknown| as Postgresql/,
    )
  })

  test('Resource Catalog does not introduce a second public workgroup-turn contract', () => {
    const participants = source('src/modules/resource-catalog/public/participants.ts')
    expect(participants).not.toContain('WorkgroupTurnsDriverPort')
    expect(participants).not.toContain('WorkgroupTurnLedgerDriver')
  })
})
