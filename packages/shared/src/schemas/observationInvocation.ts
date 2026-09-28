import { z } from 'zod'

const key = z.string().min(1).max(512)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const runtime = z
  .object({
    registrationId: key,
    configurationRevision: revision,
    protocol: z.enum(['opencode', 'claude-code']),
  })
  .strict()
/** Explicit owner selection: network availability never changes this authority. */
export const ObservationExecutionAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), runtime: runtime.nullable() }).strict(),
  z
    .object({
      kind: z.literal('crewstation'),
      projectId: key,
      taskId: key,
      subtaskId: key,
      executionResourceId: key,
      executionGeneration: revision.positive(),
    })
    .strict(),
])
export const AcceptObservationInvocationSchema = z
  .object({
    invocationId: key,
    taskId: key,
    nodeRunId: key.nullable(),
    agentId: key.nullable(),
    agentRevision: revision.nullable(),
    purpose: z.enum(['task', 'system', 'playground', 'memory']),
    authority: ObservationExecutionAuthoritySchema,
  })
  .strict()
export const AcceptedObservationInvocationSchema = AcceptObservationInvocationSchema.extend({
  acceptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Zero is an explicitly empty local catalogue; null means local pricing is inapplicable. */
  priceBookRevision: revision.nullable(),
})
  .strict()
  .superRefine((value, ctx) => {
    const localCatalogue = value.authority.kind === 'local' && value.authority.runtime !== null
    if (localCatalogue !== (value.priceBookRevision !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceBookRevision'],
        message: 'Price catalogue must match execution authority',
      })
    }
  })
export type AcceptObservationInvocation = z.infer<typeof AcceptObservationInvocationSchema>
export type AcceptedObservationInvocation = z.infer<typeof AcceptedObservationInvocationSchema>
