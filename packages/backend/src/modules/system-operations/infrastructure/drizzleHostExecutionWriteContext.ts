import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostExecutionWriteContexts } from '@/db/schema'
import {
  databaseSessionFor,
  databaseTransactionBelongsToClient,
  databaseTransactionIsActive,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  HostExecutionWriteContext,
  HostExecutionWriteReceipt,
} from '../application/ports/hostExecutionWriteContext'
import type { HostExecutionAuthorityReference } from '../application/ports/hostExecutionAuthority'

interface ReceiptIdentity {
  readonly holder: string
  readonly generation: string
  readonly revision: number
  readonly current: () => boolean
}

/** Each operation participates in the caller's original Task transaction. */
export interface HostExecutionWriteContextParticipant {
  consumeNewWork(tx: DatabaseTransaction, receipt: HostExecutionWriteReceipt): Promise<void>
  consumeRecovery(tx: DatabaseTransaction, receipt: HostExecutionWriteReceipt): Promise<void>
  consumeIssuedAck(tx: DatabaseTransaction, receipt: HostExecutionWriteReceipt): Promise<void>
}

const installationId = 'installation'

function unavailable(): Error {
  return new Error('host-execution-write-context-unavailable')
}

function assertExpiry(expiresAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw unavailable()
}

/** No provider fork, HTTP call, second transaction, or startup DDL. */
export function createDrizzleHostExecutionWriteContext(db: ProviderNeutralDatabase): Readonly<{
  context: HostExecutionWriteContext
  participant: HostExecutionWriteContextParticipant
}> {
  const receipts = new WeakMap<HostExecutionWriteReceipt, ReceiptIdentity>()
  const byGrant = new WeakMap<
    HostExecutionAuthorityReference,
    { readonly generation: string; readonly receipt: HostExecutionWriteReceipt }
  >()

  const identityFor = (receipt: HostExecutionWriteReceipt): ReceiptIdentity => {
    const identity = receipts.get(receipt)
    if (identity === undefined) throw unavailable()
    return identity
  }
  const assertCurrent = (identity: ReceiptIdentity): void => {
    if (!identity.current()) throw unavailable()
  }
  const exact = (identity: ReceiptIdentity) =>
    and(
      eq(hostExecutionWriteContexts.id, installationId),
      eq(hostExecutionWriteContexts.holder, identity.holder),
      eq(hostExecutionWriteContexts.generation, identity.generation),
      eq(hostExecutionWriteContexts.revision, identity.revision),
    )
  const lock = async (tx: DatabaseTransaction) => {
    await engineOf(tx).lockAggregateRoot(
      tx,
      hostExecutionWriteContexts,
      hostExecutionWriteContexts.id,
      installationId,
    )
  }
  const outsideTaskTransaction = () => {
    if (databaseTransactionIsActive(db)) {
      throw new Error('host-execution-write-context-control-inside-transaction')
    }
  }
  const readExact = async (tx: DatabaseTransaction, identity: ReceiptIdentity) => {
    await lock(tx)
    const rows = await tx.select().from(hostExecutionWriteContexts).where(exact(identity)).limit(1)
    const row = rows[0]
    if (row === undefined) throw unavailable()
    return row
  }

  const context = Object.freeze<HostExecutionWriteContext>({
    async prepare(input) {
      outsideTaskTransaction()
      const grantContext = input.context
      const { generation, reference, current } = grantContext
      const { holder, expiresAt } = input
      if (
        !generation ||
        !holder ||
        reference === null ||
        typeof reference !== 'object' ||
        typeof current !== 'function' ||
        !current.call(grantContext)
      ) {
        throw unavailable()
      }
      const originalCurrent = () => current.call(grantContext)
      assertExpiry(expiresAt)
      if (byGrant.has(reference)) throw unavailable()
      const identity = await databaseSessionFor(db).serializable(async (tx) => {
        // The initial insert needs the original aggregate lock too: on PG it
        // serializes absence, while the row lock owns later transitions.
        await engineOf(tx).advisoryLock(tx, 'host-execution-write-context')
        await lock(tx)
        const rows = await tx
          .select()
          .from(hostExecutionWriteContexts)
          .where(eq(hostExecutionWriteContexts.id, installationId))
          .limit(1)
        const prior = rows[0]
        if (prior !== undefined && prior.phase !== 'closed') throw unavailable()
        if (!originalCurrent()) throw unavailable()
        assertExpiry(expiresAt)
        const next = {
          id: installationId,
          holder,
          generation,
          revision: (prior?.revision ?? 0) + 1,
          phase: 'preparing' as const,
          expiresAt,
          updatedAt: Date.now(),
        }
        if (!Number.isSafeInteger(next.revision)) throw unavailable()
        if (prior === undefined) await tx.insert(hostExecutionWriteContexts).values(next)
        else
          await tx
            .update(hostExecutionWriteContexts)
            .set(next)
            .where(
              and(
                eq(hostExecutionWriteContexts.id, installationId),
                eq(hostExecutionWriteContexts.revision, prior.revision),
                eq(hostExecutionWriteContexts.phase, 'closed'),
              ),
            )
        if (!originalCurrent()) throw unavailable()
        assertExpiry(expiresAt)
        return {
          holder: next.holder,
          generation,
          revision: next.revision,
          current: originalCurrent,
        }
      })
      // Receipt registration follows the actual durable preparation ACK.
      const receipt = Object.freeze({}) as HostExecutionWriteReceipt
      receipts.set(receipt, Object.freeze(identity))
      byGrant.set(reference, Object.freeze({ generation, receipt }))
      return receipt
    },
    forGrant(input) {
      const grant = byGrant.get(input.reference)
      return grant?.generation === input.generation ? grant.receipt : undefined
    },
    async activate(receipt) {
      outsideTaskTransaction()
      const identity = identityFor(receipt)
      assertCurrent(identity)
      await databaseSessionFor(db).transaction(async (tx) => {
        const row = await readExact(tx, identity)
        assertCurrent(identity)
        if (row.phase !== 'preparing' && row.phase !== 'active') throw unavailable()
        assertExpiry(row.expiresAt)
        await tx
          .update(hostExecutionWriteContexts)
          .set({ phase: 'active', updatedAt: Date.now() })
          .where(exact(identity))
        assertCurrent(identity)
        assertExpiry(row.expiresAt)
      })
    },
    async renew(receipt, expiresAt) {
      outsideTaskTransaction()
      const identity = identityFor(receipt)
      assertCurrent(identity)
      assertExpiry(expiresAt)
      await databaseSessionFor(db).transaction(async (tx) => {
        const row = await readExact(tx, identity)
        assertCurrent(identity)
        if (row.phase !== 'preparing' && row.phase !== 'active') throw unavailable()
        assertExpiry(row.expiresAt)
        assertExpiry(expiresAt)
        if (expiresAt < row.expiresAt) throw unavailable()
        await tx
          .update(hostExecutionWriteContexts)
          .set({ expiresAt, updatedAt: Date.now() })
          .where(exact(identity))
        assertCurrent(identity)
        assertExpiry(expiresAt)
      })
    },
    async drain(receipt) {
      outsideTaskTransaction()
      const identity = identityFor(receipt)
      await databaseSessionFor(db).transaction(async (tx) => {
        const row = await readExact(tx, identity)
        if (row.phase === 'closed') throw unavailable()
        await tx
          .update(hostExecutionWriteContexts)
          .set({ phase: 'draining', updatedAt: Date.now() })
          .where(exact(identity))
      })
    },
    async retire(receipt) {
      outsideTaskTransaction()
      const identity = identityFor(receipt)
      await databaseSessionFor(db).transaction(async (tx) => {
        const row = await readExact(tx, identity)
        if (row.phase !== 'draining' && row.phase !== 'closed') throw unavailable()
        await tx
          .update(hostExecutionWriteContexts)
          .set({ phase: 'closed', updatedAt: Date.now() })
          .where(exact(identity))
      })
    },
  })

  const consume = async (
    tx: DatabaseTransaction,
    receipt: HostExecutionWriteReceipt,
    operation: 'new-work' | 'recovery' | 'issued-ack',
  ): Promise<void> => {
    if (!databaseTransactionBelongsToClient(db, tx)) throw unavailable()
    const identity = identityFor(receipt)
    if (operation !== 'issued-ack') assertCurrent(identity)
    const row = await readExact(tx, identity)
    if (operation === 'issued-ack') {
      if (row.phase !== 'active' && row.phase !== 'draining') throw unavailable()
    } else {
      assertCurrent(identity)
      if (row.phase !== (operation === 'recovery' ? 'preparing' : 'active')) throw unavailable()
      // Read after the actual lock ACK: time spent awaiting it cannot extend a lease.
      assertExpiry(row.expiresAt)
    }
    const changed = await tx
      .update(hostExecutionWriteContexts)
      .set({ updatedAt: Date.now() })
      .where(exact(identity))
      .returning({ expiresAt: hostExecutionWriteContexts.expiresAt })
    if (changed[0] === undefined) throw unavailable()
    if (operation !== 'issued-ack') {
      assertCurrent(identity)
      assertExpiry(changed[0].expiresAt)
    }
  }
  const participant = Object.freeze<HostExecutionWriteContextParticipant>({
    consumeNewWork: (tx, receipt) => consume(tx, receipt, 'new-work'),
    consumeRecovery: (tx, receipt) => consume(tx, receipt, 'recovery'),
    consumeIssuedAck: (tx, receipt) => consume(tx, receipt, 'issued-ack'),
  })
  return Object.freeze({ context, participant })
}
