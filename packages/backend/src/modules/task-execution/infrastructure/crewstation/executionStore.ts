import { and, asc, eq, ne } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedExecutionBindings, hostedExecutionEvents } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { freezeHostedAgentContext, type HostedAgentContext } from './agentContext'
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
  readonly agentContext?: HostedAgentContext
}

/** Why a platform cancel was requested. `restored`: the binding came from a
 * restored database snapshot; it is stopped and settled, never resumed (§9.2 V5). */
export type HostedCancelReason = 'user' | 'timeout' | 'restored'

export interface HostedExecutionBinding extends HostedExecutionIntent {
  readonly subtaskId: string | null
  readonly attempt: number | null
  readonly materialDigest: string | null
  readonly lastCursor: string | null
  readonly result: BusinessResult | null
  readonly state: 'submitting' | 'running' | 'settled'
  readonly cancelRequested: boolean
  readonly cancelReason: HostedCancelReason | null
  /** Execution-authority epoch of the last writer. */
  readonly epoch: number
  readonly createdAt: number
}

export interface HostedExecutionStore {
  prepare(intent: HostedExecutionIntent): Promise<HostedExecutionBinding>
  get(executionId: string): Promise<HostedExecutionBinding | null>
  /** Every binding whose owner has not yet committed a settled projection. */
  unsettled(): Promise<readonly HostedExecutionBinding[]>
  replay(executionId: string): Promise<readonly BusinessEvent[]>
  accepted(executionId: string, subtask: BusinessSubtask): Promise<HostedExecutionBinding>
  /** One transaction: the event is journaled and the cursor (and the result,
   * when this event carries it) advance together. */
  record(executionId: string, event: BusinessEvent): Promise<void>
  requestCancel(executionId: string, reason?: HostedCancelReason): Promise<void>
  settle(executionId: string): Promise<void>
  /** Ends a binding whose remote outcome can no longer be observed (expired
   * history, rejected request): the synthetic result never reads as success. */
  abandon(executionId: string, reason: string): Promise<void>
}

function decode(row: typeof hostedExecutionBindings.$inferSelect): HostedExecutionBinding {
  const frozen = JSON.parse(row.requestJson) as Pick<
    HostedExecutionIntent,
    'request' | 'timeoutMs' | 'agentContext'
  >
  return {
    executionId: row.executionId,
    taskId: row.taskId,
    ...(row.nodeRunId === null ? {} : { nodeRunId: row.nodeRunId }),
    businessTaskId: row.businessTaskId,
    requestKey: row.requestKey,
    request: frozen.request,
    ...(frozen.timeoutMs === undefined ? {} : { timeoutMs: frozen.timeoutMs }),
    ...(frozen.agentContext === undefined
      ? {}
      : { agentContext: freezeHostedAgentContext(frozen.agentContext) }),
    subtaskId: row.subtaskId,
    attempt: row.attempt,
    materialDigest: row.materialDigest,
    lastCursor: row.lastCursor,
    result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as BusinessResult),
    state: row.state,
    cancelRequested: row.cancelRequested,
    cancelReason: row.cancelReason,
    epoch: row.epoch,
    createdAt: row.createdAt,
  }
}

