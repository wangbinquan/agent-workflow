import { z } from 'zod'
import { AcceptedObservationInvocationSchema } from './observationInvocation'

const key = z.string().min(1).max(512)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const issue = z.string().regex(/^[a-z][a-z0-9-]{0,119}$/)

/** Metadata only. Native boundaries are independent of delivery/capture time. */
export const ObservationSpanStateSchema = z
  .object({
    startedAt: time.nullable(),
    endedAt: time.nullable(),
    nativeObservedAt: time.nullable(),
    status: z.enum(['open', 'success', 'error', 'cancelled', 'unknown']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startedAt !== null && value.endedAt !== null && value.endedAt < value.startedAt)
      ctx.addIssue({ code: 'custom', message: 'Native end precedes native start' })
  })

export const ObservationSpanScopeSchema = z
  .object({
    sourceNamespace: key,
    rootSessionId: key,
    nativeSessionId: key,
    parentNativeSessionId: key.nullable(),
    ancestors: z.array(key).max(64),
    callId: key,
    kind: z.enum(['tool', 'model', 'native-agent']),
  })
  .strict()

export const ObservationSpanFactSchema = z
  .object({
    schemaVersion: z.literal(1),
    spanKey: key,
    invocationId: key,
    scope: ObservationSpanScopeSchema,
    /** Original runtime name, never arguments, results, prompt, or an error message. */
    label: z.string().min(1).max(120),
    parentCallId: key.nullable(),
    model: z.object({ provider: key.nullable(), id: key }).strict().nullable(),
    measurementRecordId: key.nullable(),
    state: ObservationSpanStateSchema,
    issues: z.array(issue).max(20).optional(),
    capturedAt: time,
  })
  .strict()
export type ObservationSpanFact = z.infer<typeof ObservationSpanFactSchema>
export type ObservationSpanScope = z.infer<typeof ObservationSpanScopeSchema>
export type ObservationSpanState = z.infer<typeof ObservationSpanStateSchema>

/** A later carrier refers to the original creation; it cannot manufacture an owner. */
export const ObservationSpanOwnerProofSchema = z
  .object({
    sourceRowId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceNodeRunId: key,
    itemIndex: z.number().int().min(0).max(199),
    accepted: AcceptedObservationInvocationSchema,
    spanKey: key,
    scope: ObservationSpanScopeSchema,
    creation: ObservationSpanFactSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.sourceNodeRunId !== value.accepted.nodeRunId ||
      value.creation.invocationId !== value.accepted.invocationId ||
      value.creation.spanKey !== value.spanKey ||
      JSON.stringify(value.creation.scope) !== JSON.stringify(value.scope)
    )
      ctx.addIssue({ code: 'custom', message: 'Owner proof must identify the original creation' })
  })
export type ObservationSpanOwnerProof = z.infer<typeof ObservationSpanOwnerProofSchema>

export const ObservationPriorSpanRevisionSchema = z
  .object({
    carrierInvocationId: key,
    targetOwnerInvocationId: key,
    targetSpanKey: key,
    originalOwnerProof: ObservationSpanOwnerProofSchema,
    before: ObservationSpanStateSchema,
    after: ObservationSpanStateSchema,
    capturedAt: time,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.carrierInvocationId === value.targetOwnerInvocationId ||
      value.originalOwnerProof.accepted.invocationId !== value.targetOwnerInvocationId ||
      value.originalOwnerProof.spanKey !== value.targetSpanKey
    )
      ctx.addIssue({ code: 'custom', message: 'Prior revision requires a distinct original owner' })
  })
export type ObservationPriorSpanRevision = z.infer<typeof ObservationPriorSpanRevisionSchema>

export const ObservationSpanCaptureSchema = z
  .object({
    contract: z.literal('runtime-span-facts-v1'),
    sourceNamespace: key,
    rootSessionId: key.nullable(),
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['complete', 'partial']),
    baseline: z.object({ kind: z.enum(['fresh', 'resume']), fingerprint: key.nullable() }).strict(),
    snapshotFingerprint: key.nullable(),
    capturedAt: time,
    scannedSessions: z.number().int().min(0).max(128),
    scannedParts: z.number().int().min(0).max(20000),
    issues: z.array(issue).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.state === 'complete' &&
      (value.rootSessionId === null ||
        value.snapshotFingerprint === null ||
        value.issues.length > 0 ||
        (value.baseline.kind === 'resume' && value.baseline.fingerprint === null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Complete spans require original scope and a bounded scan',
      })
  })
export type ObservationSpanCapture = z.infer<typeof ObservationSpanCaptureSchema>

/** Frame limits are shared by ordinary facts and prior revisions. */
export const ObservationCapturedSpansSchema = z
  .object({
    spanFacts: z.array(ObservationSpanFactSchema).max(200).optional(),
    priorSpanRevisions: z.array(ObservationPriorSpanRevisionSchema).max(200).optional(),
    spanCapture: ObservationSpanCaptureSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.spanFacts?.length ?? 0) + (value.priorSpanRevisions?.length ?? 0) > 200)
      ctx.addIssue({ code: 'custom', message: 'A frame contains at most 200 span records' })
  })
export type ObservationCapturedSpans = z.infer<typeof ObservationCapturedSpansSchema>

export type ObservationSpanSourceRecord = (
  | { type: 'fact'; sourceRowId: number; itemIndex: number; fact: ObservationSpanFact }
  | {
      type: 'revision'
      sourceRowId: number
      itemIndex: number
      revision: ObservationPriorSpanRevision
    }
  | {
      type: 'capture'
      sourceRowId: number
      itemIndex: number
      invocationId: string
      capture: ObservationSpanCapture
    }
  | {
      type: 'diagnostic'
      sourceRowId: number
      itemIndex: number
      invocationId: string
      code: string
    }
) & { readonly nodeRunId: string }

export interface ObservationSpanDetail {
  readonly fact: ObservationSpanFact
  readonly durationMs: number | null
  readonly quality: 'complete' | 'partial'
  readonly reasons: readonly string[]
  readonly usage: {
    readonly input: string | null
    readonly cacheRead: string | null
    readonly cacheWrite: string | null
    readonly output: string | null
  } | null
  readonly cost: {
    readonly currency: 'CNY'
    readonly amountDecimal: string | null
    readonly completeness: 'complete' | 'partial' | 'unpriced'
  } | null
}
export interface ObservationTaskSpans {
  readonly taskId: string
  readonly nodeRunId: string
  readonly invocationId: string | null
  readonly spans: readonly ObservationSpanDetail[]
  readonly captures: readonly {
    readonly invocationId: string
    readonly capture: ObservationSpanCapture
  }[]
  readonly priorRepairCount: number
  readonly partial: boolean
  readonly reasons: readonly string[]
  readonly watermark: number
  readonly nextCursor: string | null
}
export interface ObservationTaskSpansQuery {
  readonly nodeRunId: string
  readonly invocationId?: string
  readonly after?: string | null
  readonly limit?: number
}

export interface ObservationSpanSourceInput {
  readonly taskId: string
  readonly carrierInvocationIds: readonly string[]
  /** Complete snapshot readers validate retained carriers through their original owner workspace. */
  readonly allTaskCarriers?: boolean
  readonly sourceNamespace: string | null
  readonly scopeHash: string
  readonly after?: string | null
  readonly limit: number
}
export interface ObservationSpanSourcePage {
  readonly records: readonly ObservationSpanSourceRecord[]
  readonly scannedSources: number
  readonly watermark: number
  readonly nextCursor: string | null
  readonly truncated: boolean
  readonly issues: readonly string[]
}
