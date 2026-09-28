import { z } from 'zod'

const identity = z.string().min(1).max(512)
const count = z
  .string()
  .regex(/^(0|[1-9]\d{0,59})$/)
  .nullable()
export const ObservationTokenUsageSchema = z
  .object({ input: count, cacheRead: count, cacheWrite: count, output: count })
  .strict()

export const ObservationMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationId: identity,
    recordId: identity,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    taskId: identity,
    nodeRunId: identity.nullable(),
    agentId: identity.nullable(),
    occurredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    model: z.object({ provider: identity, id: identity }).strict().nullable(),
    adapterVersion: identity,
    reporting: z.enum(['delta', 'cumulative']),
    inclusion: z.enum(['self', 'includes-descendants', 'unknown']),
    coverage: z.enum(['partial', 'complete', 'unknown']),
    validity: z.enum(['valid', 'correction', 'invalid-final']),
    basis: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('invocation') }).strict(),
      z
        .object({
          kind: z.literal('native-session'),
          lineageKey: identity,
          baseline: ObservationTokenUsageSchema.nullable(),
        })
        .strict(),
    ]),
    usage: ObservationTokenUsageSchema,
  })
  .strict()

/** An owner supplies a committed source page; cursors are opaque and never synthesized here. */
export const ObservationIngestSchema = z
  .object({
    sourceId: identity,
    expectedCursor: identity.nullable(),
    nextCursor: identity,
    events: z
      .array(z.object({ eventId: identity, measurement: ObservationMeasurementSchema }).strict())
      .min(1)
      .max(500),
  })
  .strict()

export type ObservationTokenUsage = z.infer<typeof ObservationTokenUsageSchema>
export type ObservationMeasurement = z.infer<typeof ObservationMeasurementSchema>
export type ObservationIngest = z.infer<typeof ObservationIngestSchema>
