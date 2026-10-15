// RFC-370 v2 §3.2 / §5.2 — the CrewStation lease mirrored in the application
// database, and the write barrier that checks it.
//
// The platform rejects a stale `{epoch, leaseId, instanceId}`; this row makes
// the application reject it too, inside the same transaction that records a
// hosted effect (execution intent, cancellation, retry), so an instance whose
// lease has passed to a newer holder can no longer write one. Both checks have
// to hold for an effect to be valid.
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedExecutionControl } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  HostedExecutionControlStaleError,
  type HostedExecutionControlRecord,
  type HostedExecutionControlStore,
} from '../application/ports/hostedExecutionControl'
import type { ExecutionFence } from '../application/ports/executionAuthority'

const CONTROL_ID = 'global'

/** The platform fence an execution mutation carries. */
export interface HostedExecutionLease {
  readonly epoch: number
  readonly leaseId: string
  readonly instanceId: string
}

/** A hosted fence token is `leaseId/instanceId` (both are platform / UUID ids). */
export function encodeHostedFenceToken(
  lease: Pick<HostedExecutionLease, 'leaseId' | 'instanceId'>,
): string {
  return `${lease.leaseId}/${lease.instanceId}`
}

export function hostedLeaseOf(fence: ExecutionFence): HostedExecutionLease {
  const slash = fence.token.indexOf('/')
  if (slash <= 0 || slash === fence.token.length - 1) {
    throw new Error('execution fence is not a CrewStation lease')
  }
  return {
    epoch: fence.epoch,
    leaseId: fence.token.slice(0, slash),
    instanceId: fence.token.slice(slash + 1),
  }
}

export class HostedExecutionLeaseLostError extends Error {
  constructor(readonly reason: string) {
    super(`this instance no longer holds the CrewStation execution lease (${reason})`)
    this.name = 'HostedExecutionLeaseLostError'
  }
}

export interface HostedExecutionWriteBarrier {
  /** Inside the caller's transaction, prove `lease` is still this instance's
   * unexpired active lease; throws `HostedExecutionLeaseLostError` otherwise. */
  assertHeld(tx: ProviderNeutralDatabase, lease: HostedExecutionLease): Promise<void>
}

export function createDatabaseHostedExecutionControl(input: {
  readonly db: ProviderNeutralDatabase
  readonly now?: () => number
}): HostedExecutionControlStore & HostedExecutionWriteBarrier {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const decode = (
    row: typeof hostedExecutionControl.$inferSelect,
  ): HostedExecutionControlRecord => ({
    epoch: row.epoch,
    owner: row.owner,
    phase: row.phase,
    leaseId: row.leaseId,
    expiresAt: row.expiresAt,
  })
  const lockedRow = async (tx: ProviderNeutralDatabase) => {
    await session.engine.lockAggregateRoot(
      tx,
      hostedExecutionControl,
      hostedExecutionControl.id,
      CONTROL_ID,
    )
    return (
      await tx
        .select()
        .from(hostedExecutionControl)
        .where(eq(hostedExecutionControl.id, CONTROL_ID))
        .limit(1)
    )[0]
  }
  return Object.freeze({
    async read() {
      const row = (
        await input.db
          .select()
          .from(hostedExecutionControl)
          .where(eq(hostedExecutionControl.id, CONTROL_ID))
          .limit(1)
      )[0]
      return row === undefined ? null : decode(row)
    },
    async write(record: HostedExecutionControlRecord) {
      await session.transaction(async (tx) => {
        const values = {
          epoch: record.epoch,
          owner: record.owner,
          phase: record.phase,
          leaseId: record.leaseId,
          expiresAt: record.expiresAt,
          updatedAt: now(),
        }
        await tx
          .insert(hostedExecutionControl)
          .values({ id: CONTROL_ID, ...values })
          .onConflictDoNothing()
        const row = await lockedRow(tx)
        if (row === undefined) throw new Error('hosted execution control row is missing')
        if (row.epoch > record.epoch) {
          throw new HostedExecutionControlStaleError(row.epoch, record.epoch)
        }
        if (row.epoch === record.epoch) {
          if (
            (row.phase === 'frozen' && record.phase !== 'frozen') ||
            (row.phase === 'active' && record.phase === 'preparing') ||
            (row.owner !== null && record.owner !== null && row.owner !== record.owner) ||
            (row.leaseId !== null && record.leaseId !== null && row.leaseId !== record.leaseId)
          ) {
            throw new Error('hosted-execution-control-phase-regression')
          }
          if (record.phase === 'active' && row.expiresAt !== null && values.expiresAt !== null) {
            values.expiresAt = Math.max(row.expiresAt, values.expiresAt)
          }
        }
        await tx
          .update(hostedExecutionControl)
          .set(values)
          .where(eq(hostedExecutionControl.id, CONTROL_ID))
      })
    },
    async assertHeld(tx: ProviderNeutralDatabase, lease: HostedExecutionLease) {
      const row = await lockedRow(tx)
      if (row === undefined) throw new HostedExecutionLeaseLostError('no lease recorded')
      if (row.epoch !== lease.epoch) throw new HostedExecutionLeaseLostError('epoch changed')
      if (row.phase !== 'active') throw new HostedExecutionLeaseLostError(`phase ${row.phase}`)
      if (row.owner !== lease.instanceId || row.leaseId !== lease.leaseId) {
        throw new HostedExecutionLeaseLostError('held by another instance')
      }
      if (row.expiresAt === null || row.expiresAt <= now()) {
        throw new HostedExecutionLeaseLostError('lease expired')
      }
    },
  })
}
