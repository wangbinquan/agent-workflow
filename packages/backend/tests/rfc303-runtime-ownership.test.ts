// RFC-303 runtime ownership locks: a durable terminal fact must stop the exact
// attached driver, wait for its finally/reap receipt, and reject forged effect
// capabilities. These are the process-local halves of the row/owner race.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { nodeRuns, tasks, webhookMrLaunchGuards, webhookMrStreamStates } from '@/db/schema'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/application/applySourceTerminationEffect'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { sourceTerminationCapabilityMatches } from '@/modules/task-execution/application/sourceTerminationCapability'
import { TaskClaimGate } from '@/modules/task-execution/application/taskClaimGate'
import { InMemoryTaskRuntimeRegistry } from '@/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
} from '@/modules/task-execution/public/participants'

const cause = {
  kind: 'webhook-terminal',
  terminal: 'merged',
  deliveryId: 'delivery-1',
  streamRevision: 7,
} as const
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function runtimeFixture(taskId: string) {
  const gate = new TaskClaimGate('rfc303-runtime-test')
  const registry = new InMemoryTaskRuntimeRegistry(gate)
  const permit = gate.enter()
  const token = createOwnershipToken({
    taskId,
    identity: createWorkerIdentity({
      ownerId: `owner-${taskId}`,
      daemonGeneration: 'rfc303-runtime-test',
    }),
    epoch: 1,
    leaseUntil: 10_000,
    ownerRevision: 1,
  })
  gate.bind(permit, token)
  return { gate, registry, permit, token }
}

describe('RFC-303 task driver ownership', () => {
  test('stop targets the attached generation and settles only after owner release', async () => {
    const h = runtimeFixture('task-1')
    const controller = new AbortController()
    expect(
      h.registry.tryAttach({
        token: h.token,
        intentId: 'intent-1',
        permit: h.permit,
        controller,
      }),
    ).toBe('attached')
    h.gate.leave(h.permit)

    const ticket = h.registry.requestStop(h.token, cause)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toEqual(cause)

    let settled = false
    void h.registry.awaitStopped(ticket).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.registry.release({ token: h.token, controller, result: { kind: 'released' } })).toBe(
      true,
    )
    expect(await h.registry.awaitStopped(ticket)).toMatchObject({ kind: 'released' })
  })

  test('a stale controller cannot release a newer or different owner', async () => {
    const h = runtimeFixture('task-1')
    const owner = new AbortController()
    expect(
      h.registry.tryAttach({
        token: h.token,
        intentId: 'intent-1',
        permit: h.permit,
        controller: owner,
      }),
    ).toBe('attached')
    h.gate.leave(h.permit)
    expect(h.registry.release({ token: h.token, controller: new AbortController() })).toBe(false)
    expect(h.registry.hasTask('task-1')).toBe(true)

    const ticket = h.registry.requestStop(h.token, cause)
    expect(
      h.registry.release({
        token: h.token,
        controller: owner,
        result: { kind: 'unreaped', code: 'child-unkillable' },
      }),
    ).toBe(true)
    expect(await h.registry.awaitStopped(ticket)).toMatchObject({
      kind: 'unreaped',
      code: 'child-unkillable',
    })
  })

  test('stop-first is sticky for the exact token and does not need a taskId lookup', async () => {
    const h = runtimeFixture('missing')
    const ticket = h.registry.requestStop(h.token, cause)
    const controller = new AbortController()
    expect(
      h.registry.tryAttach({
        token: h.token,
        intentId: 'intent-missing',
        permit: h.permit,
        controller,
      }),
    ).toBe('rejected-stopped')
    h.gate.leave(h.permit)
    expect(controller.signal.aborted).toBe(true)
    expect(await h.registry.awaitStopped(ticket)).toMatchObject({ kind: 'released' })
  })
})

