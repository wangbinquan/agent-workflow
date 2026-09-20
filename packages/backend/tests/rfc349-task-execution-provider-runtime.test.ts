import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { REPAIR_OPTION_IDS } from '@agent-workflow/shared'

const backend = resolve(import.meta.dir, '..', 'src')
const read = (path: string): string => readFileSync(resolve(backend, path), 'utf8')

describe('RFC-349 TaskExecution selected-provider runtime', () => {
  test('PostgreSQL repair owns the complete option matrix without SQLite or Collaboration rows', () => {
    const source = read('modules/task-execution/infrastructure/taskRouteRepairOperations.ts')

    for (const ids of Object.values(REPAIR_OPTION_IDS)) {
      for (const id of ids) expect(source).toContain(`'${id}'`)
    }
    expect(source).toContain('createTaskRouteRepairOperations')
    expect(source).toContain('ClarifyRepairParticipant')
    expect(source).toContain('ReviewRepairParticipant')
    expect(source).toContain('CollaborationRuntimeMechanics')
    expect(source).not.toContain("from '@/db/client'")
    expect(source).not.toContain('clarifyRounds')
    expect(source).not.toContain('docVersions')
    expect(source).not.toContain('sqlite')
  })

  test('route composition constructs the owner-native repair face instead of accepting one', () => {
    // RFC-359 AC-1（第 13 刀）改锚：本条钉的是**装配**（工厂自己造修复面，而不是收一个进来）。
    // 两个 provider 绑定合成一个中立工厂之后，装配就住在共用实现里——两个引擎共用这一条。
    const source = read('modules/task-execution/infrastructure/taskRouteOperations.ts')
    expect(source).toContain('createTaskRouteRepairOperations({')
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

  test('task transport fails closed when any selected-provider dependency is absent', () => {
    const route = read('routes/tasks.ts')
    for (const code of [
      'task-route-operations-not-composed',
      'task-recovery-operations-not-composed',
      'task-code-workspace-not-composed',
      'task-workspace-queries-not-composed',
      'task-repository-workspace-not-composed',
      'task-change-narrative-not-composed',
    ]) {
      expect(route).toContain(`throw new Error('${code}')`)
    }
  })

  test('workgroup host ledger delegates Collaboration projection on the reserved transaction', () => {
    const adapter = read('modules/task-execution/infrastructure/workgroupHostLedgerParticipant.ts')
    const composition = read('modules/task-execution/composition/workgroupHostLedger.ts')

    expect(adapter).toContain('WorkgroupTaskRoomClarifyParticipantInTx')
    expect(adapter).toContain('clarify.loadProjection(taskId)')
    expect(adapter).not.toContain('clarifyRounds')
    expect(composition).toContain('input.collaboration.inTransaction(transaction)')
  })

  // RFC-359 AC-1（第 12 刀）：参与者已合一成一份中立实现，两个组合根绑各自的端口。
  // 这条判据原本读 PG 那份适配器，现在读合一后的那一份——铸造机由谁选、工作组资源面从哪来，
  // 两个引擎问的是同一份源码。
  test('child launch is owner-native and selected inside the shared participant factory', () => {
    const adapter = read('modules/task-execution/infrastructure/childExecutionLaunchOperations.ts')
    const participants = read(
      'modules/task-execution/infrastructure/taskExecutionRuntimeParticipants.ts',
    )
    const provider = read('modules/task-execution/composition/providerRuntime.ts')
    const port = read('modules/task-execution/application/ports/childExecutionLaunchOperations.ts')

    expect(adapter).toContain('createChildExecutionLaunchOperations')
    expect(adapter).toContain('withSerializableTaskExecution')
    for (const write of [
      'tx.insert(tasks)',
      'tx.insert(taskRepos)',
      'tx.insert(taskExecutionIntents)',
      'tx.insert(workgroupTaskState)',
      'appendTaskCreatedCommittedEvent',
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
    expect(participants).toContain('createChildExecutionLaunchOperations({')
    expect(participants).toContain('childLaunchWorkgroup: ChildWorkgroupLaunchResources')
    expect(participants).not.toContain('readonly childLaunch: ChildExecutionLaunchOperations')
    expect(provider).toContain('childLaunchWorkgroup: dependencies.routeLaunch.workgroup')
  })
})
