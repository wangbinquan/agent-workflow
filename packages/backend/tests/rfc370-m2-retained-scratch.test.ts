import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { composeCrewStationIntentScratchStore } from '@/modules/intent/composition/crewstationScratch'
import { composeIntentMaintenanceCommandsForDatabase } from '@/modules/intent/composition/maintenance'
import { createHostedExecutionStore } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import { createHostedExecution } from '@/modules/task-execution/infrastructure/crewstation/execution'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 retained scratch and remote writers', (harness) => {
  test('retention waits for remote cleanup ACK and leaves failed or running turns retained', async () => {
    const { users, intentSessions, intentTurns } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: 'owner',
      username: 'owner',
      displayName: 'Owner',
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    await insertOne(harness.db, intentSessions, {
      id: 'session',
      ownerUserId: 'owner',
      title: 'Scratch',
      createdAt: 1,
      updatedAt: 1,
    })
    await harness.db.insert(intentTurns).values([
      {
        id: 'done',
        sessionId: 'session',
        seq: 1,
        role: 'agent',
        kind: 'error',
        scratchRetained: true,
        createdAt: 1,
      },
      {
        id: 'unknown',
        sessionId: 'session',
        seq: 2,
        role: 'agent',
        kind: 'error',
        scratchRetained: true,
        createdAt: 1,
      },
      {
        id: 'running',
        sessionId: 'session',
        seq: 3,
        role: 'agent',
        kind: 'running',
        scratchRetained: true,
        createdAt: 1,
      },
    ])
    const removed: string[] = []
    const scratch = composeCrewStationIntentScratchStore({
      db: harness.db,
      remove: async (id) => {
        if (id === 'unknown') throw new Error('remote writer unknown')
        removed.push(id)
      },
    })
    const commands = composeIntentMaintenanceCommandsForDatabase({
      db: harness.db,
      appHome: 'unused',
      pluginsDir: 'unused',
      scratchDirectoryName: 'unused',
      scratch,
      resourcePackages: { converge: async () => ({ failed: 0, rolledForward: 0 }) },
    })
    expect(await commands.scratch.sweep({ retentionHours: 24, now: 86_400_100 })).toEqual({
      removed: 1,
    })
    expect(removed).toEqual(['done'])
    expect(
      (await harness.db.select().from(intentTurns).where(eq(intentTurns.id, 'done')))[0]!
        .scratchRetained,
    ).toBe(false)
    for (const id of ['unknown', 'running'])
      expect(
        (await harness.db.select().from(intentTurns).where(eq(intentTurns.id, id)))[0]!
          .scratchRetained,
      ).toBe(true)
    await expect(scratch.remove('running')).rejects.toThrow('turn-running')
  })

  test('one settled invocation cannot release a scope still used by another remote invocation', async () => {
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => undefined,
    }
    const store = createHostedExecutionStore({ db: harness.db, fence })
    const executions = createHostedExecution({
      store,
      fence,
      workspaceTaskId: async () => 'parent',
      api: new Proxy({} as CrewStationBusinessExecution, {
        get() {
          throw new Error('no platform action expected')
        },
      }),
    })
    const prepare = (id: string, cwd: string) =>
      store.prepare({
        executionId: id,
        taskId: 'system:intent',
        businessTaskId: 'parent',
        requestKey: id,
        request: { kind: 'command', name: id, argv: ['check'], cwd },
      })
    const finish = (id: string) =>
      store.record(id, {
        taskId: 'parent',
        subtaskId: id,
        attempt: 1,
        cursor: 'done',
        sourceEventId: 'done',
        occurredAt: new Date(0).toISOString(),
        type: 'result',
        data: {
          exitCode: 0,
          reason: 'completed',
          stdout: '',
          stderr: '',
          truncated: false,
          finalCursor: 'done',
        },
      })
    await prepare('first', '/work/system/intent/scope/worktree')
    await prepare('second', '/work/system/intent/scope/run')
    await prepare('unrelated', '/work/system/intent/other/worktree')
    await finish('first')
    await store.settle('first')
    expect(await executions.workspaceSettled('system:intent', '/work/system/intent/scope')).toBe(
      false,
    )
    await finish('second')
    await store.settle('second')
    expect(await executions.workspaceSettled('system:intent', '/work/system/intent/scope')).toBe(
      true,
    )
    await prepare('root-command', '/work')
    expect(await executions.workspaceSettled('system:intent', '/work/system/intent/scope')).toBe(
      false,
    )
  })
})