describe('RFC-303 source termination capability', () => {
  const input: TaskSourceTerminationEffectInput = {
    effectId: 'effect-1',
    binding: 'binding-1',
    streamRevision: 3,
    kind: 'fence-closed',
    deliveryId: 'delivery-1',
  }

  test('only the minted object matches its exact durable claim', () => {
    const capability = mintSourceTerminationEffectCapability(input)
    expect(sourceTerminationCapabilityMatches(capability, input)).toBe(true)
    expect(sourceTerminationCapabilityMatches(capability, { ...input, streamRevision: 4 })).toBe(
      false,
    )
    expect(sourceTerminationCapabilityMatches({} as SourceTerminationEffectCapability, input)).toBe(
      false,
    )
  })

  test('terminal effect atomically cancels live node rows before the owner loses write authority', async () => {
    // Regression: source termination revoked the durable owner in the task
    // transaction but left its running node row untouched. The stale driver's
    // later cancellation callback correctly lost the owner fence, so the row
    // stayed `running` forever even though the task and process were canceled.
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(tasks).values({
      id: 'task-source-node-projection',
      name: 'source node projection',
      workflowId: 'workflow-rfc303',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/task-source-node-projection',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      sourceTerminationBinding: input.binding,
      sourceTerminationLaunchRev: 1,
    })
    await db.insert(nodeRuns).values([
      {
        id: 'run-source-live',
        taskId: 'task-source-node-projection',
        nodeId: 'runtime',
        iteration: 0,
        retryIndex: 0,
        status: 'running',
        startedAt: 2,
      },
      {
        id: 'run-source-done',
        taskId: 'task-source-node-projection',
        nodeId: 'already-done',
        iteration: 0,
        retryIndex: 0,
        status: 'done',
        startedAt: 2,
        finishedAt: 3,
      },
    ])

    const receipts = await createTaskSourceTerminationParticipant(db).apply(
      mintSourceTerminationEffectCapability(input),
      input,
    )

    expect(receipts).toEqual([
      expect.objectContaining({
        taskId: 'task-source-node-projection',
        cancelOutcome: 'canceled',
        releaseOutcome: 'no-active-owner',
      }),
    ])
    expect(
      db
        .select({ id: nodeRuns.id, status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, 'task-source-node-projection'))
        .orderBy(nodeRuns.id)
        .all(),
    ).toEqual([
      { id: 'run-source-done', status: 'done' },
      { id: 'run-source-live', status: 'canceled' },
    ])
    expect(
      db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, 'task-source-node-projection'))
        .get()?.status,
    ).toBe('canceled')
  })
})

describe('RFC-303 protected launch guard', () => {
  test('terminal revision revokes the pre-task owner and both admission gates fail closed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookMrStreamStates).values({
      endpointId: 'endpoint-1',
      streamKey: 'gitlab:77:9',
      projectId: '77',
      mrIid: '9',
      state: 'open',
      revision: 1,
      lastDeliveryId: 'delivery-open',
      updatedAt: 1,
    })
    const coordinator = new MrLaunchGuardCoordinator(db)
    const guard = coordinator.reserve({
      endpointId: 'endpoint-1',
      streamKey: 'gitlab:77:9',
      binding: 'binding-1',
      launchRevision: 1,
      deliveryId: 'delivery-open',
      fireId: 'fire-1',
      triggerId: 'trigger-1',
      triggerName: 'review',
    })
    expect(() => guard.assertCanCommit()).not.toThrow()

    await db
      .update(webhookMrStreamStates)
      .set({ state: 'closed', revision: 2, lastTerminalRevision: 2 })
      .where(eq(webhookMrStreamStates.streamKey, 'gitlab:77:9'))
    await db
      .update(webhookMrLaunchGuards)
      .set({ status: 'revoking-terminal' })
      .where(eq(webhookMrLaunchGuards.id, guard.id))
    expect(coordinator.abortRevoked()).toBe(1)
    expect(guard.signal.aborted).toBe(true)
    expect(() => guard.assertCanCommit()).toThrow(
      expect.objectContaining({ code: 'webhook-mr-launch-terminal' }),
    )
    guard.failed('webhook-mr-launch-terminal')
    guard.release()
    expect(
      (
        await db
          .select({ status: webhookMrLaunchGuards.status })
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.id, guard.id))
      )[0]?.status,
    ).toBe('aborted-terminal')
  })

  test('reservation after a terminal fact is rejected before an owner is registered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookMrStreamStates).values({
      endpointId: 'endpoint-1',
      streamKey: 'gitlab:77:9',
      projectId: '77',
      mrIid: '9',
      state: 'merged',
      revision: 2,
      lastTerminalRevision: 2,
      lastDeliveryId: 'delivery-merge',
      updatedAt: 2,
    })
    const coordinator = new MrLaunchGuardCoordinator(db)
    expect(() =>
      coordinator.reserve({
        endpointId: 'endpoint-1',
        streamKey: 'gitlab:77:9',
        binding: 'binding-1',
        launchRevision: 1,
        deliveryId: 'delivery-open',
        fireId: 'fire-1',
        triggerId: 'trigger-1',
        triggerName: 'review',
      }),
    ).toThrow(expect.objectContaining({ code: 'webhook-mr-launch-terminal' }))
  })
})
