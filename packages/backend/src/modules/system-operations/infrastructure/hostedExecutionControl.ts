// RFC-370 v2 §3.2 / §5.2, v3 V7 — the CrewStation lease and the database write
// window, mirrored in one application row.
//
// The platform rejects a stale `{epoch, leaseId, instanceId}`; this row makes
// the application reject it too, inside the same transaction that records a
// hosted effect (execution intent, cancellation, retry), so an instance whose
// lease has passed to a newer holder can no longer write one. Both checks have
// to hold for an effect to be valid.
//
// Locks (PostgreSQL; SQLite's BEGIN IMMEDIATE is already exclusive):
// - A holder (`assertHeld`, the write-window guard) takes the shared
//   write-window lock, then KEY SHARE on the row. Holders never wait for each
//   other, so fenced writes run concurrently.
// - Renewing the held lease is an in-place update of `expires_at`; it never
//   waits for holders, so a long transaction cannot push a renewal past expiry.
// - Any other transition (claim, activation, loss, freeze) locks the row FOR
//   UPDATE: it waits for every holder that relied on the previous state, and
//   holders that follow observe the new state.
// - Only a transition that closes or reopens the write window first takes the
//   exclusive write-window lock: every admitted write drains before the
//   platform is told the database is quiescent, and because advisory locks
//   queue in order, no later write can overtake it.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { and, eq, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  affectedRows,
  databaseSessionFor,
  engineOf,
} from '@/platform/persistence/databaseTransaction'
import { DomainError } from '@/util/errors'
import {
  HostedExecutionControlRegressionError,
  HostedExecutionControlStaleError,
  type HostedExecutionControlRecord,
  type HostedExecutionControlStore,
} from '../application/ports/hostedExecutionControl'
import type { ExecutionFence } from '../application/ports/executionAuthority'

const CONTROL_ID = 'global'

/** Shared by every hosted write transaction; exclusive only while the window closes or reopens. */
export const HOSTED_WRITE_WINDOW_LOCK = 'rfc370-hosted-database-write-window'

type ControlRow = PersistenceTables['hostedExecutionControl']['$inferSelect']

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

/** A hosted effect attempted without the lease: retryable once an instance holds it. */
export class HostedExecutionLeaseLostError extends DomainError {
  constructor(readonly reason: string) {
    super(
      'execution-standby',
      `this instance no longer holds the CrewStation execution lease (${reason})`,
      503,
      { reason },
    )
    this.name = 'HostedExecutionLeaseLostError'
  }
}

export interface HostedExecutionWriteBarrier {
  /** Inside the caller's transaction, prove `lease` is still this instance's
   * unexpired active lease, and hold it until the transaction ends; throws
   * `HostedExecutionLeaseLostError` otherwise. */
  assertHeld(tx: PersistenceDb, lease: HostedExecutionLease): Promise<void>
}

const readRow = async (db: PersistenceDb): Promise<ControlRow | undefined> => {
  const { hostedExecutionControl } = tablesOf(db)
  return (
    await db
      .select()
      .from(hostedExecutionControl)
      .where(eq(hostedExecutionControl.id, CONTROL_ID))
      .limit(1)
  )[0]
}

/**
 * Hold the control row for the rest of the caller's transaction and return it as
 * held. Every holder uses this one lock order (the shared window lock, then the
 * row), so a closing window and a holder can never deadlock.
 */
export async function holdHostedExecutionControl(
  tx: PersistenceDb,
): Promise<ControlRow | undefined> {
  const engine = engineOf(tx)
  await engine.advisoryLockShared(tx, HOSTED_WRITE_WINDOW_LOCK)
  const { hostedExecutionControl } = tablesOf(tx)
  await engine.holdAggregateRoot(tx, hostedExecutionControl, hostedExecutionControl.id, CONTROL_ID)
  return await readRow(tx)
}

function decode(row: ControlRow): HostedExecutionControlRecord {
  return {
    epoch: row.epoch,
    owner: row.owner,
    phase: row.phase,
    leaseId: row.leaseId,
    expiresAt: row.expiresAt,
    ...(row.migrationOperationId === null
      ? {}
      : { migrationOperationId: row.migrationOperationId }),
  }
}

/** A migration freeze closes the window, a lease loss keeps it, a claim reopens it. */
function windowAfter(
  stored: ControlRow | undefined,
  record: HostedExecutionControlRecord,
): string | null {
  if (record.migrationOperationId !== undefined) return record.migrationOperationId
  if (record.phase === 'frozen') return stored?.migrationOperationId ?? null
  return null
}

function unchanged(
  row: ControlRow,
  record: HostedExecutionControlRecord,
  window: string | null,
): boolean {
  return (
    row.epoch === record.epoch &&
    row.owner === record.owner &&
    row.phase === record.phase &&
    row.leaseId === record.leaseId &&
    row.migrationOperationId === window &&
    (record.expiresAt === null
      ? row.expiresAt === null
      : row.expiresAt !== null && row.expiresAt >= record.expiresAt)
  )
}

