// Real provider receipts and the selected production owner, without replacing
// the original RFC-303 / RFC-370 native authority-loss fixtures.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  webhookMrControlEffects,
  webhookMrControlTargets,
  webhookMrLaunchGuards,
  webhookMrStreamStates,
} from '@/db/schema'
import { composeMrTerminalControlWithPorts } from '@/modules/integration/composition/webhookTerminalControl'
import {
  createMrLaunchGuardPersistence,
  createMrTerminalEffectPersistence,
} from '@/modules/integration/infrastructure/mrTerminalControlPersistence'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type {
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '@/modules/task-execution/public/participants'
import type {
  MrLaunchGuardPersistencePort,
  MrTerminalEffectPersistencePort,
  MrTerminalEffectAuthoritySettlementPort,
} from '@/modules/integration/application/ports/mrTerminalControlPersistence'
import { bindWebhookTerminalHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const launch = {
  endpointId: 'host-endpoint',
  streamKey: 'gitlab:77:9',
  binding: 'host-binding',
  launchRevision: 1,
  deliveryId: 'host-open',
  fireId: 'host-fire',
  triggerId: 'host-trigger',
  triggerName: 'host-review',
}
const receipt: TaskSourceTerminationReceipt = {
  taskId: 'host-task',
  priorStatus: 'running',
  fenceOutcome: 'fenced-closed',
  cancelOutcome: 'canceled',
  releaseOutcome: 'released',
  errorCode: null,
}
function grant(harness: ProviderHarness) {
  let active = true
  const context = {
    generation: 'webhook-host-generation',
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    scope: {
      provider: harness.applicationBinding.provider,
      generationId: context.generation,
      operationId: 'webhook-host',
    },
    lose() {
      active = false
    },
  }
}
async function seedStream(harness: ProviderHarness) {
  await harness.db.insert(webhookMrStreamStates).values({
    endpointId: launch.endpointId,
    streamKey: launch.streamKey,
    projectId: '77',
    mrIid: '9',
    state: 'open',
    revision: 1,
    lastDeliveryId: launch.deliveryId,
    updatedAt: Date.now(),
  })
}
async function seedEffect(harness: ProviderHarness) {
  const now = Date.now()
  await harness.db.insert(webhookMrControlEffects).values({
    id: 'host-effect',
    endpointId: launch.endpointId,
    streamKey: launch.streamKey,
    binding: launch.binding,
    deliveryId: 'host-closed',
    revision: 2,
    observedEventType: 'mr_closed',
    kind: 'fence-closed',
    status: 'pending',
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  })
}
async function effect(harness: ProviderHarness) {
  return (
    await harness.db
      .select()
      .from(webhookMrControlEffects)
      .where(eq(webhookMrControlEffects.id, 'host-effect'))
  )[0]!
}
function compose(
  harness: ProviderHarness,
  options: {
    guards?: (port: MrLaunchGuardPersistencePort) => MrLaunchGuardPersistencePort
    effects?: (port: MrTerminalEffectPersistencePort) => MrTerminalEffectPersistencePort
    settlement?: (
      port: MrTerminalEffectAuthoritySettlementPort,
    ) => MrTerminalEffectAuthoritySettlementPort
    apply?: TaskSourceTerminationParticipant['apply']
  } = {},
) {
  const guards = createMrLaunchGuardPersistence(harness.db)
  const effects = createMrTerminalEffectPersistence(harness.db)
  const runtime = composeMrTerminalControlWithPorts({
    persistence: {
      launchGuards: options.guards?.(guards) ?? guards,
      terminalEffects: options.effects?.(effects) ?? effects,
    },
    taskTermination: {
      participant: { apply: options.apply ?? (async () => [receipt]) },
      mintCapability: mintSourceTerminationEffectCapability,
    },
    execution: { mode: 'host', settlement: options.settlement?.(effects) ?? effects },
  })
  if (runtime.execution === undefined) throw new Error('fixture selected no execution lifecycle')
  return {
    runtime,
    execution: runtime.execution,
    owner: bindWebhookTerminalHostOwner(runtime.execution),
  }
}

describeEachProvider('RFC-370 webhook cold host and actual receipt lifetime', (harness) => {
  test('cold construction, wakes and close perform no boot repair, claim or launch', async () => {
    await seedStream(harness)
    await seedEffect(harness)
    let applies = 0,
      boots = 0
    const f = compose(harness, {
      apply: async () => {
        applies++
        return [receipt]
      },
      guards: (port) => ({
        ...port,
        reconcileStaleOnBoot: async (now) => {
          boots++
          await port.reconcileStaleOnBoot(now)
        },
      }),
    })
    f.runtime.wake()
    await expect(f.runtime.reserveLaunch(launch)).rejects.toMatchObject({
      code: 'webhook-mr-execution-unavailable',
    })
    expect(() => f.runtime.reconcileOnBoot()).toThrow('Webhook execution is not active')
    await f.runtime.stop()
    expect({ applies, boots }).toEqual({ applies: 0, boots: 0 })
    expect(await effect(harness)).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      leaseOwner: null,
    })
    expect(await harness.db.select().from(webhookMrLaunchGuards)).toEqual([])
  })

  test('loss during the real claim ACK releases that unissued claim before a new owner', async () => {
    const claimed = deferred(),
      releaseClaim = deferred()
    let applies = 0,
      hold = true
    const f = compose(harness, {
      effects: (port) => ({
        ...port,
        async claimNextDue(input) {
          const result = await port.claimNextDue(input)
          if (result !== null && hold) {
            hold = false
            claimed.resolve()
            await releaseClaim.promise
          }
          return result
        },
      }),
      apply: async () => {
        applies++
        return [receipt]
      },
    })
    const first = grant(harness),
      handle = await f.owner.start(first)
    await seedEffect(harness)
    f.runtime.wake()
    await claimed.promise
    first.lose()
    f.owner.quiesceAuthorityLoss({ ...first, handle })
    let drained = false
    const draining = Promise.resolve(f.owner.drainAuthorityLoss({ ...first, handle })).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(f.owner.start(grant(harness))).rejects.toThrow('prior-lifetime-not-drained')
    releaseClaim.resolve()
    await draining
    expect(applies).toBe(0)
    expect(await effect(harness)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      leaseOwner: null,
    })
    const next = grant(harness),
      nextHandle = await f.owner.start(next)
    expect(applies).toBe(2)
    expect(await effect(harness)).toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
      leaseOwner: null,
    })
    await nextHandle.stop()
    await nextHandle.drain()
  })

  test('loss during an issued apply waits for its original receipt and cannot issue the final sweep', async () => {
    const entered = deferred(),
      releaseApply = deferred(),
      receiptWritten = deferred(),
      releaseReceipt = deferred()
    let applies = 0
    const f = compose(harness, {
      apply: async () => {
        applies++
        entered.resolve()
        await releaseApply.promise
        return [receipt]
      },
      effects: (port) => ({
        ...port,
        async recordReceipts(...args) {
          await port.recordReceipts(...args)
          receiptWritten.resolve()
          await releaseReceipt.promise
        },
      }),
    })
    const g = grant(harness),
      handle = await f.owner.start(g)
    await seedEffect(harness)
    f.runtime.wake()
    await entered.promise
    g.lose()
    f.owner.quiesceAuthorityLoss({ ...g, handle })
    let drained = false
    const draining = Promise.resolve(f.owner.drainAuthorityLoss({ ...g, handle })).then(() => {
      drained = true
    })
    releaseApply.resolve()
    await receiptWritten.promise
    expect(drained).toBe(false)
    releaseReceipt.resolve()
    await draining
    expect(applies).toBe(1)
    expect(await effect(harness)).toMatchObject({
      status: 'retryable',
      leaseOwner: null,
      lastError: 'host-execution-quiesced',
    })
    expect(await harness.db.select().from(webhookMrControlTargets)).toMatchObject([
      {
        taskId: receipt.taskId,
        priorStatus: receipt.priorStatus,
        fenceOutcome: receipt.fenceOutcome,
        cancelOutcome: receipt.cancelOutcome,
        releaseOutcome: receipt.releaseOutcome,
        error: null,
      },
    ])
  })

  test('a failed receipt ACK blocks drain; retrying intake does not invoke termination twice', async () => {
    const entered = deferred(),
      releaseApply = deferred()
    let applies = 0,
      failReceipt = true
    const f = compose(harness, {
      apply: async () => {
        applies++
        entered.resolve()
        await releaseApply.promise
        return [receipt]
      },
      effects: (port) => ({
        ...port,
        async recordReceipts(...args) {
          await port.recordReceipts(...args)
          if (failReceipt) throw new Error('fixture-receipt-ack-unknown')
        },
      }),
    })
    const g = grant(harness),
      handle = await f.owner.start(g)
    await seedEffect(harness)
    f.runtime.wake()
    await entered.promise
    g.lose()
    f.owner.quiesceAuthorityLoss({ ...g, handle })
    releaseApply.resolve()
    await expect(Promise.resolve(f.owner.drainAuthorityLoss({ ...g, handle }))).rejects.toThrow(
      'fixture-receipt-ack-unknown',
    )
    expect((await effect(harness)).status).toBe('leased')
    await expect(f.owner.start(grant(harness))).rejects.toThrow('prior-lifetime-not-drained')
    failReceipt = false
    await f.owner.drainAuthorityLoss({ ...g, handle })
    expect(applies).toBe(1)
    expect(await effect(harness)).toMatchObject({ status: 'retryable', leaseOwner: null })
    expect(await harness.db.select().from(webhookMrControlTargets)).toHaveLength(1)
  })

  test('loss during reservation writes failed intake, without exposing or leaking a launch owner', async () => {
    await seedStream(harness)
    const reserved = deferred(),
      releaseReserve = deferred()
    const f = compose(harness, {
      guards: (port) => ({
        ...port,
        async reserve(input) {
          await port.reserve(input)
          reserved.resolve()
          await releaseReserve.promise
        },
      }),
    })
    const g = grant(harness),
      handle = await f.owner.start(g)
    const reserving = f.runtime.reserveLaunch(launch).then(
      () => null,
      (error: unknown) => error,
    )
    await reserved.promise
    g.lose()
    f.owner.quiesceAuthorityLoss({ ...g, handle })
    let drained = false
    const draining = Promise.resolve(f.owner.drainAuthorityLoss({ ...g, handle })).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    releaseReserve.resolve()
    expect(await reserving).toMatchObject({ code: 'webhook-mr-execution-unavailable' })
    await draining
    expect(await harness.db.select().from(webhookMrLaunchGuards)).toMatchObject([
      {
        status: 'failed',
        launchOwnerKey: null,
        taskId: null,
        error: 'webhook-mr-launch-not-issued',
      },
    ])
  })

  test('an issued guard is not aborted on loss and its released owner still owes the original settlement ACK', async () => {
    await seedStream(harness)
    const written = deferred(),
      releaseWrite = deferred()
    const f = compose(harness, {
      guards: (port) => ({
        ...port,
        async markLaunchSettled(...args) {
          await port.markLaunchSettled(...args)
          written.resolve()
          await releaseWrite.promise
        },
      }),
    })
    const g = grant(harness),
      handle = await f.owner.start(g)
    const guard = await f.runtime.reserveLaunch(launch)
    await guard.verifyCanCommit()
    g.lose()
    f.owner.quiesceAuthorityLoss({ ...g, handle })
    let drained = false
    const draining = Promise.resolve(f.owner.drainAuthorityLoss({ ...g, handle })).then(() => {
      drained = true
    })
    expect(guard.signal.aborted).toBe(false)
    expect(() => guard.assertCanCommit()).toThrow('Webhook execution is not active')
    await guard.taskCommitted('host-task')
    const settling = guard.launchSettled('host-task')
    await written.promise
    guard.release()
    expect(drained).toBe(false)
    releaseWrite.resolve()
    await settling
    await draining
    expect(await harness.db.select().from(webhookMrLaunchGuards)).toMatchObject([
      { status: 'launch-settled', taskId: 'host-task', launchOwnerKey: null },
    ])
    // A late call cannot silently append new work to an acknowledged lifetime.
    await expect(guard.taskCommitted('different-task')).rejects.toThrow('admission-released')
  })

  test('ordinary pause keeps launch abort, while waiting for its actual completion', async () => {
    await seedStream(harness)
    const f = compose(harness),
      g = grant(harness),
      handle = await f.owner.start(g)
    const guard = await f.runtime.reserveLaunch(launch)
    let stopped = false
    const stopping = Promise.resolve(handle.stop()).then(() => {
      stopped = true
    })
    expect(guard.signal.aborted).toBe(true)
    await Promise.resolve()
    expect(stopped).toBe(false)
    await guard.failed('provider-paused')
    guard.release()
    await stopping
    await handle.drain()
    expect((await harness.db.select().from(webhookMrLaunchGuards))[0]).toMatchObject({
      status: 'failed',
      error: 'provider-paused',
    })
  })

  test('boot recovery ACK is fenced before any due claim and can be retried by the next lifetime', async () => {
    await seedEffect(harness)
    const entered = deferred(),
      release = deferred()
    let held = true,
      applies = 0
    const f = compose(harness, {
      guards: (port) => ({
        ...port,
        async reconcileStaleOnBoot(now) {
          await port.reconcileStaleOnBoot(now)
          if (held) {
            held = false
            entered.resolve()
            await release.promise
          }
        },
      }),
      apply: async () => {
        applies++
        return [receipt]
      },
    })
    const g = grant(harness)
    const starting = f.owner.start(g).then(
      () => null,
      (error: unknown) => error,
    )
    await entered.promise
    g.lose()
    f.execution.quiesce(g.context)
    const draining = f.execution.awaitDrained(g.context)
    release.resolve()
    expect(await starting).toMatchObject({ code: 'webhook-mr-execution-unavailable' })
    await draining
    expect(applies).toBe(0)
    expect((await effect(harness)).attemptCount).toBe(0)
    const next = await f.owner.start(grant(harness))
    expect(applies).toBe(2)
    await next.stop()
    await next.drain()
  })

  test('exact claim settlement is transactional, retryable after ACK loss, and cannot free a newer lease', async () => {
    await seedEffect(harness)
    const port = createMrTerminalEffectPersistence(harness.db),
      now = Date.now()
    const claim = await port.claimNextDue({ workerId: 'same-worker', now, leaseMs: 30_000 })
    if (claim === null) throw new Error('fixture claim missing')
    const input = {
      claim,
      workerId: 'same-worker',
      status: 'pending' as const,
      nextAttemptAt: now,
      lastError: null,
      now,
    }
    await expect(
      harness.session.transaction(async () => {
        await port.settleClaim(input)
        throw new Error('fixture-rollback')
      }),
    ).rejects.toThrow('fixture-rollback')
    expect((await effect(harness)).status).toBe('leased')
    await port.settleClaim(input)
    await port.settleClaim(input)
    const next = await port.claimNextDue({ workerId: 'same-worker', now, leaseMs: 30_000 })
    expect(next?.attemptCount).toBe(2)
    await expect(port.settleClaim(input)).rejects.toThrow('settlement-lost')
    expect(await effect(harness)).toMatchObject({
      status: 'leased',
      attemptCount: 2,
      leaseOwner: 'same-worker',
    })
  })
})
