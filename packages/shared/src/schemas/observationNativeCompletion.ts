import { z } from 'zod'
import {
  ObservationNativePassAckSchema,
  ObservationNativePassIdentitySchema,
} from './observationNativePages'
import { ObservationMeasurementSchema } from './observationUsageCore'

const key = z.string().min(1).max(512)
const decimal = z.string().regex(/^(0|[1-9]\d*)$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** References the original owner's complete parent index, including trees deeper than 64. */
export const ObservationNativeScopeReferenceSchema = z
  .object({
    root: key,
    session: key,
    parentSession: key.nullable(),
    ancestry: z
      .object({
        kind: z.literal('native-pass-v2'),
        identity: ObservationNativePassIdentitySchema,
        ownerReceiptId: key,
        pageOrdinal: decimal,
        cumulativeDigest: digest,
      })
      .strict(),
    turn: key,
    turnIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    level: z.enum(['request', 'self-total', 'tree-total']),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (
      scope.root !== scope.ancestry.identity.rootSessionId ||
      scope.turn !== scope.ancestry.identity.invocationId ||
      scope.ancestry.identity.phase !== 'final' ||
      (scope.session === scope.root) !== (scope.parentSession === null) ||
      scope.parentSession === scope.session
    )
      ctx.addIssue({ code: 'custom', message: 'Native scope changed its original pass binding' })
  })

export const ObservationNativeMeasurementSchema = ObservationMeasurementSchema.omit({
  scope: true,
})
  .extend({ scope: ObservationNativeScopeReferenceSchema })
  .superRefine((value, ctx) => {
    if (value.invocationId !== value.scope.turn)
      ctx.addIssue({
        code: 'custom',
        message: 'Native measurement changed its original invocation',
      })
  })

export const ObservationNativeBeforeSpawnAckSchema = z
  .object({
    contract: z.literal('native-usage-before-spawn-v2'),
    invocationId: key,
    nativeSource: key,
    sourceGeneration: key,
    lineage: key,
    epoch: key,
    ownerReceiptId: key,
    preparedAt: time,
    mode: z.enum(['fresh', 'resume']),
    rootSessionId: key.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.mode === 'fresh') !== (value.rootSessionId === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Original before-spawn receipt changed its resume root',
      })
  })

export const ObservationNativeSourceAckSchema = z
  .object({
    contract: z.literal('native-usage-source-ack-v2'),
    invocationId: key,
    eventId: key,
    fingerprint: digest,
    sourceWatermark: decimal,
    measurements: z
      .array(z.union([ObservationMeasurementSchema, ObservationNativeMeasurementSchema]))
      .max(500),
  })
  .strict()
  .superRefine((ack, ctx) => {
    if (
      ack.sourceWatermark === '0' ||
      ack.measurements.some((measurement) => measurement.invocationId !== ack.invocationId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native source ACK requires its actual persisted invocation and row',
      })
  })

/** A small EOF reference. The owner verifies every preceding page, never just the last ACK. */
export const ObservationNativePassCompletionSchema = z
  .object({
    ack: ObservationNativePassAckSchema,
    pageCount: decimal,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.ack.eof === null ||
      value.ack.nextCursor !== null ||
      BigInt(value.pageCount) !== BigInt(value.ack.ordinal) + 1n
    )
      ctx.addIssue({ code: 'custom', message: 'Native completion requires the exact original EOF' })
  })

const freshBaseline = z
  .object({
    kind: z.literal('fresh'),
    beforeSpawnReceiptId: key.nullable(),
    /** Frozen by the original owner before spawn; not a retrospectively scanned baseline. */
    preparedAt: time.nullable(),
    /** Read from the original native root row, in the same generation as the final pass. */
    rootCreatedAt: time.nullable(),
  })
  .strict()
const resumeBaseline = z
  .object({ kind: z.literal('resume'), pass: ObservationNativePassCompletionSchema.nullable() })
  .strict()

