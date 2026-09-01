// RFC-303 durable worker locks: the first cancellation receipt remains the
// audit truth across the fixed-point sweep, and unreaped ownership is never
// reported as succeeded.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { webhookMrControlEffects, webhookMrControlTargets } from '@/db/schema'
import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import { createSqliteMrTerminalEffectPersistence } from '@/modules/integration/infrastructure/sqliteMrTerminalControlPersistence'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function guards(): MrLaunchGuardCoordinator {
  return {
    supervisor: { abortAll: () => [] },
    abortRevoked: () => 0,
    hasLaunchBarrier: async () => false,
    reconcileStaleOnBoot: () => {},
  } as unknown as MrLaunchGuardCoordinator
}

async function fixture(participant: TaskSourceTerminationParticipant) {
  const db = createInMemoryDb(MIGRATIONS)
  const now = Date.now()
  await db.insert(webhookMrControlEffects).values({
    id: 'effect-1',
    deliveryId: 'delivery-1',
    endpointId: 'endpoint-1',
    streamKey: 'gitlab:77:9',
    binding: 'binding-1',
    revision: 2,
    observedEventType: 'mr_closed',
    kind: 'fence-closed',
    status: 'pending',
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  })
  const worker = new MrTerminalControlWorker(
    createSqliteMrTerminalEffectPersistence(db),
    guards(),
    participant,
    mintSourceTerminationEffectCapability,
  )
  await worker.reconcileOnBoot()
  await worker.stop()
  return db
}

describe('RFC-303 terminal control worker', () => {
  test('fixed-point observation cannot rewrite canceled into already-terminal', async () => {
    let calls = 0
    const db = await fixture({
      async apply() {
        calls += 1
        return [
          {
            taskId: 'task-1',
            priorStatus: calls === 1 ? 'running' : 'canceled',
            fenceOutcome: calls === 1 ? 'fenced-closed' : 'unchanged',
            cancelOutcome: calls === 1 ? 'canceled' : 'already-terminal',
            releaseOutcome: 'released',
            errorCode: null,
          },
        ]
      },
    })
    expect(calls).toBe(2)
    expect(
      (
        await db
          .select()
          .from(webhookMrControlTargets)
          .where(eq(webhookMrControlTargets.effectId, 'effect-1'))
      )[0],
    ).toMatchObject({
      priorStatus: 'running',
      fenceOutcome: 'fenced-closed',
      cancelOutcome: 'canceled',
      releaseOutcome: 'released',
    })
    expect(
      (
        await db
          .select()
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.id, 'effect-1'))
      )[0]?.status,
    ).toBe('succeeded')
  })

  test('unreaped driver remains retryable with an honest error', async () => {
    const db = await fixture({
      async apply() {
        return [
          {
            taskId: 'task-1',
            priorStatus: 'running',
            fenceOutcome: 'fenced-closed',
            cancelOutcome: 'canceled',
            releaseOutcome: 'unreaped',
            errorCode: 'child-unkillable',
          },
        ]
      },
    })
    expect(
      (
        await db
          .select()
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.id, 'effect-1'))
      )[0],
    ).toMatchObject({ status: 'retryable', lastError: 'task-driver-unreaped' })
  })

  test('shutdown aborts launch owners and waits for the active effect attempt to settle', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    await db.insert(webhookMrControlEffects).values({
      id: 'effect-stop',
      deliveryId: 'delivery-stop',
      endpointId: 'endpoint-1',
      streamKey: 'gitlab:77:10',
      binding: 'binding-stop',
      revision: 2,
      observedEventType: 'mr_closed',
      kind: 'fence-closed',
      status: 'pending',
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    let allowApply!: () => void
    const applyGate = new Promise<void>((resolve) => {
      allowApply = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let calls = 0
    let abortedOwners = 0
    const launchGuards = guards()
    launchGuards.supervisor.abortAll = () => {
      abortedOwners += 1
      return []
    }
    const worker = new MrTerminalControlWorker(
      createSqliteMrTerminalEffectPersistence(db),
      launchGuards,
      {
        async apply() {
          calls += 1
          markStarted()
          await applyGate
          return []
        },
      },
      mintSourceTerminationEffectCapability,
    )
    worker.wake()
    await started

    let stopped = false
    const stop = worker.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(abortedOwners).toBe(1)
    allowApply()
    await stop
    expect(stopped).toBe(true)
    expect(calls).toBe(2)
  })
})
