import { z } from 'zod'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeCompletionSchema,
} from './observationNativeCompletion'

const key = z.string().min(1).max(512)
const decimal = z.string().regex(/^(0|[1-9]\d*)$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const original = ObservationNativeCompletionSchema.innerType().shape

/** Small references only; every root, transition, pass and step stays in the original relations. */
export const ObservationNativeRootCompletionSchema = z
  .object({
    contract: z.literal('opencode-child-root-pages-v3'),
    nativeSource: key,
    rootSessionId: key.nullable(),
    state: z.enum(['complete', 'partial']),
    beforeSpawn: ObservationNativeBeforeSpawnAckSchema,
    sourceGeneration: key.nullable(),
    roots: z
      .object({
        transitions: decimal,
        count: decimal,
        sourceDigest: digest,
        resultDigest: digest,
        resultId: digest,
        frozenAt: time,
        processWatermark: decimal,
      })
      .strict(),
    observedAt: time,
    process: original.process,
    emissions: original.emissions,
    reconciliation: original.reconciliation,
    issues: original.issues,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.nativeSource !== value.beforeSpawn.nativeSource ||
      value.observedAt < value.beforeSpawn.preparedAt ||
      value.observedAt < value.roots.frozenAt ||
      BigInt(value.roots.count) > BigInt(value.roots.transitions) ||
      BigInt(value.roots.processWatermark) > BigInt(value.emissions.sourceWatermark) ||
      (value.beforeSpawn.sourceGeneration !== null &&
        value.sourceGeneration !== value.beforeSpawn.sourceGeneration)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native root collection changed its original source references',
      })
    if (
      value.state === 'complete' &&
      (value.issues.length !== 0 ||
        value.rootSessionId === null ||
        value.sourceGeneration === null ||
        value.roots.count === '0' ||
        value.process.spawnedAt === null ||
        value.process.reapedAt === null ||
        value.process.drainedAt === null ||
        value.reconciliation.unresolved !== '0')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Complete native roots require every original root, process and revision',
      })
    if (
      value.state === 'complete' &&
      value.process.spawnedAt !== null &&
      value.process.reapedAt !== null &&
      value.process.drainedAt !== null &&
      (value.beforeSpawn.preparedAt > value.process.spawnedAt ||
        value.process.reapedAt < value.process.spawnedAt ||
        value.process.drainedAt < value.process.spawnedAt ||
        value.roots.frozenAt < Math.max(value.process.reapedAt, value.process.drainedAt) ||
        value.observedAt < Math.max(value.process.reapedAt, value.process.drainedAt))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Complete native roots require the original ordered process and freeze times',
      })
  })

/** v2 keeps its strict single-root schema and semantics; v3 is an explicit new alternative. */
export const ObservationAnyNativeCompletionSchema = z.union([
  ObservationNativeCompletionSchema,
  ObservationNativeRootCompletionSchema,
])
export type ObservationNativeRootCompletion = z.infer<typeof ObservationNativeRootCompletionSchema>
export type ObservationAnyNativeCompletion = z.infer<typeof ObservationAnyNativeCompletionSchema>
