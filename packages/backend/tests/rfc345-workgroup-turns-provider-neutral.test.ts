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
  // RFC-359 W4-D19c：两个 provider 用同一份持久化适配器 + 同一份装配；SQLite 那层 legacy 薄壳已退役。
  const persistence = source(
    'src/modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts',
  )
  const composition = source('src/modules/resource-catalog/composition/workgroupTurns.ts')

  test('both providers implement the one authoritative TaskExecution public contract', () => {
    expect(publicCommands).toContain('export interface WorkgroupTurnsOperations')
    expect(publicCommands).toContain('export interface WorkgroupHostLedgerParticipantInTx')
    expect(driver).toContain('): WorkgroupTurnsOperations')
    expect(driver).toContain("from '@/modules/task-execution/public/commands'")
    expect(persistence).toContain('export function createWorkgroupTurnsPersistenceOperations(')
    expect(persistence).toContain('): WorkgroupTurnsOperations')
    expect(persistence).toContain("from '@/modules/task-execution/public/commands'")
    // legacy 的 SQLite 薄壳（套在 legacy engine 上的那份）已删除。
    expect(() =>
      source('src/modules/task-execution/infrastructure/sqliteWorkgroupTurnsOperations.ts'),
    ).toThrow()
    expect(() =>
      source('src/modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts'),
    ).toThrow()
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

  test('目录侧适配器只碰自己的快照，并共享同一笔预留事务', () => {
    for (const table of [
      'agents',
      'workgroupTaskState',
      'workgroupAssignments',
      'workgroupMessages',
      'workgroupMemberCursors',
    ]) {
      expect(persistence).toContain(table)
    }
    expect(persistence).toContain('WorkgroupRuntimeConfigSchema.safeParse')
    expect(persistence).toContain('agentFromPersistenceRow')
    expect(persistence).toContain('renderAgentCapabilityCard')
    expect(persistence).toContain('runResourceCatalogTransaction')
    expect(persistence).toContain('for (const operation of input.operations)')
    expect(persistence).toContain('dependencies.hostLedgerFactory.inTransaction(transaction)')
    expect(persistence).toContain('hostLedger.load(taskId)')
    expect(persistence).toContain('await hostLedger.apply({')
    // 「游标只前进不后退」按方言取 GREATEST / max，走能力矩阵而不是写死一个方言的关键字。
    expect(persistence).toContain('engine.greatest(')
    expect(persistence).toContain('returning({ id: workgroupAssignments.id })')
    expect(persistence).toContain('returning({ taskId: workgroupTaskState.taskId })')
    expect(persistence).not.toMatch(/\btasks\b|\bnodeRuns\b|\bclarifyRounds\b/)
    expect(persistence).not.toMatch(
      /@\/services\/|\/legacy\/|@\/modules\/task-execution\/(?:application|infrastructure)\/|createSqlite|\bDbClient\b|\bDbTxSync\b|bun:sqlite|PostgresqlDatabaseClient| as unknown/,
    )
  })

  test('composition binds the TaskExecution participant to the RC-reserved transaction', () => {
    expect(composition).toContain('hostLedgerFactory: WorkgroupHostLedgerParticipantFactory')
    expect(composition).toContain('createWorkgroupTurnsPersistenceOperations({')
    expect(composition).toContain(
      'inTransaction: (transaction) => hostLedgerFactory.inTransaction(transaction)',
    )
    expect(composition).not.toMatch(/@\/services\/|\/legacy\/| as unknown| as Postgresql/)
  })

  test('Resource Catalog does not introduce a second public workgroup-turn contract', () => {
    const participants = source('src/modules/resource-catalog/public/participants.ts')
    expect(participants).not.toContain('WorkgroupTurnsDriverPort')
    expect(participants).not.toContain('WorkgroupTurnLedgerDriver')
  })
})