/** A v2 proof references durable pages and emissions; it contains no population-sized arrays. */
export const ObservationNativeCompletionSchema = z
  .object({
    contract: z.literal('opencode-child-pages-v2'),
    nativeSource: key,
    rootSessionId: key.nullable(),
    state: z.enum(['complete', 'partial']),
    baseline: z.discriminatedUnion('kind', [freshBaseline, resumeBaseline]),
    final: ObservationNativePassCompletionSchema.nullable(),
    /** The last actually persisted page remains readable after an interrupted final scan. */
    finalProgress: ObservationNativePassAckSchema.optional(),
    observedAt: time,
    process: z
      .object({ spawnedAt: time.nullable(), reapedAt: time.nullable(), drainedAt: time.nullable() })
      .strict(),
    emissions: z
      .object({
        records: decimal,
        frames: decimal,
        digest,
        sourceWatermark: decimal,
      })
      .strict(),
    /** Complete baseline comparisons and historical corrections are verified by the owner. */
    reconciliation: z
      .object({ examined: decimal, resolved: decimal, unresolved: decimal, digest })
      .strict(),
    issues: z.array(z.string().min(1).max(200)).max(100),
  })
  .strict()
  .superRefine((proof, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const final = proof.final?.ack
    const progress = proof.finalProgress
    const finalIdentity = final?.identity ?? progress?.identity
    if (
      progress !== undefined &&
      (progress.identity.phase !== 'final' ||
        progress.identity.nativeSource !== proof.nativeSource ||
        progress.identity.rootSessionId !== proof.rootSessionId ||
        BigInt(proof.emissions.sourceWatermark) < BigInt(progress.sourceWatermark) ||
        (final !== undefined && JSON.stringify(progress) !== JSON.stringify(final)))
    )
      fail('Native partial progress changed its original persisted page')
    if (
      (final !== undefined &&
        (final.identity.phase !== 'final' ||
          final.identity.nativeSource !== proof.nativeSource ||
          final.identity.rootSessionId !== proof.rootSessionId ||
          BigInt(proof.emissions.sourceWatermark) < BigInt(final.sourceWatermark))) ||
      BigInt(proof.reconciliation.examined) !==
        BigInt(proof.reconciliation.resolved) + BigInt(proof.reconciliation.unresolved)
    )
      fail('Native completion changed original ownership, source or reconciliation counts')
    if (proof.baseline.kind === 'resume') {
      const before = proof.baseline.pass?.ack.identity
      if (
        before !== undefined &&
        (before.phase !== 'baseline' ||
          before.nativeSource !== proof.nativeSource ||
          before.rootSessionId !== proof.rootSessionId ||
          (finalIdentity !== undefined &&
            (
              [
                'invocationId',
                'nativeSource',
                'sourceGeneration',
                'rootSessionId',
                'lineage',
                'epoch',
              ] as const
            ).some((field) => before[field] !== finalIdentity[field])) ||
          BigInt(proof.reconciliation.examined) !== BigInt(proof.baseline.pass!.ack.counts.steps))
      )
        fail('Native resume must compare every original baseline step in the same binding')
    } else if (
      (proof.baseline.preparedAt !== null &&
        proof.process.spawnedAt !== null &&
        proof.baseline.preparedAt > proof.process.spawnedAt) ||
      (proof.baseline.rootCreatedAt !== null &&
        proof.process.spawnedAt !== null &&
        proof.baseline.rootCreatedAt < proof.process.spawnedAt) ||
      (proof.baseline.rootCreatedAt !== null && proof.baseline.rootCreatedAt > proof.observedAt) ||
      proof.reconciliation.examined !== '0'
    )
      fail('Fresh native capture requires its actual before-spawn receipt and root birth')
    if (
      (proof.process.spawnedAt !== null && proof.process.spawnedAt > proof.observedAt) ||
      (proof.process.reapedAt !== null &&
        ((proof.process.spawnedAt !== null && proof.process.reapedAt < proof.process.spawnedAt) ||
          proof.process.reapedAt > proof.observedAt)) ||
      (proof.process.drainedAt !== null &&
        ((proof.process.spawnedAt !== null && proof.process.drainedAt < proof.process.spawnedAt) ||
          proof.process.drainedAt > proof.observedAt))
    )
      fail('Native capture process timestamps do not retain the original execution interval')
    if (
      proof.state === 'complete' &&
      (proof.issues.length !== 0 ||
        proof.rootSessionId === null ||
        final === undefined ||
        proof.process.spawnedAt === null ||
        (proof.baseline.kind === 'fresh'
          ? proof.baseline.beforeSpawnReceiptId === null ||
            proof.baseline.preparedAt === null ||
            proof.baseline.rootCreatedAt === null
          : proof.baseline.pass === null) ||
        proof.process.reapedAt === null ||
        proof.process.drainedAt === null ||
        proof.reconciliation.unresolved !== '0')
    )
      fail('Complete native capture requires reap, drain and all original revisions')
  })

export type ObservationNativeScopeReference = z.infer<typeof ObservationNativeScopeReferenceSchema>
export type ObservationNativeMeasurement = z.infer<typeof ObservationNativeMeasurementSchema>
export type ObservationNativeBeforeSpawnAck = z.infer<typeof ObservationNativeBeforeSpawnAckSchema>
export type ObservationNativeSourceAck = z.infer<typeof ObservationNativeSourceAckSchema>
export type ObservationNativePassCompletion = z.infer<typeof ObservationNativePassCompletionSchema>
export type ObservationNativeCompletion = z.infer<typeof ObservationNativeCompletionSchema>
