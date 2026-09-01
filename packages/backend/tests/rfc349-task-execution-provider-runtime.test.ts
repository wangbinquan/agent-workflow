import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { REPAIR_OPTION_IDS } from '@agent-workflow/shared'

const backend = resolve(import.meta.dir, '..', 'src')
const read = (path: string): string => readFileSync(resolve(backend, path), 'utf8')

describe('RFC-349 TaskExecution selected-provider runtime', () => {
  test('PostgreSQL repair owns the complete option matrix without SQLite or Collaboration rows', () => {
    const source = read(
      'modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations.ts',
    )

    for (const ids of Object.values(REPAIR_OPTION_IDS)) {
      for (const id of ids) expect(source).toContain(`'${id}'`)
    }
    expect(source).toContain('createPostgresqlTaskRouteRepairOperations')
    expect(source).toContain('ClarifyRepairParticipant')
    expect(source).toContain('ReviewRepairParticipant')
    expect(source).toContain('CollaborationRuntimeMechanics')
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain('clarifyRounds')
    expect(source).not.toContain('docVersions')
    expect(source).not.toContain('sqlite')
  })

  test('route composition constructs the owner-native repair face instead of accepting one', () => {
    const source = read('modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts')
    expect(source).toContain('createPostgresqlTaskRouteRepairOperations({')
    expect(source).toContain('repairOptions: (input) => repairs.repairOptions(input)')
    expect(source).toContain('applyRepair: (input) => repairs.applyRepair(input)')
    expect(source).not.toContain('dependencies.repairs')
    expect(source).not.toContain('@/platform/persistence/sqlite')
  })

  test('provider session owns restartable task writers and late route composition', () => {
    const provider = read('modules/task-execution/composition/providerRuntime.ts')
    const background = read('modules/task-execution/composition/providerBackground.ts')

    expect(provider).toContain('routes: (')
    expect(provider).toContain('TaskExecutionProviderRouteContext')
    expect(provider).toContain('createPostgresqlClarifyRepairParticipant(db)')
    expect(provider).toContain('createPostgresqlReviewRepairParticipant(db)')
    expect(provider).toContain('composeTaskExecutionProviderBackground({')

    for (const loop of ['auto-repair', 'heartbeat-kill', 'orphan-reconcile', 'scheduled-task']) {
      expect(background).toContain(`name: '${loop}'`)
    }
    expect(background).toContain('await Promise.all(loops.map((loop) => loop.pause()))')
    expect(background).toContain('runtime.module.pause(')
    expect(background).toContain('await Promise.all(loops.map((loop) => loop.stop()))')
    expect(background).toContain('runtime.module.dispose(')
    expect(background).not.toContain('void runDueSchedulesOnce')
  })

  test('workgroup host ledger delegates Collaboration projection on the reserved transaction', () => {
    const adapter = read(
      'modules/task-execution/infrastructure/postgresqlWorkgroupHostLedgerParticipant.ts',
    )
    const composition = read('modules/task-execution/composition/workgroupHostLedger.ts')

    expect(adapter).toContain('WorkgroupTaskRoomClarifyParticipantInTx')
    expect(adapter).toContain('clarify.loadProjection(taskId)')
    expect(adapter).not.toContain('clarifyRounds')
    expect(composition).toContain('input.collaboration.inTransaction(transaction)')
  })

  test('PostgreSQL child launch is owner-native and selected inside the provider aggregate', () => {
    const adapter = read(
      'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts',
    )
    const participants = read(
      'modules/task-execution/infrastructure/postgresqlTaskExecutionRuntimeParticipants.ts',
    )
    const provider = read('modules/task-execution/composition/providerRuntime.ts')
    const port = read('modules/task-execution/application/ports/childExecutionLaunchOperations.ts')

    expect(adapter).toContain('createPostgresqlChildExecutionLaunchOperations')
    expect(adapter).toContain('withPostgresqlSerializableTaskExecution')
    for (const write of [
      'tx.insert(tasks)',
      'tx.insert(taskRepos)',
      'tx.insert(taskExecutionIntents)',
      'tx.insert(workgroupTaskState)',
      'appendPostgresqlTaskCreatedTx',
    ]) {
      expect(adapter).toContain(write)
    }
    expect(adapter).toContain('await publishCommittedEventsAfterCommit')
    expect(adapter).toContain("completionMode: 'background'")
    expect(adapter).toContain('dependencies.workgroup.loadExistingAgentIds')
    expect(adapter).toContain('dependencies.workgroup.integrity.assertUsable')
    expect(adapter).toContain('dependencies.workgroup.ensureHostWorkflow')
    expect(adapter).not.toContain('StartTaskSchema.parse')
    expect(adapter).not.toContain("from '@/db/client'")
    expect(adapter).not.toContain('createSqliteChildExecutionLaunchOperations')
    expect(port).toContain('readonly frozenWorkflowVersion: number')
    expect(participants).toContain('createPostgresqlChildExecutionLaunchOperations({')
    expect(participants).toContain('childLaunchWorkgroup: PostgresqlChildWorkgroupLaunchResources')
    expect(participants).not.toContain('readonly childLaunch: ChildExecutionLaunchOperations')
    expect(provider).toContain('childLaunchWorkgroup: dependencies.routeLaunch.workgroup')
  })
})
