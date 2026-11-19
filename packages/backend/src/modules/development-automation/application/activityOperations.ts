// RFC-344 — transport-neutral development activity worker trigger.

import { z } from 'zod'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { defineCommandOperation } from '@/platform/operations/definitions'

/** Branded authority minted by identity-access; never a transport Actor. */
type Actor = DirectAuthenticatedAuthority

export type DevelopmentActivityResult =
  | { readonly activity: 'channel'; readonly state: 'completed' }
  | { readonly activity: 'outbox'; readonly state: 'completed' | 'retried' }
  | { readonly activity: 'dispatch'; readonly state: 'launched' | 'retried' | 'settled' }
  | { readonly activity: 'delivery'; readonly state: 'completed' }
  | { readonly activity: 'reaction'; readonly state: string }
  | {
      readonly activity: 'execution'
      readonly state: 'completed' | 'retried' | 'failed' | 'pending' | 'idle'
    }

export interface DevelopmentActivityOperations {
  runOneWorkerCycle(): Promise<DevelopmentActivityResult>
}

const activityResultSchema = z.discriminatedUnion('activity', [
  z.object({ activity: z.literal('channel'), state: z.literal('completed') }).strict(),
  z.object({ activity: z.literal('outbox'), state: z.enum(['completed', 'retried']) }).strict(),
  z
    .object({
      activity: z.literal('dispatch'),
      state: z.enum(['launched', 'retried', 'settled']),
    })
    .strict(),
  z.object({ activity: z.literal('delivery'), state: z.literal('completed') }).strict(),
  z.object({ activity: z.literal('reaction'), state: z.string().min(1) }).strict(),
  z
    .object({
      activity: z.literal('execution'),
      state: z.enum(['completed', 'retried', 'failed', 'pending', 'idle']),
    })
    .strict(),
])

export function createDevelopmentActivityOperation(operations: DevelopmentActivityOperations) {
  return defineCommandOperation({
    id: 'development-automation.run-one-activity-cycle.v1',
    summary: 'Run one recoverable Digital Employee OS worker cycle',
    permissions: ['development-missions:retry'],
    publicErrors: ['forbidden', 'unavailable', 'internal-error'],
    inputSchema: z.object({}).strict(),
    outputSchema: activityResultSchema,
    invoke: (_context: Actor) => operations.runOneWorkerCycle(),
  })
}

export interface DevelopmentActivityWorker {
  runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
  dispatchOneReaction(): Promise<'launched' | 'retried' | 'settled' | 'idle'>
  pumpOneDelivery(): Promise<boolean>
  planOneReaction(): Promise<string | null>
  inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
  publishOneChannelResult(): Promise<'completed' | 'idle'>
}

/** RFC-509 — one worker cycle: the first activity that is not idle wins; when all are idle, the execution inspection result is returned. */
export function createDevelopmentActivityWorkerCycle(
  worker: DevelopmentActivityWorker,
): DevelopmentActivityOperations {
  return Object.freeze({
    async runOneWorkerCycle(): Promise<DevelopmentActivityResult> {
      const channel = await worker.publishOneChannelResult()
      if (channel !== 'idle') return { activity: 'channel', state: channel }
      const outbox = await worker.runOneOutbox()
      if (outbox !== 'idle') return { activity: 'outbox', state: outbox }
      // RFC-368 T9 —— 必须插在 `inspectOneExecution` 之前：最后一句是无条件 return，
      // 追加在其后就是死代码（design §4.1）。
      const dispatch = await worker.dispatchOneReaction()
      if (dispatch !== 'idle') return { activity: 'dispatch', state: dispatch }
      if (await worker.pumpOneDelivery()) return { activity: 'delivery', state: 'completed' }
      const roundId = await worker.planOneReaction()
      if (roundId !== null) return { activity: 'reaction', state: roundId }
      return { activity: 'execution', state: await worker.inspectOneExecution() }
    },
  })
}
