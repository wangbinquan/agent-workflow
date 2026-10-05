import { z } from 'zod'
import {
  ObservationUsageCaptureCommitSchema,
  type ObservationNativePassPage,
} from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'

const decimal = z.string().regex(/^(0|[1-9]\d*)$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
/** A closed original read's finite references, never a retained snapshot or another numeric ledger. */
export const NativeHistoryPreparationSchema = z
  .object({
    value: z
      .object({
        ...ObservationUsageCaptureCommitSchema.innerType().shape,
        sourceId: z.string().min(1),
        sourceCursor: z.string().min(1),
      })
      .strict()
      .superRefine((value, ctx) => {
        const original = ObservationUsageCaptureCommitSchema.safeParse({
          invocationId: value.invocationId,
          taskId: value.taskId,
          capture: value.capture,
        })
        if (!original.success) ctx.addIssue({ code: 'custom', message: original.error.message })
      }),
    valueFingerprint: digest,
    sourceFingerprint: digest,
    beforeSpawnFingerprint: digest,
    passHeaders: z
      .array(z.object({ passId: z.string().min(1), fingerprint: digest }).strict())
      .max(2),
    expectedSteps: decimal,
    databaseGeneration: z.string().min(1),
    originalSnapshotId: z.string().min(1),
  })
  .strict()
export type NativeHistoryPreparation = z.infer<typeof NativeHistoryPreparationSchema>
export const NativeHistoryProgressSchema = z
  .object({
    preparation: NativeHistoryPreparationSchema,
    scanCycle: decimal,
    after: z.string().min(1).nullable(),
    examined: decimal,
    resolved: decimal,
    unresolved: decimal,
    digest,
    state: z.enum(['walking', 'pending', 'resolved']),
    lastCompleted: z
      .object({ examined: decimal, resolved: decimal, unresolved: decimal, digest })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      BigInt(value.examined) !== BigInt(value.resolved) + BigInt(value.unresolved) ||
      BigInt(value.examined) > BigInt(value.preparation.expectedSteps) ||
      (value.state === 'resolved' &&
        (value.unresolved !== '0' || value.examined !== value.preparation.expectedSteps))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native history progress lost its exact original population',
      })
  })
export type NativeHistoryProgress = z.infer<typeof NativeHistoryProgressSchema>
export interface NativeHistoryStep {
  readonly before: ObservationNativePassPage['steps'][number]
  readonly final: ObservationNativePassPage['steps'][number] | null
  readonly beforePath: string
  readonly finalPath: string | null
}
export const nativeHistoryFingerprint = (value: NativeHistoryPreparation['value']) =>
  sha256Hex(
    JSON.stringify([
      value.sourceId,
      value.sourceCursor,
      ObservationUsageCaptureCommitSchema.parse({
        invocationId: value.invocationId,
        taskId: value.taskId,
        capture: value.capture,
      }),
    ]),
  )
export const nativeHistorySeed = (preparation: NativeHistoryPreparation) =>
  sha256Hex(
    JSON.stringify([
      'native-history-writer-v2',
      preparation.valueFingerprint,
      preparation.sourceFingerprint,
    ]),
  )
