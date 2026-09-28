import { z } from 'zod'

const identity = z.string().min(1).max(512)
const count = z
  .string()
  .regex(/^(0|[1-9]\d{0,59})$/)
  .nullable()
export const ObservationTokenUsageSchema = z
  .object({ input: count, cacheRead: count, cacheWrite: count, output: count })
  .strict()

const nativeStepEvidence = z
  .object({
    usage: ObservationTokenUsageSchema,
    model: z.object({ provider: identity, id: identity }).strict().nullable(),
  })
  .strict()
export const ObservationNativeBaselineStepSchema = z
  .object({
    stepId: identity,
    sessionId: identity,
    parentSessionId: identity.nullable(),
    ancestors: z.array(identity).max(64),
    before: nativeStepEvidence,
    after: nativeStepEvidence.nullable(),
    /** False means the final scan did not cover this identity, never proof of deletion. */
    afterObserved: z.boolean().optional(),
    scopeChanged: z.boolean(),
  })
  .strict()
export type ObservationNativeBaselineStep = z.infer<typeof ObservationNativeBaselineStepSchema>
export interface ObservationNativeRevisionResolution {
  readonly stepId: string
  readonly sessionId: string
  readonly status: 'resolved' | 'unresolved'
  readonly invocationId: string | null
  readonly reason: string | null
  readonly previous?: ObservationNativeBaselineStep['before']
  readonly current?: ObservationNativeBaselineStep['after']
}
/** A completion proof is separate from numbers: an empty native tree still needs a proof. */
export const ObservationNativeCaptureSchema = z
  .object({
    contract: z.literal('opencode-child-steps-v1'),
    nativeSource: identity,
    rootSessionId: identity.nullable(),
    state: z.enum(['complete', 'partial']),
    baseline: z
      .object({ kind: z.enum(['fresh', 'resume']), fingerprint: identity.nullable() })
      .strict(),
    snapshotFingerprint: identity.nullable(),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scannedSessions: z.number().int().min(0).max(1024),
    scannedSteps: z.number().int().min(0).max(10000),
    issues: z.array(z.string().min(1).max(200)).max(100),
    /** These belong to earlier invocations, never to the resumed invocation's new consumption. */
    priorRevisions: z
      .array(
        z
          .object({
            sessionId: identity,
            stepId: identity,
            before: nativeStepEvidence,
            after: nativeStepEvidence.nullable(),
          })
          .strict(),
      )
      .max(100),
    /** Every prior step is retained, so revisions between two invocations can also be reconciled. */
    baselineSteps: z.array(ObservationNativeBaselineStepSchema).max(10000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.state === 'complete' &&
      (value.rootSessionId === null ||
        value.snapshotFingerprint === null ||
        value.issues.length ||
        value.priorRevisions.length ||
        value.baselineSteps?.some((step) => step.afterObserved === false) ||
        (value.baseline.kind === 'resume' && value.baseline.fingerprint === null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Complete native capture requires a bounded scan and baseline proof',
      })
  })
export type ObservationNativeCapture = z.infer<typeof ObservationNativeCaptureSchema>
export const ObservationCaptureCommitSchema = z
  .object({
    invocationId: identity,
    taskId: identity,
    capture: ObservationNativeCaptureSchema,
  })
  .strict()
export type ObservationCaptureCommit = z.infer<typeof ObservationCaptureCommitSchema>

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

/** An owner supplies a committed source page; cursors are opaque and never synthesized here. */
export const ObservationIngestSchema = z
  .object({
    sourceId: identity,
    expectedCursor: identity.nullable(),
    nextCursor: identity,
    events: z
      .array(z.object({ eventId: identity, measurement: ObservationMeasurementSchema }).strict())
      .max(500),
    capture: ObservationCaptureCommitSchema.optional(),
    /** Frozen native store identity supplied by the accepted local invocation. */
    nativeSource: identity.optional(),
    nativeWatermark: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .refine((value) => value.events.length > 0 || value.capture !== undefined, {
    message: 'A source page must contain numeric evidence or a capture proof',
  })

export type ObservationTokenUsage = z.infer<typeof ObservationTokenUsageSchema>
export type ObservationMeasurement = z.infer<typeof ObservationMeasurementSchema>
export type ObservationIngest = z.infer<typeof ObservationIngestSchema>

/** Numeric evidence attached to the owner's durable runtime event, before projection. */
export const ObservationCapturedUsageSchema = z
  .object({
    invocationId: identity,
    measurements: z.array(ObservationMeasurementSchema).max(500),
    diagnostics: z.array(z.string().min(1).max(200)).max(100),
    capture: ObservationNativeCaptureSchema.optional(),
  })
  .strict()
export type ObservationCapturedUsage = z.infer<typeof ObservationCapturedUsageSchema>
