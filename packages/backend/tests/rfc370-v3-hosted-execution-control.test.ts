// RFC-370 v3 V7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9):
// the hosted execution-control row carries both the CrewStation lease and the
// database write window (the separate `hosted_schema_write_window` table and
// the per-write schema digest check are gone).
//
// Locks the store's semantics on both engines: a renewal only moves the expiry
// forward; the epoch never goes back and one epoch never regresses or changes
// holder; a migration freeze closes the window, a lease-loss freeze keeps it,
// the next claim reopens it; an identical record writes nothing; every
// `assertHeld` refusal is a retryable `execution-standby`; the write-window
// guard refuses writes only once enforcement starts (boot convergence precedes
// it) and only while the window is closed; and a guard that follows its own
// lease refuses every write once the lease is lost or taken over. The
// PostgreSQL lock behaviour is in `rfc370-v3-hosted-write-window.integration.test.ts`.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  HostedExecutionControlRegressionError,
  HostedExecutionControlStaleError,
} from '@/modules/system-operations/application/ports/hostedExecutionControl'
import {
  createHostedDatabaseWriteBarrier,
  HostedDatabaseWriteUnavailableError,
} from '@/modules/system-operations/infrastructure/crewstation/databaseWriteBarrier'
import {
  createDatabaseHostedExecutionControl,
  encodeHostedFenceToken,
  HostedExecutionLeaseLostError,
} from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import type { ExecutionAuthorityState } from '@/modules/system-operations/application/ports/executionAuthority'
import { describeEachProvider } from './helpers/eachProvider'

const lease = { epoch: 3, leaseId: 'lease-3', instanceId: 'instance-a' }

