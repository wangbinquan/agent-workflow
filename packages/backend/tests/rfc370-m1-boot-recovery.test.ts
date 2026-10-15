import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  nodeRuns,
  nodeRunEvents,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import {
  createTaskExecutionPersistence,
  createRuntimeSessionLeaseOperations,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createProcessEffectAttemptObserver } from '@/modules/task-execution/application/processEffectObserver'
import { createHostedProcessEffectProjection } from '@/modules/task-execution/infrastructure/crewstation/processEffectProjection'
import { createHostedBootRecovery } from '@/modules/task-execution/infrastructure/crewstation/bootRecovery'
import { createHostedExecutionStore } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import type { HostedExecution } from '@/modules/task-execution/infrastructure/crewstation/execution'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import { createExclusiveDaemonLockProof } from '@/modules/task-execution/domain/ownership'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

const snapshot = JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] })
const lease = { epoch: 2, leaseId: 'lease-new', instanceId: 'daemon-new' }
const proof = createExclusiveDaemonLockProof({
  daemonGeneration: lease.instanceId,
  acquiredAt: Date.now(),
  lockReceiptDigest: 'a'.repeat(64),
})
const terminal = {
  exitCode: 0,
  reason: 'completed',
  stdout: '',
  stderr: '',
  truncated: false,
  finalCursor: 'terminal',
}

