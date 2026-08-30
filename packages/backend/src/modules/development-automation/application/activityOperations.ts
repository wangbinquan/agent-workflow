// RFC-344 — transport-neutral development activity worker trigger.

import { z } from 'zod'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { defineCommandOperation } from '@/platform/operations/definitions'

/** Branded authority minted by identity-access; never a transport Actor. */
type Actor = DirectAuthenticatedAuthority

export type DevelopmentActivityResult =
  | { readonly activity: 'channel'; readonly state: 'completed' }
  | { readonly activity: 'outbox'; readonly state: 'completed' | 'retried' }
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