describeEachProvider('RFC-370 v3 hosted execution control row', (harness) => {
  let clock = 1_000_000
  const control = () => createDatabaseHostedExecutionControl({ db: harness.db, now: () => clock })
  const row = async () => {
    const { hostedExecutionControl } = tablesOf(harness.db)
    return (
      await harness.db
        .select()
        .from(hostedExecutionControl)
        .where(eq(hostedExecutionControl.id, 'global'))
    )[0]
  }
  const activate = async (expiresAt = clock + 30_000) => {
    const store = control()
    for (const phase of ['preparing', 'active'] as const)
      await store.write({
        epoch: lease.epoch,
        owner: lease.instanceId,
        leaseId: lease.leaseId,
        phase,
        expiresAt,
      })
    return store
  }
  const held = (store: ReturnType<typeof control>, value = lease) =>
    harness.session.transaction((tx) => store.assertHeld(tx, value))

  test('a renewal only moves the expiry of the held lease forward', async () => {
    const store = await activate(clock + 30_000)
    await store.write({
      ...lease,
      owner: lease.instanceId,
      phase: 'active',
      expiresAt: clock + 40_000,
    })
    expect((await row())?.expiresAt).toBe(clock + 40_000)
    // A slower renewal that lands after a newer one never shortens the lease.
    await store.write({
      ...lease,
      owner: lease.instanceId,
      phase: 'active',
      expiresAt: clock + 35_000,
    })
    expect((await row())?.expiresAt).toBe(clock + 40_000)
    await expect(held(store)).resolves.toBeUndefined()
  })

  test('an older epoch is stale and one epoch never regresses or changes holder', async () => {
    const store = await activate()
    await expect(
      store.write({
        epoch: 2,
        owner: 'old',
        leaseId: 'old',
        phase: 'active',
        expiresAt: clock + 1,
      }),
    ).rejects.toBeInstanceOf(HostedExecutionControlStaleError)
    await expect(
      store.write({ ...lease, owner: lease.instanceId, phase: 'preparing', expiresAt: clock + 1 }),
    ).rejects.toBeInstanceOf(HostedExecutionControlRegressionError)
    await expect(
      store.write({ ...lease, owner: 'instance-b', phase: 'active', expiresAt: clock + 50_000 }),
    ).rejects.toBeInstanceOf(HostedExecutionControlRegressionError)
    expect(await row()).toMatchObject({ epoch: 3, owner: 'instance-a', phase: 'active' })
  })

  test('a migration freeze closes the window, a lease loss keeps it, the next claim reopens it', async () => {
    const store = await activate()
    await store.write({
      epoch: 4,
      owner: null,
      leaseId: null,
      phase: 'frozen',
      expiresAt: null,
      migrationOperationId: 'restore-1',
    })
    expect(await store.read()).toEqual({
      epoch: 4,
      owner: null,
      leaseId: null,
      phase: 'frozen',
      expiresAt: null,
      migrationOperationId: 'restore-1',
    })
    // A frozen record without an operation (a lease loss) keeps the window.
    await store.write({ epoch: 4, owner: null, leaseId: null, phase: 'frozen', expiresAt: null })
    expect((await row())?.migrationOperationId).toBe('restore-1')
    // A frozen epoch can only be left by a newer claim, which reopens the window.
    await expect(
      store.write({
        epoch: 4,
        owner: 'instance-b',
        leaseId: 'lease-4',
        phase: 'preparing',
        expiresAt: clock + 1,
      }),
    ).rejects.toBeInstanceOf(HostedExecutionControlRegressionError)
    await store.write({
      epoch: 5,
      owner: 'instance-b',
      leaseId: 'lease-5',
      phase: 'preparing',
      expiresAt: clock + 30_000,
    })
    expect(await row()).toMatchObject({ epoch: 5, phase: 'preparing', migrationOperationId: null })
    expect((await store.read())?.migrationOperationId).toBeUndefined()
  })

  test('an identical record writes nothing', async () => {
    const store = await activate()
    await store.write({
      epoch: 4,
      owner: null,
      leaseId: null,
      phase: 'frozen',
      expiresAt: null,
      migrationOperationId: 'migration-1',
    })
    const before = await row()
    clock += 5_000
    await store.write({
      epoch: 4,
      owner: null,
      leaseId: null,
      phase: 'frozen',
      expiresAt: null,
      migrationOperationId: 'migration-1',
    })
    expect((await row())?.updatedAt).toBe(before?.updatedAt)
  })

  test('every assertHeld refusal names its reason and is a retryable execution-standby', async () => {
    const store = control()
    const refusal = async (reason: string, value = lease) => {
      const error = await held(store, value).then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(HostedExecutionLeaseLostError)
      expect(error).toMatchObject({ code: 'execution-standby', status: 503, details: { reason } })
    }
    await refusal('no lease recorded')
    await activate(clock + 30_000)
    await expect(held(store)).resolves.toBeUndefined()
    await refusal('epoch changed', { ...lease, epoch: 2 })
    await refusal('held by another instance', { ...lease, instanceId: 'instance-b' })
    await refusal('held by another instance', { ...lease, leaseId: 'lease-other' })
    clock += 30_000
    await refusal('lease expired')
    await store.write({
      epoch: 3,
      owner: lease.instanceId,
      leaseId: lease.leaseId,
      phase: 'frozen',
      expiresAt: null,
    })
    await refusal('phase frozen')
  })

  test('the write window refuses only enforced writes, and only while it is closed', async () => {
    const store = await activate()
    const booting = createHostedDatabaseWriteBarrier({ enforcing: false })
    const serving = createHostedDatabaseWriteBarrier()
    const guard = (barrier: typeof serving) =>
      harness.session.transaction((tx) => barrier.beforeWrite(tx))
    await expect(guard(serving)).resolves.toBeUndefined()
    await store.write({
      epoch: 4,
      owner: null,
      leaseId: null,
      phase: 'frozen',
      expiresAt: null,
      migrationOperationId: 'migration-7',
    })
    const refused = await guard(serving).then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(refused).toBeInstanceOf(HostedDatabaseWriteUnavailableError)
    expect(refused).toMatchObject({
      code: 'hosted-database-write-unavailable',
      status: 503,
      details: { operationId: 'migration-7' },
    })
    // Boot convergence precedes enforcement: an instance restarted during the
    // freeze can finish booting into read-only standby.
    await expect(guard(booting)).resolves.toBeUndefined()
    booting.enforce()
    await expect(guard(booting)).rejects.toBeInstanceOf(HostedDatabaseWriteUnavailableError)
    const { hostedExecutionControl } = tablesOf(harness.db)
    // A database without any control row (standalone-shaped) is never refused.
    await harness.db.delete(hostedExecutionControl)
    await expect(guard(serving)).resolves.toBeUndefined()
  })

  // RFC-370 §3.2 crash-only (2026-10-17 hosted acceptance): the instance that
  // lost a handoff kept writing after its lease was gone — it stamped
  // `merge-failed` on a run whose merge-back command it had only detached, and
  // the resumed task failed on it. Following its own lease, the barrier refuses
  // every write once the lease is lost, and while it is still held as soon as
  // the control row names a newer holder.
  test('a barrier that follows its lease refuses writes once the lease is lost or taken over', async () => {
    const store = await activate()
    const barrier = createHostedDatabaseWriteBarrier()
    let state: ExecutionAuthorityState = { kind: 'standby', reason: 'execution-lease-pending' }
    const listeners: Array<(next: ExecutionAuthorityState) => void> = []
    barrier.follow({
      current: () => state,
      onLost(listener) {
        listeners.push(listener)
        return () => undefined
      },
    })
    const guard = () => harness.session.transaction((tx) => barrier.beforeWrite(tx))
    const refusal = async (reason: string) => {
      const error = await guard().then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(HostedExecutionLeaseLostError)
      expect(error).toMatchObject({ code: 'execution-standby', status: 503, details: { reason } })
    }
    // A standby keeps its resource writes; so does the holder of the lease.
    await expect(guard()).resolves.toBeUndefined()
    state = { kind: 'active', fence: { epoch: lease.epoch, token: encodeHostedFenceToken(lease) } }
    await expect(guard()).resolves.toBeUndefined()
    // A newer holder claims before this instance's renewal notices the handoff.
    const successor = { epoch: lease.epoch + 1, owner: 'instance-b', leaseId: 'lease-4' } as const
    await store.write({ ...successor, phase: 'preparing', expiresAt: clock + 30_000 })
    await refusal('held by another instance')
    // Once the lease is lost nothing is admitted again, whatever the row says.
    state = { kind: 'frozen', reason: 'execution-frozen-by-platform' }
    for (const listener of listeners) listener(state)
    await refusal('execution-frozen-by-platform')
    await store.write({ ...successor, phase: 'active', expiresAt: clock + 30_000 })
    await refusal('execution-frozen-by-platform')
    expect(() => barrier.follow({ current: () => state, onLost: () => () => undefined })).toThrow(
      'the write barrier already follows a lease',
    )
  })

  test('the window can only be closed on a frozen record', async () => {
    await activate()
    // A drizzle query is a thenable, not a Promise: await it inside one.
    await expect(
      (async () => {
        const { hostedExecutionControl } = tablesOf(harness.db)
        await harness.db
          .update(hostedExecutionControl)
          .set({ migrationOperationId: 'migration-x' })
          .where(eq(hostedExecutionControl.id, 'global'))
      })(),
    ).rejects.toThrow()
  })
})
