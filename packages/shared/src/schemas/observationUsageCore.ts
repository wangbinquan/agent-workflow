import { z } from 'zod'

// Original numeric primitives; completion contracts can consume them without a runtime back edge.
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
    model: z.object({ provider: identity.nullable(), id: identity }).strict().nullable(),
    adapterVersion: identity,
    reporting: z.enum(['delta', 'cumulative']),
    inclusion: z.enum(['self', 'includes-descendants', 'unknown']),
    coverage: z.enum(['partial', 'complete', 'unknown']),
    validity: z.enum(['valid', 'correction', 'invalid-final']),
    /** Explicit overlap relation; absent on legacy flat measurements. */
    scope: z
      .object({
        root: identity,
        session: identity,
        parentSession: identity.nullable(),
        ancestors: z.array(identity).max(64),
        turn: identity,
        turnIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        level: z.enum(['request', 'self-total', 'tree-total']),
      })
      .strict()
      .optional(),
    /** Native turn watermark covered by this aggregate, independent of delivery order. */
    coveredThroughTurn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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

export type ObservationTokenUsage = z.infer<typeof ObservationTokenUsageSchema>
export type ObservationMeasurement = z.infer<typeof ObservationMeasurementSchema>
