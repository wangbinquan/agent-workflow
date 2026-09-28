import { z } from 'zod'
import { ObservationMeasurementSchema, ObservationTokenUsageSchema } from '@agent-workflow/shared'

// RFC-034 executionObservationsV1: CS projections are already reconciled.
// Importers replace these values; they never subtract the native baseline again.
const key = z.string().min(1).max(512)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const resource = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const identity = z
  .object({
    projectId: resource,
    taskId: resource,
    subtaskId: resource,
    executionId: resource,
    executionGeneration: revision,
  })
  .strict()
const envelope = {
  identity,
  sourceId: key,
  recordId: key,
  revision,
  occurredAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
}
const watermark = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const usage = z
  .object({
    ...envelope,
    kind: z.literal('usage'),
    adapterVersion: key,
    modelRef: key.nullable(),
    reporting: z.enum(['delta', 'cumulative']),
    inclusion: z.enum(['self', 'includes-descendants', 'unknown']),
    coverage: z.enum(['partial', 'complete', 'unknown']),
    validity: z.enum(['valid', 'correction', 'invalid-final']),
    scope: ObservationMeasurementSchema.shape.scope.unwrap().nullable(),
    coveredThroughTurn: watermark,
    usage: ObservationTokenUsageSchema,
    basis: ObservationMeasurementSchema.shape.basis,
    projection: z
      .object({
        projectionRevision: revision,
        observedRevision: revision,
        modelRevision: revision.optional(),
        contribution: ObservationTokenUsageSchema,
        coveredThrough: z
          .object({
            input: watermark,
            cacheRead: watermark,
            cacheWrite: watermark,
            output: watermark,
          })
          .strict()
          .nullable(),
        complete: z.boolean(),
        issues: z
          .array(
            z.enum([
              'unknown-inclusion',
              'baseline-unknown',
              'baseline-exceeds-observation',
              'invalid-final',
              'unexplained-decrease',
              'identity-conflict',
              'capture-gap',
            ]),
          )
          .max(16),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
    if (value.projection.observedRevision < value.revision)
      issue(['projection', 'observedRevision'], 'Observation precedes numeric revision')
    if (
      value.projection.modelRevision !== undefined &&
      (value.modelRef === null ||
        value.projection.modelRevision > value.projection.observedRevision)
    )
      issue(['projection', 'modelRevision'], 'Model evidence is not observed')
    if (value.inclusion === 'includes-descendants' && value.scope?.level !== 'tree-total')
      issue(['scope'], 'Descendant totals require tree coverage')
    if (value.scope && value.projection.coveredThrough === null)
      issue(['projection', 'coveredThrough'], 'Missing coverage watermarks')
    for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      if (
        value.projection.contribution[bucket] === null &&
        value.projection.coveredThrough?.[bucket] != null
      )
        issue(['projection', 'coveredThrough', bucket], 'Unknown contribution has no watermark')
      if (value.projection.complete && value.projection.contribution[bucket] === null)
        issue(['projection', 'complete'], 'Unknown bucket is incomplete')
    }
    if (!value.scope) return
    const lineage = [...value.scope.ancestors, value.scope.session]
    if (
      lineage[0] !== value.scope.root ||
      new Set(lineage).size !== lineage.length ||
      (value.scope.ancestors.at(-1) ?? null) !== value.scope.parentSession
    )
      issue(['scope', 'ancestors'], 'Invalid native lineage')
    if (value.scope.level === 'tree-total' && value.coveredThroughTurn === null)
      issue(['coveredThroughTurn'], 'Tree total requires native coverage')
    if (value.coveredThroughTurn !== null && value.coveredThroughTurn < value.scope.turnIndex)
      issue(['coveredThroughTurn'], 'Coverage precedes native scope')
  })
const valuationFields = {
  ...envelope,
  kind: z.literal('valuation'),
  valuationId: key,
  valuationRevision: revision,
  usageRevision: revision,
  currency: z.literal('CNY'),
  completeness: z.enum(['partial', 'complete', 'unknown']),
}
const valuation = z.discriminatedUnion('availability', [
  z
    .object({
      ...valuationFields,
      availability: z.literal('priced'),
      priceVersionRef: key,
      amountDecimal: z.string().regex(/^(0|[1-9]\d{0,71})(\.\d{1,12})?$/),
    })
    .strict(),
  z
    .object({
      ...valuationFields,
      availability: z.enum(['unpriced', 'not-authorized', 'pending']),
      priceVersionRef: z.null(),
      amountDecimal: z.null(),
    })
    .strict(),
])
const page = {
  schemaVersion: z.literal(1),
  capability: z.literal('executionObservationsV1'),
  projectId: resource,
  taskId: resource,
  items: z.array(z.union([usage, valuation])).max(500),
  nextCursor: key.nullable(),
  persistedThrough: key,
  firstAvailableCursor: key,
  asOf: z.string().datetime(),
  visibilityRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  costVisibility: z.enum(['hidden', 'project-members-and-services']),
  gaps: z
    .array(
      z
        .object({
          after: key.nullable(),
          through: key,
          reason: z.enum(['expired', 'source-reset', 'capture-incomplete']),
        })
        .strict(),
    )
    .max(100),
}
export const PlatformObservationPageSchema = z
  .discriminatedUnion('mode', [
    z.object({ ...page, mode: z.literal('incremental') }).strict(),
    z
      .object({
        ...page,
        mode: z.literal('snapshot'),
        snapshotId: key,
        snapshotThrough: key,
        expiresAt: z.string().datetime(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    for (const [index, item] of value.items.entries()) {
      if (item.identity.taskId !== value.taskId || item.identity.projectId !== value.projectId)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'identity'],
          message: 'Page identity mismatch',
        })
      if (
        value.costVisibility === 'hidden' &&
        item.kind === 'valuation' &&
        item.availability === 'priced'
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'Hidden valuation contains an amount',
        })
    }
    if (value.mode === 'snapshot' && value.snapshotThrough !== value.persistedThrough)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotThrough'],
        message: 'Snapshot watermark changed',
      })
  })
export type PlatformObservationPage = z.infer<typeof PlatformObservationPageSchema>
export type PlatformObservation = PlatformObservationPage['items'][number]

export class PlatformObservationSourceError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'source-not-found'
      | 'capability-unavailable'
      | 'access-unavailable'
      | 'snapshot-required'
      | 'invalid-response',
    message: string,
  ) {
    super(message)
    this.name = 'PlatformObservationSourceError'
  }
}
