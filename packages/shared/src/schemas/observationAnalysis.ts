import type { AcceptedObservationInvocation } from './observationInvocation'
import type { CompleteObservationTask } from './observationComplete'
import { ObservationOverviewQuerySchema } from './observationTasks'
import { z } from 'zod'
const count = z.string().regex(/^(0|[1-9]\d*)$/)
export const ObservationAnomalySchema = z
  .object({
    id: z.string(),
    key: z.string(),
    taskId: z.string().nullable(),
    taskName: z.string().nullable(),
    rule: z.enum([
      'usage-missing',
      'unpriced',
      'execution-failed',
      'retry-amplification',
      'human-waiting',
      'tool-timeout',
      'clock-skew',
      'source-unavailable',
      'storage-capacity',
      'projection-backlog',
      'storage-maintenance',
    ]),
    state: z.enum(['pending', 'firing', 'resolved']),
    sourceState: z.enum(['available', 'unavailable', 'no-samples']),
    samples: count,
    minimumSamples: count,
    windowMs: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    firstObservedAt: z.number().int().nonnegative(),
    lastObservedAt: z.number().int().nonnegative(),
    firedAt: z.number().int().nonnegative().nullable(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    evidence: z.array(z.string()),
    revision: count,
  })
  .strict()
export type ObservationAnomaly = z.infer<typeof ObservationAnomalySchema>
export const ObservationAnomalyPageSchema = z
  .object({
    items: z.array(ObservationAnomalySchema),
    total: count,
    nextCursor: z.string().nullable(),
    asOf: z.number().int().nonnegative(),
  })
  .strict()
export type ObservationAnomalyPage = z.infer<typeof ObservationAnomalyPageSchema>

export const ObservationMaintenanceRequestSchema = z
  .object({
    requestKey: z.string().min(8).max(128),
    reportId: z.string().min(1),
    mode: z.enum(['backfill', 'rebuild', 'reprice']),
    registrationId: z.string().min(1).optional(),
    targetPriceBookRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.mode !== 'reprice' ||
      (v.registrationId !== undefined && v.targetPriceBookRevision !== undefined),
    'Reprice requires a runtime and catalogue revision',
  )
export type ObservationMaintenanceRequest = z.infer<typeof ObservationMaintenanceRequestSchema>
export const ObservationMaintenanceOperationSchema = z
  .object({
    id: z.string(),
    request: ObservationMaintenanceRequestSchema,
    filters: ObservationOverviewQuerySchema,
    state: z.enum(['preparing', 'preview', 'running', 'complete', 'partial', 'failed']),
    sourceRevision: count,
    scopeDigest: z.string(),
    createdAt: z.number().int().nonnegative(),
    confirmedAt: z.number().int().nonnegative().nullable(),
    confirmationOrder: count.nullable().default(null),
    tasks: count,
    invocations: count,
    records: count,
    processed: count,
    unpricedRecords: count,
    knownOriginalCny: z.string().nullable(),
    knownProposedCny: z.string().nullable(),
    knownPairedDeltaCny: z.string().nullable(),
    gaps: z.array(z.string()),
  })
  .strict()
export type ObservationMaintenanceOperation = z.infer<typeof ObservationMaintenanceOperationSchema>
export const ObservationMaintenanceConfirmSchema = z
  .object({ expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal('APPLY') })
  .strict()
export interface ObservationInvocationPricePolicy {
  invocationId: string
  operationId: string
  confirmedAt: number
  confirmationOrder: string
  repriceAt: number
  originalAccepted: AcceptedObservationInvocation
  targetPriceBookRevision: number
}

export const ObservationPhaseSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    nodeRunId: z.string().nullable(),
    kind: z.enum(['human-wait', 'queue', 'preparation', 'model', 'tool', 'native-agent']),
    basis: z.enum(['review-round', 'clarify-round', 'original-span', 'original-lifecycle']),
    startedAt: z.number().int().nonnegative().nullable(),
    endedAt: z.number().int().nonnegative().nullable(),
    status: z.enum(['active', 'closed', 'unknown']),
    evidenceId: z.string(),
    label: z.string(),
  })
  .strict()
export type ObservationPhase = z.infer<typeof ObservationPhaseSchema>
export interface ObservationExecutionComparison {
  readonly revision: string
  readonly asOf: number
  readonly basis: 'task-subtree-lifecycle'
  readonly left: CompleteObservationTask
  readonly right: CompleteObservationTask
  readonly criticalPath: { readonly state: 'not-ready'; readonly reasons: readonly string[] }
}

export type ObservationMaintenanceConfirm = z.infer<typeof ObservationMaintenanceConfirmSchema>
