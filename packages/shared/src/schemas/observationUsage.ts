import { z } from 'zod'
import { ObservationTokenUsageSchema, ObservationMeasurementSchema } from './observationUsageCore'
export { ObservationTokenUsageSchema, ObservationMeasurementSchema } from './observationUsageCore'
import {
  ObservationCapturedSpansSchema,
  ObservationPriorSpanRevisionSchema,
  ObservationSpanCaptureSchema,
  ObservationSpanFactSchema,
} from './observationSpans'

const identity = z.string().min(1).max(512)

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
const capturedNumericUsage = z
  .object({
    invocationId: identity,
    measurements: z.array(ObservationMeasurementSchema).max(500),
    diagnostics: z.array(z.string().min(1).max(200)).max(100),
    capture: ObservationNativeCaptureSchema.optional(),
  })
  .strict()
export const ObservationCapturedUsageSchema = capturedNumericUsage
  .extend({
    spanFacts: z.array(ObservationSpanFactSchema).max(200).optional(),
    priorSpanRevisions: z.array(ObservationPriorSpanRevisionSchema).max(200).optional(),
    spanCapture: ObservationSpanCaptureSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.spanFacts?.length ?? 0) + (value.priorSpanRevisions?.length ?? 0) > 200)
      ctx.addIssue({ code: 'custom', message: 'A frame contains at most 200 span records' })
    if (
      value.spanFacts?.some((fact) => fact.invocationId !== value.invocationId) ||
      value.priorSpanRevisions?.some(
        (revision) => revision.carrierInvocationId !== value.invocationId,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Span records must retain their actual carrier' })
  })
export type ObservationCapturedUsage = z.infer<typeof ObservationCapturedUsageSchema>

/** Preserve the original strict numeric write/rollback contract; isolate optional trace damage. */
export function parseObservationCapturedUsage(value: unknown): ObservationCapturedUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return capturedNumericUsage.parse(value)
  const document = value as Record<string, unknown>
  const { spanFacts, priorSpanRevisions, spanCapture, ...numeric } = document
  const parsed = capturedNumericUsage.parse(numeric)
  if (
    !['spanFacts', 'priorSpanRevisions', 'spanCapture'].some((key) => Object.hasOwn(document, key))
  )
    return parsed
  const metadata = ObservationCapturedSpansSchema.safeParse({
    ...(spanFacts === undefined ? {} : { spanFacts }),
    ...(priorSpanRevisions === undefined ? {} : { priorSpanRevisions }),
    ...(spanCapture === undefined ? {} : { spanCapture }),
  })
  if (
    !metadata.success ||
    metadata.data.spanFacts?.some((fact) => fact.invocationId !== parsed.invocationId) ||
    metadata.data.priorSpanRevisions?.some(
      (revision) => revision.carrierInvocationId !== parsed.invocationId,
    )
  )
    return {
      ...parsed,
      diagnostics: [
        ...parsed.diagnostics.filter((code) => code !== 'span-metadata-invalid').slice(0, 99),
        'span-metadata-invalid',
      ],
    }
  return { ...parsed, ...metadata.data }
}
