import { and, asc, eq, inArray, ne, or } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  hostedExecutionBindings,
  hostedExecutionEvents,
  runtimeSessionLeases,
  taskExecutionEffects,
  tasks,
} from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  BusinessResult,
  BusinessEvent,
  BusinessSubtask,
  SubmitBusinessSubtask,
} from '@/platform/crewstation/businessExecution'

export type HostedSubtaskRequest =
  | Omit<Extract<SubmitBusinessSubtask, { kind: 'agent' }>, 'fence' | 'requestKey'>
  | Omit<Extract<SubmitBusinessSubtask, { kind: 'command' }>, 'fence' | 'requestKey'>

export interface HostedExecutionIntent {
  readonly executionId: string
  readonly taskId: string
  readonly nodeRunId?: string
  readonly businessTaskId: string
  readonly requestKey: string
  readonly request: HostedSubtaskRequest
  readonly timeoutMs?: number
}

export interface HostedExecutionBinding extends HostedExecutionIntent {
  readonly subtaskId: string | null
  readonly attempt: number | null
  readonly materialDigest: string | null
  readonly lastCursor: string | null
  readonly result: BusinessResult | null
  readonly state: 'submitting' | 'running' | 'settled'
  readonly cancelRequested: boolean
  readonly cancelReason: 'user' | 'timeout' | null
  readonly createdAt: number
}

export interface HostedExecutionStore {
  prepare(intent: HostedExecutionIntent): Promise<HostedExecutionBinding>
  get(executionId: string): Promise<HostedExecutionBinding | null>
  unsettled(): Promise<readonly HostedExecutionBinding[]>
  journal(executionId: string, event: BusinessEvent): Promise<void>
  replay(executionId: string): Promise<readonly BusinessEvent[]>
  accepted(executionId: string, subtask: BusinessSubtask): Promise<HostedExecutionBinding>
  checkpoint(executionId: string, cursor: string, result?: BusinessResult): Promise<void>
  requestCancel(executionId: string, reason?: 'user' | 'timeout'): Promise<void>
  settle(executionId: string): Promise<void>
}

function decode(row: typeof hostedExecutionBindings.$inferSelect): HostedExecutionBinding {
  const frozen = JSON.parse(row.requestJson) as Pick<HostedExecutionIntent, 'request' | 'timeoutMs'>
  return {
    executionId: row.executionId,
    taskId: row.taskId,
    ...(row.nodeRunId === null ? {} : { nodeRunId: row.nodeRunId }),
    businessTaskId: row.businessTaskId,
    requestKey: row.requestKey,
    ...frozen,
    subtaskId: row.subtaskId,
    attempt: row.attempt,
    materialDigest: row.materialDigest,
    lastCursor: row.lastCursor,
    result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as BusinessResult),
    state: row.state,
    cancelRequested: row.cancelRequested,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt,
  }
}

/** Every mutation is fenced, including ACK/cursor/settlement. A late response
 * received by an old service slot cannot overwrite its successor's progress. */
