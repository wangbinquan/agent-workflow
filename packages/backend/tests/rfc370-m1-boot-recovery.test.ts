import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'
// RFC-370 §9.2 V1 — hosted boot recovery never waits on the platform. A remote
// execution outlives the service process that started it: boot hands its open
// process effect off, interrupts orphans exactly as standalone does, and puts
// the unsettled run back to `pending` under its ORIGINAL id so the scheduler
// adopts the same platform subtask instead of paying for a second model call.
// The earlier shape (adopt-and-wait inside `reap`) blocked activation on a
// running model call and crash-looped on a 410/gap; these cases lock that out.
import {
  nodeRunFixture,
  patchNodeRunFixture,
  taskFixture,
  workflowFixture,
  readNodeRunFixtures,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
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

describeEachProvider('RFC-370 hosted boot recovery hands remote work off', (harness) => {
  async function fixture(options: { binding?: boolean; runStatus?: 'running' | 'done' } = {}) {
    const db = harness.db
    const { runtimeSessionLeases } = tablesOf(db)
    await workflowFixture(db, {
      id: 'workflow',
      name: 'hosted',
      definition: snapshot,
      version: 1,
      schemaVersion: 2,
    })
    await taskFixture(db, {
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
    await nodeRunFixture(db, [
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
        status: options.runStatus ?? 'running',
        containerRunId: 'wrapper',
        startedAt: Date.now(),
        envelopeNonce: 'original-nonce',
        opencodeSessionId: 'session',
        ...(options.runStatus === 'done' ? { finishedAt: Date.now() } : {}),
      },
    ])
    await insertOne(db, runtimeSessionLeases, {
      protocol: 'opencode',
      sessionId: 'session',
      taskId: 'task',
      nodeId: 'agent',
      createdNodeRunId: 'run',
      leaseNodeRunId: 'run',
      leaseNonceDigest: 'b'.repeat(64),
      leasedAt: 1,
    })
    const persistence = createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
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
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        epoch: lease.epoch,
        owner: lease.instanceId,
        leaseId: lease.leaseId,
        phase,
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
    if (options.binding !== false)
      await store.prepare({
        executionId: 'agent:task:run',
        taskId: 'task',
        nodeRunId: 'run',
        businessTaskId: 'parent',
        requestKey: 'stable',
        request: { kind: 'agent', name: 'agent', agentProfileId: 'profile', prompt: 'original' },
      })
    const recovery = createHostedBootRecovery({ db, fence, store, proof: () => proof })
    const family = recovery.factory.create({
      persistence,
      lockProof: proof,
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
      log: createLogger('hosted-recovery-test'),
    })
    const run = async () => {
      const prepared = await family.prepare()
      const reaped = await family.reap()
      const repaired = await family.repair(reaped.reapRef)
      const finalized = await family.finalize(repaired.finalizationRef)
      return { prepared, reaped, repaired, finalized }
    }
    return { family, recovery, persistence, context, store, run }
  }
  const nodeRun = async (id: string) => {
    return (await readNodeRunFixtures(harness.db, { id }))[0]!
  }

  test('an unsettled remote execution is handed off without any platform call and keeps its original run', async () => {
    const f = await fixture()
    // No execution client is wired at all: boot cannot wait on the platform.
    const { prepared, reaped, repaired, finalized } = await f.run()
    expect(prepared.revokedTaskIds).toEqual(['task'])
    expect(reaped.counts).toEqual({ tasks: 1, runs: 2 })
    expect(repaired.leases).toBe(1)
    expect(finalized.releasedTaskIds).toEqual(['task'])
    expect(f.recovery.recoveredTaskIds()).toEqual(['task'])
    expect(await nodeRun('run')).toMatchObject({
      id: 'run',
      status: 'pending',
      containerRunId: 'wrapper',
      envelopeNonce: 'original-nonce',
      pid: null,
      finishedAt: null,
    })
    expect(
      await f.persistence.wrapperRuns.findResumable({
        taskId: 'task',
        nodeId: 'git',
        containerRunId: null,
        iteration: 0,
      }),
    ).toMatchObject({ id: 'wrapper' })
    const {
      taskExecutionEffectAttempts,
      taskExecutionEffects,
      taskExecutionEffectFences,
      runtimeSessionLeases,
    } = tablesOf(harness.db)
    const [attempt] = await harness.db.select().from(taskExecutionEffectAttempts)
    expect(attempt).toMatchObject({ state: 'succeeded', applicationEvidence: 'applied' })
    expect(JSON.parse(attempt!.receiptJson!)).toEqual({
      v: 2,
      phase: 'crewstation-handed-off',
      executionId: 'agent:task:run',
    })
    const [effect] = await harness.db.select().from(taskExecutionEffects)
    expect(effect!.state).toBe('succeeded')
    expect(finalized.recoveredProcessEffectIds).toContain(effect!.id)
    expect(
      (await harness.db.select().from(taskExecutionEffectFences)).every(
        (row) => row.releasedAt !== null,
      ),
    ).toBe(true)
    // The binding itself is untouched: the adopting run observes it.
    expect(await f.store.get('agent:task:run')).toMatchObject({
      state: 'submitting',
      cancelRequested: false,
    })
    const [sessionLease] = await harness.db.select().from(runtimeSessionLeases)
    expect(sessionLease!.leaseNodeRunId).toBeNull()
  })

  test('a crash before the binding commit proves the remote effect was never submitted', async () => {
    const f = await fixture({ binding: false })
    const { finalized } = await f.run()
    expect(finalized.releasedTaskIds).toEqual(['task'])
    expect(f.recovery.recoveredTaskIds()).toEqual([])
    const { taskExecutionEffectAttempts, taskExecutionEffects } = tablesOf(harness.db)
    const [attempt] = await harness.db.select().from(taskExecutionEffectAttempts)
    expect(attempt).toMatchObject({
      state: 'failed-not-applied',
      applicationEvidence: 'definitely-not-applied',
    })
    expect(JSON.parse(attempt!.receiptJson!).phase).toBe('crewstation-not-submitted')
    expect((await harness.db.select().from(taskExecutionEffects))[0]!.state).toBe('failed')
    // Ordinary standalone semantics: the run stays interrupted for resume/retry.
    expect((await nodeRun('run')).status).toBe('interrupted')
  })

  test('a binding restored from a database snapshot is never adopted', async () => {
    const f = await fixture()
    await f.store.requestCancel('agent:task:run', 'restored')
    await f.run()
    expect(f.recovery.recoveredTaskIds()).toEqual([])
    expect((await nodeRun('run')).status).toBe('interrupted')
    expect(await f.store.get('agent:task:run')).toMatchObject({
      cancelRequested: true,
      cancelReason: 'restored',
    })
  })

  test('a terminal run is never reset even while its binding is still unsettled', async () => {
    const f = await fixture({ runStatus: 'done' })
    const { reaped } = await f.run()
    expect(reaped.counts.runs).toBe(1)
    expect((await nodeRun('run')).status).toBe('done')
    // Nothing remote is retained for this task, so boot does not auto-resume it.
    expect(f.recovery.recoveredTaskIds()).toEqual([])
    expect((await nodeRun('wrapper')).status).toBe('interrupted')
  })

  test('a hosted orphan with a local process id is a contract violation, not a silent kill', async () => {
    const f = await fixture()
    await patchNodeRunFixture(harness.db, { id: 'run' }, { pid: 4242 })
    await f.family.prepare()
    await expect(Promise.resolve(f.family.reap())).rejects.toThrow(
      'hosted-recovery-unexpected-local-process',
    )
  })

  test('recovery references from another family are rejected', async () => {
    const f = await fixture()
    await f.family.prepare()
    await f.family.reap()
    await expect(Promise.resolve(f.family.repair({}))).rejects.toThrow(
      'hosted-recovery-reference-mismatch',
    )
    await expect(Promise.resolve(f.family.finalize({}))).rejects.toThrow(
      'hosted-recovery-reference-mismatch',
    )
  })

  test('replayed node events are committed once and ordinary native events retain their semantics', async () => {
    const f = await fixture({ binding: false })
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
    const { nodeRunEvents, hostedExecutionBindings } = tablesOf(harness.db)
    expect((await harness.db.select().from(nodeRunEvents)).map((row) => row.payload)).toEqual([
      event.payload,
      'native',
    ])
    expect(await harness.db.select().from(hostedExecutionBindings)).toEqual([])
  })
})