/** The epoch only grows; within one epoch the lease never moves back or to another holder. */
function assertProgress(row: ControlRow, record: HostedExecutionControlRecord): void {
  if (row.epoch > record.epoch) throw new HostedExecutionControlStaleError(row.epoch, record.epoch)
  if (row.epoch < record.epoch) return
  if (
    (row.phase === 'frozen' && record.phase !== 'frozen') ||
    (row.phase === 'active' && record.phase === 'preparing') ||
    (row.owner !== null && record.owner !== null && row.owner !== record.owner) ||
    (row.leaseId !== null && record.leaseId !== null && row.leaseId !== record.leaseId)
  ) {
    throw new HostedExecutionControlRegressionError()
  }
}

export function createDatabaseHostedExecutionControl(input: {
  readonly db: PersistenceDb
  readonly now?: () => number
}): HostedExecutionControlStore & HostedExecutionWriteBarrier {
  const session = databaseSessionFor(input.db)
  const engine = session.engine
  const now = input.now ?? Date.now

  /** The held lease only moves its expiry forward: no row lock, so no holder delays it. */
  const renew = async (record: HostedExecutionControlRecord): Promise<boolean> => {
    if (
      record.phase !== 'active' ||
      record.owner === null ||
      record.leaseId === null ||
      record.expiresAt === null ||
      record.migrationOperationId !== undefined
    ) {
      return false
    }
    const { owner, leaseId, expiresAt } = record
    return await session.transaction(async (tx) => {
      const { hostedExecutionControl } = tablesOf(tx)
      const result = await tx
        .update(hostedExecutionControl)
        .set({
          // Monotonic even if a slower renewal lands after a newer one.
          expiresAt: engine.greatest(
            sql`coalesce(${hostedExecutionControl.expiresAt}, 0)`,
            sql`${expiresAt}`,
          ),
          updatedAt: now(),
        })
        .where(
          and(
            eq(hostedExecutionControl.id, CONTROL_ID),
            eq(hostedExecutionControl.epoch, record.epoch),
            eq(hostedExecutionControl.phase, 'active'),
            eq(hostedExecutionControl.owner, owner),
            eq(hostedExecutionControl.leaseId, leaseId),
          ),
        )
      return affectedRows(result) === 1
    })
  }

  /** One attempt; 'retry' when the window changed between the unlocked read and the row lock. */
  const transition = (record: HostedExecutionControlRecord): Promise<'done' | 'retry'> =>
    session.transaction(async (tx) => {
      const observed = await readRow(tx)
      const window = windowAfter(observed, record)
      if (observed !== undefined && unchanged(observed, record, window)) return 'done'
      const movesWindow = window !== (observed?.migrationOperationId ?? null)
      // Same lock order as every holder: the window lock before the row.
      if (movesWindow) await engine.advisoryLock(tx, HOSTED_WRITE_WINDOW_LOCK)
      const { hostedExecutionControl } = tablesOf(tx)
      await tx
        .insert(hostedExecutionControl)
        .values({
          id: CONTROL_ID,
          epoch: record.epoch,
          owner: record.owner,
          phase: record.phase,
          leaseId: record.leaseId,
          expiresAt: record.expiresAt,
          migrationOperationId: window,
          updatedAt: now(),
        })
        .onConflictDoNothing()
      await engine.lockAggregateRoot(
        tx,
        hostedExecutionControl,
        hostedExecutionControl.id,
        CONTROL_ID,
      )
      const row = await readRow(tx)
      if (row === undefined) throw new Error('hosted execution control row is missing')
      const lockedWindow = windowAfter(row, record)
      if (!movesWindow && lockedWindow !== row.migrationOperationId) return 'retry'
      assertProgress(row, record)
      const keepsExpiry =
        record.phase === 'active' &&
        row.epoch === record.epoch &&
        row.expiresAt !== null &&
        record.expiresAt !== null
      await tx
        .update(hostedExecutionControl)
        .set({
          epoch: record.epoch,
          owner: record.owner,
          phase: record.phase,
          leaseId: record.leaseId,
          expiresAt: keepsExpiry ? Math.max(row.expiresAt!, record.expiresAt!) : record.expiresAt,
          migrationOperationId: lockedWindow,
          updatedAt: now(),
        })
        .where(eq(hostedExecutionControl.id, CONTROL_ID))
      return 'done'
    })

  return Object.freeze({
    async read() {
      const row = await readRow(input.db)
      return row === undefined ? null : decode(row)
    },
    async write(record: HostedExecutionControlRecord) {
      if (await renew(record)) return
      if ((await transition(record)) === 'done') return
      // The window moved concurrently: take the window lock this time.
      if ((await transition(record)) === 'retry') {
        throw new Error('hosted execution control write window changed concurrently')
      }
    },
    async assertHeld(tx: PersistenceDb, lease: HostedExecutionLease) {
      const row = await holdHostedExecutionControl(tx)
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