export function createHostedExecutionStore(input: {
  readonly db: ProviderNeutralDatabase
  readonly fence: CrewStationMutationFence
  readonly now?: () => number
}): HostedExecutionStore {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const getIn = async (db: ProviderNeutralDatabase, executionId: string) => {
    const row = (
      await db
        .select()
        .from(hostedExecutionBindings)
        .where(eq(hostedExecutionBindings.executionId, executionId))
        .limit(1)
    )[0]
    return row === undefined ? null : decode(row)
  }
  const write = async <T>(
    operation: (tx: ProviderNeutralDatabase, epoch: number) => Promise<T>,
  ) => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return operation(tx, lease.epoch)
    })
  }
  const patch = async (
    executionId: string,
    values: Partial<typeof hostedExecutionBindings.$inferInsert>,
  ) => {
    await write(async (tx, epoch) => {
      if ((await getIn(tx, executionId)) === null)
        throw new Error('hosted-execution-binding-missing')
      await tx
        .update(hostedExecutionBindings)
        .set({ ...values, epoch, updatedAt: now() })
        .where(eq(hostedExecutionBindings.executionId, executionId))
    })
  }
  return {
    get: (executionId) => getIn(input.db, executionId),
    async journal(executionId, event) {
      await write(async (tx) => {
        await tx
          .insert(hostedExecutionEvents)
          .values({ executionId, cursor: event.cursor, eventJson: JSON.stringify(event) })
          .onConflictDoNothing()
      })
    },
    async replay(executionId) {
      const rows = await input.db
        .select({ eventJson: hostedExecutionEvents.eventJson })
        .from(hostedExecutionEvents)
        .where(eq(hostedExecutionEvents.executionId, executionId))
        .orderBy(asc(hostedExecutionEvents.id))
      return rows.map((row) => JSON.parse(row.eventJson) as BusinessEvent)
    },
    async unsettled() {
      const activeTasks = input.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.status, ['pending', 'running']))
      const heldRuns = input.db
        .select({ id: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
      const unresolvedEffects = input.db
        .select({ id: taskExecutionEffects.taskId })
        .from(taskExecutionEffects)
        .where(inArray(taskExecutionEffects.state, ['open', 'outcome-unknown']))
      const rows = await input.db
        .select()
        .from(hostedExecutionBindings)
        .where(
          or(
            ne(hostedExecutionBindings.state, 'settled'),
            inArray(hostedExecutionBindings.nodeRunId, heldRuns),
            inArray(hostedExecutionBindings.taskId, unresolvedEffects),
            inArray(hostedExecutionBindings.taskId, activeTasks),
          ),
        )
      return rows.map(decode)
    },
    async prepare(intent) {
      return write(async (tx, epoch) => {
        const requestJson = JSON.stringify({ request: intent.request, timeoutMs: intent.timeoutMs })
        await tx
          .insert(hostedExecutionBindings)
          .values({
            executionId: intent.executionId,
            taskId: intent.taskId,
            nodeRunId: intent.nodeRunId ?? null,
            businessTaskId: intent.businessTaskId,
            requestKey: intent.requestKey,
            requestJson,
            kind: intent.request.kind,
            state: 'submitting',
            epoch,
            createdAt: now(),
            updatedAt: now(),
          })
          .onConflictDoNothing()
        const existing = await getIn(tx, intent.executionId)
        if (existing === null) throw new Error('hosted-execution-binding-missing')
        if (
          existing.taskId !== intent.taskId ||
          existing.businessTaskId !== intent.businessTaskId ||
          existing.requestKey !== intent.requestKey ||
          JSON.stringify({ request: existing.request, timeoutMs: existing.timeoutMs }) !==
            requestJson
        ) {
          throw new Error('hosted-execution-intent-mismatch')
        }
        return existing
      })
    },
    async accepted(executionId, subtask) {
      return write(async (tx, epoch) => {
        const existing = await getIn(tx, executionId)
        if (existing === null) throw new Error('hosted-execution-binding-missing')
        if (
          existing.businessTaskId !== subtask.taskId ||
          existing.request.kind !== subtask.kind ||
          (existing.subtaskId !== null &&
            (existing.subtaskId !== subtask.id || existing.attempt !== subtask.attempt))
        ) {
          throw new Error('hosted-execution-receipt-mismatch')
        }
        await tx
          .update(hostedExecutionBindings)
          .set({
            subtaskId: subtask.id,
            attempt: subtask.attempt,
            materialDigest: subtask.materialDigest ?? null,
            state: existing.state === 'settled' ? 'settled' : 'running',
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedExecutionBindings.executionId, executionId))
        return (await getIn(tx, executionId))!
      })
    },
    checkpoint: (executionId, cursor, result) =>
      patch(executionId, {
        lastCursor: cursor,
        ...(result === undefined ? {} : { resultJson: JSON.stringify(result) }),
      }),
    async requestCancel(executionId, reason = 'user') {
      await write(async (tx, epoch) => {
        const existing = await getIn(tx, executionId)
        if (existing === null) throw new Error('hosted-execution-binding-missing')
        await tx
          .update(hostedExecutionBindings)
          .set({
            cancelRequested: true,
            cancelReason: existing.cancelReason ?? reason,
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedExecutionBindings.executionId, executionId))
      })
    },
    async settle(executionId) {
      await write(async (tx, epoch) => {
        const existing = await getIn(tx, executionId)
        if (existing?.result === null || existing === null)
          throw new Error('hosted-execution-result-missing')
        await tx
          .update(hostedExecutionBindings)
          .set({ state: 'settled', epoch, updatedAt: now() })
          .where(
            and(
              eq(hostedExecutionBindings.executionId, executionId),
              ne(hostedExecutionBindings.state, 'settled'),
            ),
          )
      })
    },
  }
}
