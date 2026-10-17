import { asc, eq, inArray } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedRecoveryRequests } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  CrewStationRecoveryRequest,
  type CrewStationRecoveryReceipt,
} from '@/platform/crewstation/recovery'

export type HostedRecoveryState = 'admitted' | 'executing' | 'succeeded' | 'failed' | 'rejected'
export const TERMINAL_HOSTED_RECOVERY_STATES: readonly HostedRecoveryState[] = [
  'succeeded',
  'failed',
  'rejected',
]

export interface HostedRecoveryRecord {
  readonly requestId: string
  readonly request: CrewStationRecoveryRequest
  readonly businessTaskId: string
  readonly taskId: string | null
  readonly actorUserId: string | null
  readonly state: HostedRecoveryState
  readonly receipt: CrewStationRecoveryReceipt | null
  readonly reason: string | null
  readonly createdAt: number
}

export interface HostedRecoveryJournal {
  get(requestId: string): Promise<HostedRecoveryRecord | null>
  /** Requests this installation admitted and has not finished. */
  active(): Promise<readonly HostedRecoveryRecord[]>
  /** Idempotent: a repeated admission returns the stored record. */
  admit(input: {
    readonly request: CrewStationRecoveryRequest
    readonly taskId: string | null
    readonly actorUserId: string | null
  }): Promise<HostedRecoveryRecord>
  executing(requestId: string, receipt: CrewStationRecoveryReceipt): Promise<void>
  finish(
    requestId: string,
    state: 'succeeded' | 'failed' | 'rejected',
    reason?: string,
  ): Promise<void>
}

function decode(row: typeof hostedRecoveryRequests.$inferSelect): HostedRecoveryRecord {
  return {
    requestId: row.requestId,
    request: CrewStationRecoveryRequest.parse(JSON.parse(row.requestJson)),
    businessTaskId: row.businessTaskId,
    taskId: row.taskId,
    actorUserId: row.actorUserId,
    state: row.state,
    receipt:
      row.receiptJson === null ? null : (JSON.parse(row.receiptJson) as CrewStationRecoveryReceipt),
    reason: row.reason,
    createdAt: row.createdAt,
  }
}

export function createHostedRecoveryJournal(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly now?: () => number
}): HostedRecoveryJournal {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const write = async <T>(work: (tx: ProviderNeutralDatabase, epoch: number) => Promise<T>) => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return work(tx, lease.epoch)
    })
  }
  const read = async (db: ProviderNeutralDatabase, requestId: string) => {
    const row = (
      await db
        .select()
        .from(hostedRecoveryRequests)
        .where(eq(hostedRecoveryRequests.requestId, requestId))
        .limit(1)
    )[0]
    return row === undefined ? null : decode(row)
  }
  return {
    get: (requestId) => read(input.db, requestId),
    async active() {
      const rows = await input.db
        .select()
        .from(hostedRecoveryRequests)
        .where(inArray(hostedRecoveryRequests.state, ['admitted', 'executing']))
        .orderBy(asc(hostedRecoveryRequests.createdAt))
      return rows.map(decode)
    },
    async admit({ request, taskId, actorUserId }) {
      return write(async (tx, epoch) => {
        await tx
          .insert(hostedRecoveryRequests)
          .values({
            requestId: request.id,
            requestJson: JSON.stringify(request),
            businessTaskId: request.target.taskId,
            taskId,
            actorUserId,
            state: 'admitted',
            epoch,
            createdAt: now(),
            updatedAt: now(),
          })
          .onConflictDoNothing()
        return (await read(tx, request.id))!
      })
    },
    async executing(requestId, receipt) {
      await write(async (tx, epoch) => {
        await tx
          .update(hostedRecoveryRequests)
          .set({
            state: 'executing',
            receiptJson: JSON.stringify(receipt),
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedRecoveryRequests.requestId, requestId))
      })
    },
    async finish(requestId, state, reason) {
      await write(async (tx, epoch) => {
        await tx
          .update(hostedRecoveryRequests)
          .set({
            state,
            reason: reason === undefined ? null : reason.slice(0, 1024),
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedRecoveryRequests.requestId, requestId))
      })
    },
  }
}
