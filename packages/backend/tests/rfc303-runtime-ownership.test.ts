// RFC-303 runtime ownership locks: a durable terminal fact must stop the exact
// attached driver, wait for its finally/reap receipt, and reject forged effect
// capabilities. These are the process-local halves of the row/owner race.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { webhookMrLaunchGuards, webhookMrStreamStates } from '@/db/schema'
import { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { sourceTerminationCapabilityMatches } from '@/modules/task-execution/application/sourceTerminationCapability'
import { InMemoryTaskDriverSupervisor } from '@/modules/task-execution/infrastructure/inMemoryTaskDriverSupervisor'
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

describe('RFC-303 task driver ownership', () => {
  test('stop targets the attached generation and settles only after owner release', async () => {
    const registry = new InMemoryTaskDriverSupervisor()
    const controller = new AbortController()
    expect(registry.tryAttach('task-1', controller)).toBe(true)
    expect(registry.tryAttach('task-1', new AbortController())).toBe(false)

    const ticket = registry.requestStop('task-1', cause)
    expect(ticket).not.toBe('no-active-owner')
    if (ticket === 'no-active-owner') throw new Error('expected owner ticket')
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toEqual(cause)

    let settled = false
    void registry.awaitStopped(ticket).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(registry.release('task-1', controller, { kind: 'released' })).toBe(true)
    expect(await registry.awaitStopped(ticket)).toEqual({ kind: 'released' })
  })

  test('a stale controller cannot release a newer or different owner', async () => {
    const registry = new InMemoryTaskDriverSupervisor()
    const owner = new AbortController()
    expect(registry.tryAttach('task-1', owner)).toBe(true)
    expect(registry.release('task-1', new AbortController())).toBe(false)
    expect(registry.has('task-1')).toBe(true)

    const ticket = registry.requestStop('task-1', cause)
    if (ticket === 'no-active-owner') throw new Error('expected owner ticket')
    expect(registry.release('task-1', owner, { kind: 'unreaped', code: 'child-unkillable' })).toBe(
      true,
    )
    expect(await registry.awaitStopped(ticket)).toEqual({
      kind: 'unreaped',
      code: 'child-unkillable',
    })
  })

  test('a missing owner is reported explicitly', () => {
    const registry = new InMemoryTaskDriverSupervisor()
    expect(registry.requestStop('missing', cause)).toBe('no-active-owner')
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