/** Mutations run under the execution fence, so a late response observed by an
 * old service slot cannot overwrite its successor's progress. */
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
  const existing = async (tx: ProviderNeutralDatabase, executionId: string) => {
    const binding = await getIn(tx, executionId)
    if (binding === null) throw new Error('hosted-execution-binding-missing')
    return binding
  }
  return {
    get: (executionId) => getIn(input.db, executionId),
    async replay(executionId) {
      const rows = await input.db
        .select({ eventJson: hostedExecutionEvents.eventJson })
        .from(hostedExecutionEvents)
        .where(eq(hostedExecutionEvents.executionId, executionId))
        .orderBy(asc(hostedExecutionEvents.id))
      return rows.map((row) => JSON.parse(row.eventJson) as BusinessEvent)
    },
    async unsettled() {
      const rows = await input.db
        .select()
        .from(hostedExecutionBindings)
        .where(ne(hostedExecutionBindings.state, 'settled'))
      return rows.map(decode)
    },
    async prepare(intent) {
      const agentContext =
        intent.agentContext === undefined
          ? undefined
          : freezeHostedAgentContext(intent.agentContext)
      if (agentContext !== undefined && intent.request.kind !== 'agent')
        throw new Error('hosted-command-agent-context-invalid')
      if (agentContext?.node !== undefined && agentContext.node.id !== intent.nodeRunId)
        throw new Error('hosted-agent-context-node-mismatch')
      return write(async (tx, epoch) => {
        const requestJson = JSON.stringify({
          request: intent.request,
          timeoutMs: intent.timeoutMs,
          agentContext,
        })
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
        const binding = await existing(tx, intent.executionId)
        if (
          binding.taskId !== intent.taskId ||
          binding.nodeRunId !== intent.nodeRunId ||
          binding.businessTaskId !== intent.businessTaskId ||
          binding.requestKey !== intent.requestKey ||
          JSON.stringify({
            request: binding.request,
            timeoutMs: binding.timeoutMs,
            agentContext: binding.agentContext,
          }) !== requestJson
        ) {
          throw new Error('hosted-execution-intent-mismatch')
        }
        return binding
      })
    },
    async accepted(executionId, subtask) {
      return write(async (tx, epoch) => {
        const binding = await existing(tx, executionId)
        if (
          binding.businessTaskId !== subtask.taskId ||
          binding.request.kind !== subtask.kind ||
          (binding.subtaskId !== null &&
            (binding.subtaskId !== subtask.id || binding.attempt !== subtask.attempt))
        ) {
          throw new Error('hosted-execution-receipt-mismatch')
        }
        await tx
          .update(hostedExecutionBindings)
          .set({
            subtaskId: subtask.id,
            attempt: subtask.attempt,
            materialDigest: subtask.materialDigest ?? null,
            state: binding.state === 'settled' ? 'settled' : 'running',
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedExecutionBindings.executionId, executionId))
        return (await getIn(tx, executionId))!
      })
    },
    async record(executionId, event) {
      await write(async (tx, epoch) => {
        await tx
          .insert(hostedExecutionEvents)
          .values({ executionId, cursor: event.cursor, eventJson: JSON.stringify(event) })
          .onConflictDoNothing()
        await tx
          .update(hostedExecutionBindings)
          .set({
            lastCursor: event.cursor,
            ...(event.type === 'result' ? { resultJson: JSON.stringify(event.data) } : {}),
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedExecutionBindings.executionId, executionId))
      })
    },
    async requestCancel(executionId, reason = 'user') {
      await write(async (tx, epoch) => {
        const binding = await existing(tx, executionId)
        await tx
          .update(hostedExecutionBindings)
          .set({
            cancelRequested: true,
            cancelReason: binding.cancelReason ?? reason,
            epoch,
            updatedAt: now(),
          })
          .where(eq(hostedExecutionBindings.executionId, executionId))
      })
    },
    async settle(executionId) {
      await write(async (tx, epoch) => {
        const binding = await getIn(tx, executionId)
        if (binding === null || binding.result === null)
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
    async abandon(executionId, reason) {
      await write(async (tx, epoch) => {
        const binding = await existing(tx, executionId)
        if (binding.state === 'settled') return
        const result: BusinessResult = binding.result ?? {
          exitCode: null,
          reason: `abandoned: ${reason}`,
          stdout: '',
          stderr: reason,
          truncated: true,
          finalCursor: binding.lastCursor ?? '',
        }
        await tx
          .update(hostedExecutionBindings)
          .set({ resultJson: JSON.stringify(result), state: 'settled', epoch, updatedAt: now() })
          .where(eq(hostedExecutionBindings.executionId, executionId))
      })
    },
  }
}
