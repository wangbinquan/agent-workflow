// RFC-359 W12: run these user-visible atom predicates against both existing
// participants before extracting their duplicated per-target implementation.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEvents,
  nodeRuns,
  taskExecutionIntents,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import type { TaskSourceTerminationEffectInput } from '@/modules/task-execution/application/applySourceTerminationEffect'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { taskExecutionModule } from '@/modules/task-execution/composition'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { createPostgresqlTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/sqliteSourceTerminationParticipant'
import { applySourceTerminationTarget } from '@/modules/task-execution/infrastructure/sourceTerminationTarget'
import {
  DrizzleTaskRuntimeLifecyclePersistence,
  writeTaskRuntimeLifecycleInTx,
} from '@/modules/task-execution/infrastructure/taskRuntimeLifecyclePersistence'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { __hasTaskReviewMutationQueueForTesting } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const BINDING = 'gitlab:rfc359/atom!7'
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
const restores: Array<() => void> = []

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  registerAfterCommitEventPump(null)
  registerTerminalWorkspacePrunePolicy(null)
  taskExecutionModule.resetForTesting()
})

function effect(kind: TaskSourceTerminationEffectInput['kind'] = 'fence-closed') {
  return {
    effectId: 'effect-atom',
    deliveryId: 'delivery-atom',
    binding: BINDING,
    streamRevision: 5,
    kind,
  }
}

async function apply(harness: ProviderHarness, input = effect()) {
  const participant =
    harness.capabilities.isolation === 'exclusive'
      ? createTaskSourceTerminationParticipant(harness.db as unknown as DbClient)
      : createPostgresqlTaskSourceTerminationParticipant(
          harness.db as unknown as PostgresqlDatabaseClient,
        )
  return await participant.apply(mintSourceTerminationEffectCapability(input), input)
}

async function seed(
  db: ProviderNeutralDatabase,
  overrides: Partial<typeof tasks.$inferInsert> = {},
) {
  const taskId = `atom-${ulid()}`
  const nodeRunId = `run-${taskId}`
  const intentId = `intent-${taskId}`
  const slotPath = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ])
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-atom',
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 50,
    runningSince: 100,
    runningMs: 23,
    spaceKind: 'local',
    sourceTerminationBinding: BINDING,
    sourceTerminationLaunchRev: 1,
    executionLineageId: taskId,
    lineageSlotPathJson: slotPath,
    ...overrides,
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'node-open',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: 100,
    continuationSlotKey: `${taskId}:node-open`,
    operationGeneration: 0,
  })
  await db.insert(taskExecutionIntents).values({
    id: intentId,
    taskId,
    kind: 'launch',
    state: 'pending',
    source: 'rest',
    requestHash: intentId,
    payloadJson: '{}',
    executionLineageId: taskId,
    continuationSlotKey: `${taskId}:root`,
    slotPathJson: slotPath,
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: 50,
    updatedAt: 50,
  })
  const identity = createWorkerIdentity({
    ownerId: `owner-${taskId}`,
    daemonGeneration: taskExecutionModule.daemonGeneration,
  })
  const token = createOwnershipToken({
    taskId,
    identity,
    epoch: 1,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
  await db.insert(taskExecutionOwners).values({
    taskId,
    ownerId: identity.ownerId,
    daemonGeneration: identity.daemonGeneration,
    epoch: 1,
    state: 'claimed',
    leaseUntil: token.leaseUntil,
    revision: 1,
    lastHeartbeatAt: 50,
    updatedAt: 50,
  })
  return { taskId, nodeRunId, intentId, token }
}

async function rows(db: ProviderNeutralDatabase, taskId: string) {
  return {
    task: (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!,
    runs: await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)),
    intents: await db
      .select()
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.taskId, taskId)),
    owner: (
      await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    )[0]!,
    events: await db.select().from(committedEvents).where(eq(committedEvents.aggregateId, taskId)),
  }
}

