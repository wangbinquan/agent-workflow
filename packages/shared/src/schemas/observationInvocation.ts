import { z } from 'zod'

const key = z.string().min(1).max(512)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const runtime = z
  .object({
    registrationId: key,
    configurationRevision: revision,
    protocol: z.enum(['opencode', 'claude-code']),
    /** Display fact from the frozen selection, never a current-directory lookup. */
    acceptedName: z
      .string()
      .min(1)
      .max(200)
      .refine((name) => name.trim().length > 0)
      .optional(),
  })
  .strict()
const localAuthority = z.object({ kind: z.literal('local'), runtime: runtime.nullable() }).strict()
const platformAuthority = z
  .object({
    kind: z.literal('crewstation'),
    /** Immutable installation identity, not a mutable URL or runtime name. */
    sourceId: key,
    projectId: key,
    taskId: key,
    subtaskId: key,
    executionResourceId: key,
    executionGeneration: revision.positive(),
  })
  .strict()
/** Explicit owner selection: network availability never changes this authority. */
export const ObservationExecutionAuthoritySchema = z.discriminatedUnion('kind', [
  localAuthority,
  platformAuthority,
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
    /** Absent on older invocations; never infer child completeness from root counters. */
    nativeCaptureContract: z.literal('opencode-child-steps-v1').optional(),
    nativeCaptureSource: key.optional(),
  })
  .strict()
export const AcceptedObservationInvocationSchema = AcceptObservationInvocationSchema.extend({
  authority: z.discriminatedUnion('kind', [
    localAuthority,
    // Older accepted documents lack installation identity. They remain readable,
    // but cannot be rebound to the currently configured platform implicitly.
    platformAuthority.extend({ sourceId: key.nullable().default(null) }),
  ]),
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