describeEachProvider('RFC-370 hosted successor recovery', (harness) => {
  async function fixture(withBinding = true) {
    const db = harness.db
    await db.insert(workflows).values({
      id: 'workflow',
      name: 'hosted',
      definition: snapshot,
      version: 1,
      schemaVersion: 2,
    })
    await db.insert(tasks).values({
      id: 'task',
      name: 'hosted',
      workflowId: 'workflow',
      workflowSnapshot: snapshot,
      workflowVersion: 1,
      repoPath: 'cs-workspace:task/repos/repo',
      worktreePath: 'cs-workspace:task/worktrees/task',
      baseBranch: 'main',
      branch: 'aw/task',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      executionLineageId: 'task',
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: 'task', workflowRevision: 1 },
      ]),
    })
    await db.insert(nodeRuns).values([
      {
        id: 'wrapper',
        taskId: 'task',
        nodeId: 'git',
        status: 'running',
        startedAt: Date.now(),
        wrapperProgressJson: '{"kind":"git","baseline":"commit","phase":"inner-running"}',
      },
      {
        id: 'run',
        taskId: 'task',
        nodeId: 'agent',
        status: 'running',
        containerRunId: 'wrapper',
        startedAt: Date.now(),
        envelopeNonce: 'original-nonce',
      },
    ])
    const persistence = createTaskExecutionPersistence(db)
    await persistence.intents.submit({
      intentId: 'intent',
      request: {
        taskId: 'task',
        kind: 'launch',
        source: 'rest',
        actorUserId: 'actor',
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: 'task',
          continuationSlotKey: 'task:root',
          slotPath: [
            { stableNodeKey: 'task-root', frozenOccurrenceKey: 'task', workflowRevision: 1 },
          ],
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
    })
    const previous = createProviderTaskExecutionModule({
      daemonGeneration: 'daemon-old',
      persistence,
    })
    const claimed = await previous.claimPersisted({ intentId: 'intent' })
    previous.claimGate.leave(claimed.permit)
    const context = createTaskExecutionContext({
      intentId: 'intent',
      token: claimed.token,
      persistence,
    })
    const control = createDatabaseHostedExecutionControl({ db })
    await control.write({
      epoch: lease.epoch,
      owner: lease.instanceId,
      leaseId: lease.leaseId,
      phase: 'preparing',
      expiresAt: Date.now() + 60_000,
    })
    await control.write({
      epoch: lease.epoch,
      owner: lease.instanceId,
      leaseId: lease.leaseId,
      phase: 'active',
      expiresAt: Date.now() + 60_000,
    })
    const fence: CrewStationMutationFence = {
      current: () => lease,
      assertHeld: (tx, value) => control.assertHeld(tx, value),
    }
    const store = createHostedExecutionStore({ db, fence })
    const observer = createProcessEffectAttemptObserver({
      persistence: persistence.effects,
      context,
      taskId: 'task',
      nodeRunId: 'run',
      processKind: 'agent',
      projection: createHostedProcessEffectProjection({
        db,
        fence,
        request: {},
        writerWorkspace: 'cs-workspace:task/worktrees/task',
      }),
    })!
    await observer.beforeSpawn()
    if (withBinding)
      await store.prepare({
        executionId: 'agent:task:run',
        taskId: 'task',
        nodeRunId: 'run',
        businessTaskId: 'parent',
        requestKey: 'stable',
        request: { kind: 'agent', name: 'agent', agentProfileId: 'profile', prompt: 'original' },
      })
    const adopting = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    let adopted = 0
    const executions: HostedExecution = {
      find: store.get,
      run: async () => {
        throw new Error('recovery must adopt the existing execution')
      },
      cancel: async () => {
        throw new Error('recovery must retain the execution')
      },
      async adopt(executionId, sink) {
        adopted += 1
        adopting.resolve()
        const binding = await store.accepted(executionId, {
          id: 'subtask',
          taskId: 'parent',
          kind: 'agent',
          attempt: 1,
          state: 'running',
          executionId: 'remote',
        })
        await sink.started(binding)
        await finish.promise
        await store.checkpoint(executionId, terminal.finalCursor, terminal)
        return {
          binding,
          result: terminal,
          timedOut: false,
          settle: () => store.settle(executionId),
        }
      },
    }
    const recovery = createHostedBootRecovery({ db, fence, executions, store, proof: () => proof })
    const family = recovery.factory.create({
      persistence,
      lockProof: proof,
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
      log: createLogger('hosted-recovery-test'),
    })
    return { family, recovery, persistence, context, adopting, finish, adopted: () => adopted }
  }

  test('a running remote writer is retained until its result, then original node and wrapper resume', async () => {
    const f = await fixture()
    expect((await f.family.prepare()).revokedTaskIds).toEqual(['task'])
    const reaping = f.family.reap()
    await f.adopting.promise
    expect(
      (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run')))[0]?.status,
    ).toBe('running')
    f.finish.resolve()
    const reaped = await reaping
    const repaired = await f.family.repair(reaped.reapRef)
    const finalized = await f.family.finalize(repaired.finalizationRef)
    expect(finalized.releasedTaskIds).toEqual(['task'])
    expect(f.adopted()).toBe(1)
    expect(f.recovery.recoveredTaskIds()).toEqual(['task'])
    const run = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run')))[0]!
    expect(run).toMatchObject({
      id: 'run',
      status: 'pending',
      containerRunId: 'wrapper',
      envelopeNonce: 'original-nonce',
      pid: null,
    })
    expect(
      await f.persistence.wrapperRuns.findResumable({
        taskId: 'task',
        nodeId: 'git',
        containerRunId: null,
        iteration: 0,
      }),
    ).toMatchObject({ id: 'wrapper' })
    expect((await harness.db.select().from(taskExecutionEffectAttempts))[0]).toMatchObject({
      state: 'succeeded',
      applicationEvidence: 'applied',
    })
    expect(
      (await harness.db.select().from(taskExecutionEffectFences)).every(
        (row) => row.releasedAt !== null,
      ),
    ).toBe(true)
  })

  test('crash before binding commit proves no remote effect was submitted', async () => {
    const f = await fixture(false)
    await f.family.prepare()
    const reaped = await f.family.reap()
    const repaired = await f.family.repair(reaped.reapRef)
    const finalized = await f.family.finalize(repaired.finalizationRef)
    expect(finalized.releasedTaskIds).toEqual(['task'])
    expect(f.adopted()).toBe(0)
    expect((await harness.db.select().from(taskExecutionEffectAttempts))[0]).toMatchObject({
      state: 'failed-not-applied',
      applicationEvidence: 'definitely-not-applied',
    })
  })

  test('replayed node events are committed once and ordinary native events retain their semantics', async () => {
    const f = await fixture(false)
    const event = {
      ts: Date.now(),
      kind: 'text' as const,
      payload: '{"text":"one"}',
      sourceKey: 'agent:task:run:c1',
    }
    const append = () =>
      f.persistence.nodeExecution.appendEvents({
        nodeRunId: 'run',
        executionContext: f.context,
        events: [event],
      })
    await append()
    await append()
    await f.persistence.nodeExecution.appendEvents({
      nodeRunId: 'run',
      executionContext: f.context,
      events: [{ ts: Date.now(), kind: 'text', payload: 'native' }],
    })
    expect((await harness.db.select().from(nodeRunEvents)).map((row) => row.payload)).toEqual([
      event.payload,
      'native',
    ])
  })
})