describeEachProvider('RFC-359 W12 source termination atom', (harness) => {
  test('existing lifecycle guard still runs before the CAS and keeps default event metadata', async () => {
    const { taskId } = await seed(harness.db, { errorSummary: 'previous summary' })
    await harness.db.delete(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    const lifecycle = new DrizzleTaskRuntimeLifecyclePersistence(harness.db)
    let observedStatus: string | undefined
    expect(
      await lifecycle.trySetWithGuard(
        {
          taskId,
          to: 'failed',
          allowedFrom: ['running'],
          extra: { finishedAt: 1_000 },
          now: 1_000,
          reason: 'atom-baseline',
        },
        async (tx) => {
          observedStatus = (
            await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
          )[0]?.status
          await tx
            .update(nodeRuns)
            .set({ errorMessage: 'guard-companion' })
            .where(eq(nodeRuns.taskId, taskId))
        },
      ),
    ).toBe(true)
    const actual = await rows(harness.db, taskId)
    expect(observedStatus).toBe('running')
    expect(actual.task).toMatchObject({
      status: 'failed',
      runningMs: 923,
      runningSince: null,
      errorSummary: 'previous summary',
      finishedAt: 1_000,
      lifecycleEventRevision: 2,
    })
    expect(actual.runs[0]?.errorMessage).toBe('guard-companion')
    expect(actual.events).toHaveLength(1)
    expect(actual.events[0]?.operationRef).toBe(`task-lifecycle:${taskId}:2`)
    expect(JSON.parse(actual.events[0]!.payloadJson).payload).toEqual({
      taskId,
      lifecycleRevision: 2,
      previousStatus: 'running',
      status: 'failed',
      updatedAt: new Date(1_000).toISOString(),
      errorSummary: 'previous summary',
      nodeChanges: [],
      workspacePruneClaim: null,
      sourceTerminationEffectRef: null,
      continuationHandoff: false,
    })
  })

  test('existing lifecycle CAS conflict rolls back its already-awaited guard writes', async () => {
    const { taskId } = await seed(harness.db)
    await harness.db.delete(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    const before = await rows(harness.db, taskId)
    const lifecycle = new DrizzleTaskRuntimeLifecyclePersistence(harness.db)
    expect(
      await lifecycle.trySetWithGuard(
        { taskId, to: 'failed', allowedFrom: ['running'], now: 1_000, reason: 'atom-baseline' },
        async (tx) => {
          await tx.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
          await tx
            .update(nodeRuns)
            .set({ errorMessage: 'must-rollback' })
            .where(eq(nodeRuns.taskId, taskId))
        },
      ),
    ).toBe(false)
    expect(await rows(harness.db, taskId)).toEqual(before)
  })

  test('terminal CAS carries node changes, source identity, running time and exact owner release together', async () => {
    const seeded = await seed(harness.db)
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now())
    restores.push(() => clock.mockRestore())
    const receipts = await apply(harness)
    const actual = await rows(harness.db, seeded.taskId)
    expect(receipts[0]).toMatchObject({
      priorStatus: 'running',
      cancelOutcome: 'canceled',
      releaseOutcome: 'unreaped',
      errorCode: 'task-execution-recovery-required',
    })
    expect(actual.task).toMatchObject({
      status: 'canceled',
      runningSince: null,
      sourceTerminationFence: 'closed',
      sourceTerminationEffectRev: 5,
      lifecycleEventRevision: 2,
    })
    expect(actual.task.runningMs).toBe(23 + actual.task.finishedAt! - 100)
    expect(actual.runs[0]).toMatchObject({
      status: 'canceled',
      finishedAt: actual.task.finishedAt,
      errorMessage: 'webhook-mr-closed',
    })
    expect(actual.intents[0]).toMatchObject({
      state: 'canceled',
      completedAt: actual.task.finishedAt,
      failureCode: 'webhook-mr-closed',
    })
    expect(actual.owner).toMatchObject({
      state: 'revoked',
      revision: 2,
      recoveryCode: 'terminal-control-source',
      updatedAt: actual.task.finishedAt,
    })
    expect(actual.events).toHaveLength(1)
    expect(actual.events[0]).toMatchObject({
      id: `task-lifecycle:${seeded.taskId}:2`,
      operationRef: `source-termination:delivery-atom:5:${seeded.taskId}`,
    })
    expect(JSON.parse(actual.events[0]!.payloadJson).payload).toEqual({
      taskId: seeded.taskId,
      lifecycleRevision: 2,
      previousStatus: 'running',
      status: 'canceled',
      updatedAt: new Date(actual.task.finishedAt!).toISOString(),
      errorSummary: actual.task.errorSummary,
      nodeChanges: [
        {
          nodeRunId: seeded.nodeRunId,
          nodeId: 'node-open',
          status: 'canceled',
          cause: 'webhook-mr-closed',
        },
      ],
      workspacePruneClaim: null,
      sourceTerminationEffectRef: 'source-termination:delivery-atom:5',
      continuationHandoff: false,
    })
  })

  for (const status of TERMINAL_TASK_STATUSES) {
    test(`existing ${status} outcome is retained while remaining nodes, intents and owner are stopped`, async () => {
      const { taskId } = await seed(harness.db, {
        status,
        finishedAt: 777,
        runningSince: null,
        errorSummary: 'original summary',
        errorMessage: 'original detail',
      })
      const before = await rows(harness.db, taskId)
      let pruneCalls = 0
      registerTerminalWorkspacePrunePolicy(async () => {
        pruneCalls += 1
        return { prune: false }
      })
      const receipts = await apply(harness)
      const actual = await rows(harness.db, taskId)
      expect(receipts[0]).toMatchObject({
        priorStatus: status,
        cancelOutcome: 'already-terminal',
        releaseOutcome: 'unreaped',
      })
      expect(actual.task).toEqual({
        ...before.task,
        sourceTerminationFence: 'closed',
        sourceTerminationEffectRev: 5,
      })
      expect(actual.runs[0]).toMatchObject({
        status: 'canceled',
        errorMessage: 'webhook-mr-closed',
      })
      expect(actual.intents[0]).toMatchObject({
        state: 'canceled',
        failureCode: 'webhook-mr-closed',
      })
      expect(actual.owner).toMatchObject({
        state: 'revoked',
        revision: 2,
        recoveryCode: 'terminal-control-source-terminal',
      })
      expect(actual.events).toHaveLength(1)
      expect(actual.events[0]?.eventType).toBe('task.node-statuses-transitioned.v1')
      expect(pruneCalls).toBe(0)
    })
  }

  test('an in-transaction terminal winner makes the source CAS miss without inventing a canceled lifecycle event', async () => {
    const { taskId, nodeRunId } = await seed(harness.db)
    let winner: Awaited<ReturnType<typeof writeTaskRuntimeLifecycleInTx>> | undefined
    registerTerminalWorkspacePrunePolicy(async () => {
      // The named writer commits the winner into the same actual transaction.
      // This targets the CAS-miss branch on both engines; external PostgreSQL
      // serialization/retry remains the separate W8 concurrency predicate.
      winner = await harness.session.transaction(
        async (tx) =>
          await writeTaskRuntimeLifecycleInTx(tx, {
            taskId,
            from: 'running',
            to: 'done',
            now: 777,
            expectedLifecycleRevision: 1,
            workspacePruneDecision: { prune: false },
            previousErrorSummary: null,
            extra: {
              finishedAt: 777,
              errorSummary: 'winner summary',
              errorMessage: 'winner detail',
            },
          }),
      )
      return { prune: false }
    })
    const receipts = await apply(harness)
    const actual = await rows(harness.db, taskId)
    expect(winner?.lifecycleEventRevision).toBe(2)
    expect(receipts).toEqual([
      {
        taskId,
        priorStatus: 'done',
        fenceOutcome: 'fenced-closed',
        cancelOutcome: 'already-terminal',
        releaseOutcome: 'unreaped',
        errorCode: 'task-execution-recovery-required',
      },
    ])
    expect(actual.task).toMatchObject({
      status: 'done',
      lifecycleEventRevision: 2,
      finishedAt: 777,
      errorSummary: 'winner summary',
      errorMessage: 'winner detail',
      runningSince: null,
      runningMs: 700,
      sourceTerminationFence: 'closed',
      sourceTerminationEffectRev: 5,
    })
    expect(actual.runs[0]).toMatchObject({ status: 'canceled', errorMessage: 'webhook-mr-closed' })
    expect(actual.intents[0]).toMatchObject({ state: 'canceled', failureCode: 'webhook-mr-closed' })
    expect(actual.owner).toMatchObject({
      state: 'revoked',
      revision: 2,
      recoveryCode: 'terminal-control-source-race-winner',
    })
    const lifecycleEvents = actual.events.filter(
      (event) => event.eventType === 'task.lifecycle-transitioned.v1',
    )
    expect(lifecycleEvents).toHaveLength(1)
    expect(lifecycleEvents[0]?.operationRef).toBe(`task-lifecycle:${taskId}:2`)
    expect(JSON.parse(lifecycleEvents[0]!.payloadJson).payload).toMatchObject({
      previousStatus: 'running',
      status: 'done',
      errorSummary: 'winner summary',
      sourceTerminationEffectRef: null,
      nodeChanges: [],
    })
    const nodeEvents = actual.events.filter(
      (event) => event.eventType === 'task.node-statuses-transitioned.v1',
    )
    expect(actual.events).toHaveLength(2)
    expect(nodeEvents).toHaveLength(1)
    expect(nodeEvents[0]?.operationRef).toBe(`source-termination:delivery-atom:5:${taskId}`)
    expect(JSON.parse(nodeEvents[0]!.payloadJson).payload).toMatchObject({
      taskId,
      reason: 'source-termination',
      nodeChanges: [
        { nodeRunId, nodeId: 'node-open', status: 'canceled', cause: 'webhook-mr-closed' },
      ],
    })
  })

  test('an in-transaction fence-only CAS conflict rolls back the competing lifecycle write and its event', async () => {
    const { taskId } = await seed(harness.db, {
      sourceTerminationFence: 'closed',
      sourceTerminationEffectRev: 3,
    })
    const before = await rows(harness.db, taskId)
    const recording = harness.recordStatements()
    restores.push(() => recording.stop())
    let winner: Awaited<ReturnType<typeof writeTaskRuntimeLifecycleInTx>> | undefined
    const operation = harness.session.transaction(async (tx) => {
      // Both operations use one real connection. Starting the atom first
      // queues its snapshot SELECT before the winner UPDATE, and its fence
      // CAS after that UPDATE. This is an intra-transaction CAS predicate,
      // not a claim about inter-connection PostgreSQL serialization.
      const source = applySourceTerminationTarget(
        harness.db,
        taskExecutionModule.runtimeRegistry,
        taskId,
        effect('clear-closed'),
      )
      const transition = writeTaskRuntimeLifecycleInTx(tx, {
        taskId,
        from: 'running',
        to: 'done',
        now: 777,
        expectedLifecycleRevision: 1,
        workspacePruneDecision: { prune: false },
        previousErrorSummary: null,
        extra: { finishedAt: 777, errorSummary: 'must roll back' },
      })
      const [sourceResult, transitionResult] = await Promise.allSettled([source, transition])
      if (transitionResult.status === 'rejected') throw transitionResult.reason
      winner = transitionResult.value
      if (sourceResult.status === 'rejected') throw sourceResult.reason
      return sourceResult.value
    })
    await expect(operation).rejects.toMatchObject({ code: 'concurrent-task-transition' })
    expect(winner?.lifecycleEventRevision).toBe(2)
    expect(winner?.eventRef?.eventId).toBe(`task-lifecycle:${taskId}:2`)
    const snapshotIndex = recording.statements.findIndex(
      (statement) =>
        /^select\b/i.test(statement.sql) && statement.sql.includes('source_termination_launch_rev'),
    )
    const winnerIndex = recording.statements.findIndex((statement) =>
      /update "tasks" set "status"/i.test(statement.sql),
    )
    const fenceIndex = recording.statements.findIndex((statement) =>
      /update "tasks" set "source_termination_fence"/i.test(statement.sql),
    )
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(winnerIndex).toBeGreaterThan(snapshotIndex)
    expect(fenceIndex).toBeGreaterThan(winnerIndex)
    expect(await rows(harness.db, taskId)).toEqual(before)
  })

  test('clear-closed first application and replay have no stop obligation or companion writes', async () => {
    // RFC-303 design §7.3: reopen changes only the closed fence, not task,
    // node, workspace or runtime state. A remote owner need not be stopped.
    const { taskId } = await seed(harness.db, {
      sourceTerminationFence: 'closed',
      sourceTerminationEffectRev: 3,
    })
    const before = await rows(harness.db, taskId)
    const first = await apply(harness, effect('clear-closed'))
    const replay = await apply(harness, effect('clear-closed'))
    expect(first[0]).toEqual({
      taskId,
      priorStatus: 'running',
      fenceOutcome: 'cleared-closed',
      cancelOutcome: 'not-applicable',
      releaseOutcome: 'not-required',
      errorCode: null,
    })
    expect(replay[0]).toEqual({ ...first[0]!, fenceOutcome: 'unchanged' })
    expect(await rows(harness.db, taskId)).toEqual({
      ...before,
      task: { ...before.task, sourceTerminationFence: null, sourceTerminationEffectRev: 5 },
    })
  })

  test('replay cancels newly discovered open nodes without repeating task, owner or intent transitions', async () => {
    const { taskId } = await seed(harness.db)
    await apply(harness)
    const first = await rows(harness.db, taskId)
    const lateRunId = `late-${taskId}`
    await harness.db.insert(nodeRuns).values({
      id: lateRunId,
      taskId,
      nodeId: 'late',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      continuationSlotKey: `${taskId}:late`,
      operationGeneration: 0,
    })
    const receipts = await apply(harness)
    const replay = await rows(harness.db, taskId)
    expect(receipts[0]).toMatchObject({
      priorStatus: 'canceled',
      fenceOutcome: 'unchanged',
      cancelOutcome: 'already-terminal',
      releaseOutcome: 'no-active-owner',
    })
    expect(replay.task).toEqual(first.task)
    expect(replay.owner).toEqual(first.owner)
    expect(replay.intents).toEqual(first.intents)
    expect(replay.runs.find((run) => run.id === lateRunId)).toMatchObject({
      status: 'canceled',
      errorMessage: 'webhook-mr-closed',
    })
    expect(replay.events).toHaveLength(2)
    const nodeEvent = replay.events.find(
      (event) => event.eventType === 'task.node-statuses-transitioned.v1',
    )!
    expect(nodeEvent.operationRef).toBe(
      `source-termination-reconcile:delivery-atom:5:${taskId}:${lateRunId}`,
    )
    expect(JSON.parse(nodeEvent.payloadJson).payload).toMatchObject({
      taskId,
      reason: 'source-termination',
      nodeChanges: [
        { nodeRunId: lateRunId, nodeId: 'late', status: 'canceled', cause: 'webhook-mr-closed' },
      ],
    })
    await apply(harness)
    expect((await rows(harness.db, taskId)).events).toHaveLength(2)
  })

  for (const conflict of [false, true]) {
    test(`companion ${conflict ? 'conflict' : 'error'} rolls back task, nodes, owner, intents and event before publication`, async () => {
      const { taskId } = await seed(harness.db)
      const before = await rows(harness.db, taskId)
      const failure = conflict
        ? new ConflictError('atom-test-conflict', 'owner lookup failed')
        : new Error('owner lookup failed')
      const lookup = spyOn(taskExecutionModule.runtimeRegistry, 'tokenForOwner').mockImplementation(
        () => {
          throw failure
        },
      )
      restores.push(() => lookup.mockRestore())
      const published: string[] = []
      registerAfterCommitEventPump({
        publishNow: async (refs) => {
          published.push(...refs.map((ref) => ref.eventId))
        },
        nudge: () => {},
      })
      await expect(apply(harness)).rejects.toBe(failure)
      expect(await rows(harness.db, taskId)).toEqual(before)
      expect(published).toEqual([])
    })
  }

  test('commit precedes projection and driver stop; settlement waits outside the review lock', async () => {
    const seeded = await seed(harness.db)
    const registry = taskExecutionModule.runtimeRegistry
    const gate = taskExecutionModule.claimGate
    const permit = gate.enter()
    gate.bind(permit, seeded.token)
    const controller = new AbortController()
    expect(
      registry.tryAttach({ token: seeded.token, intentId: seeded.intentId, permit, controller }),
    ).toBe('attached')
    gate.leave(permit)
    const recorder = harness.recordStatements()
    restores.push(() => recorder.stop())
    const order: string[] = []
    const heldAt: boolean[] = []
    let publishedRows: Awaited<ReturnType<typeof rows>> | undefined
    let committedAtPublish = false
    registerAfterCommitEventPump({
      async publishNow() {
        order.push('publish')
        heldAt.push(__hasTaskReviewMutationQueueForTesting(seeded.taskId))
        committedAtPublish = recorder.statements.some((statement) =>
          /^COMMIT\b/i.test(statement.sql),
        )
        publishedRows = await rows(harness.db, seeded.taskId)
      },
      nudge: () => {},
    })
    controller.signal.addEventListener('abort', () => {
      order.push('stop')
      heldAt.push(__hasTaskReviewMutationQueueForTesting(seeded.taskId))
    })
    let waiting = () => {}
    const waited = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const originalAwait = registry.awaitStopped.bind(registry)
    const stopWait = spyOn(registry, 'awaitStopped').mockImplementation(async (ticket) => {
      order.push('wait')
      heldAt.push(__hasTaskReviewMutationQueueForTesting(seeded.taskId))
      waiting()
      return await originalAwait(ticket)
    })
    restores.push(() => stopWait.mockRestore())
    let returned = false
    const pending = apply(harness).then((receipts) => {
      returned = true
      return receipts
    })
    await waited
    expect(returned).toBe(false)
    expect(committedAtPublish).toBe(true)
    expect(publishedRows?.task.status).toBe('canceled')
    expect(publishedRows?.owner.state).toBe('revoked')
    expect(publishedRows?.intents[0]?.state).toBe('canceled')
    expect(publishedRows?.events).toHaveLength(1)
    expect(order).toEqual(['publish', 'stop', 'wait'])
    const publishInsideLock = harness.capabilities.isolation === 'exclusive'
    expect(heldAt).toEqual([publishInsideLock, publishInsideLock, false])
    registry.release({ token: seeded.token, controller })
    registry.settle(seeded.token)
    expect((await pending)[0]).toMatchObject({ releaseOutcome: 'released', errorCode: null })
  })

  test('post-commit stop rejection propagates while durable cancellation remains committed', async () => {
    const seeded = await seed(harness.db)
    const registry = taskExecutionModule.runtimeRegistry
    const lookup = spyOn(registry, 'tokenForOwner').mockReturnValue(seeded.token)
    const failure = new Error('driver stop failed')
    const stopping = spyOn(registry, 'requestStop').mockImplementation(() => {
      throw failure
    })
    restores.push(
      () => lookup.mockRestore(),
      () => stopping.mockRestore(),
    )
    await expect(apply(harness)).rejects.toBe(failure)
    const actual = await rows(harness.db, seeded.taskId)
    expect(actual.task.status).toBe('canceled')
    expect(actual.owner.state).toBe('revoked')
    expect(actual.intents[0]?.state).toBe('canceled')
    const events = await harness.db
      .select()
      .from(committedEvents)
      .where(
        and(
          eq(committedEvents.aggregateId, seeded.taskId),
          eq(committedEvents.eventType, 'task.lifecycle-transitioned.v1'),
        ),
      )
    expect(events).toHaveLength(1)
  })
})
