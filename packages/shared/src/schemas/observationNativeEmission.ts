import { z } from 'zod'
import { ObservationMeasurementSchema } from './observationUsageCore'
import { ObservationNativeMeasurementSchema } from './observationNativeCompletion'
import {
  ObservationSpanFactSchema,
  ObservationPriorSpanRevisionSchema,
  ObservationSpanCaptureSchema,
} from './observationSpans'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
/** Original kernel observations, delivered through the same durable source owner as numbers. */
export const ObservationNativeProcessFactSchema = z
  .object({
    contract: z.literal('native-process-facts-v2'),
    phase: z.enum(['spawned', 'settled']),
    pid: z.number().int().positive().nullable(),
    launchNonce: z.string().min(1).max(512).nullable(),
    spawnedAt: time,
    reapedAt: time,
    drainedAt: time,
    outcome: z.string().min(1).max(100).nullable(),
    drainTimedOut: z.boolean(),
    pumpError: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.phase === 'spawned' &&
        (value.pid === null ||
          value.spawnedAt === null ||
          value.reapedAt !== null ||
          value.drainedAt !== null ||
          value.outcome !== null ||
          value.drainTimedOut ||
          value.pumpError)) ||
      (value.phase === 'settled' && value.outcome === null) ||
      (value.reapedAt !== null && value.spawnedAt !== null && value.reapedAt < value.spawnedAt) ||
      (value.drainedAt !== null && value.spawnedAt !== null && value.drainedAt < value.spawnedAt) ||
      ((value.drainTimedOut || value.pumpError) && value.drainedAt !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Original process fact changed its execution interval',
      })
  })
export type ObservationNativeProcessFact = z.infer<typeof ObservationNativeProcessFactSchema>

/** One original source frame. Packet limits never bound an invocation's total population. */
export const ObservationNativeEmissionSchema = z
  .object({
    invocationId: z.string().min(1).max(512),
    measurements: z
      .array(z.union([ObservationMeasurementSchema, ObservationNativeMeasurementSchema]))
      .max(500),
    diagnostics: z.array(z.string().min(1).max(200)).max(100),
    spanFacts: z.array(ObservationSpanFactSchema).max(200).optional(),
    priorSpanRevisions: z.array(ObservationPriorSpanRevisionSchema).max(200).optional(),
    spanCapture: ObservationSpanCaptureSchema.optional(),
    nativeProcess: ObservationNativeProcessFactSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.spanFacts?.length ?? 0) + (value.priorSpanRevisions?.length ?? 0) > 200 ||
      value.measurements.some((measurement) => measurement.invocationId !== value.invocationId) ||
      value.spanFacts?.some((fact) => fact.invocationId !== value.invocationId) ||
      value.priorSpanRevisions?.some(
        (revision) => revision.carrierInvocationId !== value.invocationId,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Original source frame changed its carrier' })
  })

export type ObservationNativeEmission = z.infer<typeof ObservationNativeEmissionSchema>
