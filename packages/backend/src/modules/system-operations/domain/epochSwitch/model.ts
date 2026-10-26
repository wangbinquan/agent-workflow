import { persistenceDialect } from '@/platform/persistence/nativeDialect'
// RFC-395 V3: durable contracts only; transitions and adapters are supplied by V3-S.
import { z } from 'zod'
import { digestSchemaContract as valueDigest } from '@/platform/persistence/schema/canonical'
import {
  OperatorDecisionSchema,
  type OperatorDecision,
} from '@/platform/contracts/migrationDecision'

export type {
  EpochSwitchKind,
  EpochDeployment,
  EpochGenerationRole,
  EpochSourceLocation,
  EpochTargetLocation,
} from '@/platform/persistence/migration/run/types'

export const EPOCH_SWITCH_PHASES = [
  'discovered',
  'planned',
  'backed-up',
  'quiescing',
  'frozen',
  'converting',
  'validated',
  'activation-prepared',
  'activated',
  'verified',
  'completed',
] as const
export const EPOCH_SWITCH_STATUSES = [
  'running',
  'awaiting-approval',
  'failed',
  'rolled-back',
  'abandoned',
  'completed',
] as const
export const EPOCH_SWITCH_FAILURE_CATEGORIES = [
  'unsupported-source',
  'unsupported-path',
  'source-blocked',
  'source-changed',
  'target-unreachable',
  'target-not-empty',
  'target-permission',
  'target-schema',
  'catalog-unavailable',
  'scratch-required',
  'capacity',
  'approval-required',
  'drain-timeout',
  'freeze-failed',
  'backup-failed',
  'content-drift',
  'conversion-blocked',
  'load-blocked',
  'validation-failed',
  'receipt-conflict',
  'activation-failed',
  'health-failed',
  'pointer-receipt-mismatch',
  'journal-corrupt',
  'owner-conflict',
  'operation-conflict',
  'rollback-incomplete',
  'reverse-migration-required',
  'restore-failed',
  'internal',
] as const
export const EPOCH_SWITCH_FAULT_POINTS = [
  'after-journal-cas',
  'after-plan-file',
  'after-backup-file',
  'after-stop-request',
  'after-lock-acquired',
  'after-frozen-preflight',
  'after-content-manifest',
  'after-final-backup',
  'after-target-install',
  'after-run-open',
  'after-rows',
  'after-receipts',
  'before-ack',
  'after-finish',
  'after-deferred-constraints',
  'after-identity-high-water',
  'after-integrity-check',
  'after-catalog-admission',
  'after-validation',
  'after-receipt-export',
  'after-activation-receipt-file',
  'after-meta-receipt',
  'after-health-check',
  'temp-written',
  'temp-synced',
  'renamed',
  'directory-synced',
  'after-activated-journal',
  'after-switch-receipt',
  'after-retained-source-file',
  'after-restore-file',
  'after-retire',
  'rollback-temp-written',
  'rollback-temp-synced',
  'rollback-renamed',
  'rollback-directory-synced',
  'after-rollback-file',
] as const
export type EpochSwitchPhase = (typeof EPOCH_SWITCH_PHASES)[number]
export type EpochSwitchStatus = (typeof EPOCH_SWITCH_STATUSES)[number]
export type EpochSwitchFailureCategory = (typeof EPOCH_SWITCH_FAILURE_CATEGORIES)[number]
export type EpochSwitchFaultPoint = (typeof EPOCH_SWITCH_FAULT_POINTS)[number]
export type EpochSwitchFaults = (point: EpochSwitchFaultPoint) => void
export const EpochSwitchPhaseSchema = z.enum(EPOCH_SWITCH_PHASES)
export const EpochSwitchStatusSchema = z.enum(EPOCH_SWITCH_STATUSES)
export const EpochSwitchKindSchema = z.enum(['epoch-conversion', 'old-epoch-restore'])
export const EpochDeploymentSchema = z.enum(['standalone', 'crewstation'])
export const EpochGenerationRoleSchema = z.enum(['converted', 'restored'])
export const EpochDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const EpochOperationIdSchema = z.string().regex(/^dbm_e2_[A-Za-z0-9_-]{8,128}$/)
export const EpochGenerationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
export const EpochTimestampSchema = z.number().int().nonnegative()
export const EpochProviderSchema = z.enum(['sqlite', 'postgresql'])
/** Matches V2 plan order, including acknowledgements supplied across several commands. */
export function canonicalOperatorDecisions(
  decisions: readonly OperatorDecision[],
): readonly OperatorDecision[] {
  return decisions
    .map((decision) => OperatorDecisionSchema.parse(decision))
    .sort((a, b) => valueDigest(a).localeCompare(valueDigest(b)))
}
export const CanonicalOperatorDecisionsSchema = z
  .array(OperatorDecisionSchema)
  .transform(canonicalOperatorDecisions)
  .readonly()
export const MigrationApprovalPayloadSchema = z.strictObject({
  version: z.literal(1),
  operationId: EpochOperationIdSchema,
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  planDigest: EpochDigestSchema,
  approvalDigest: EpochDigestSchema,
  approvedAt: EpochTimestampSchema,
  previousApprovalDigest: EpochDigestSchema.nullable(),
})
export const MigrationApprovalSchema = z
  .strictObject({ payload: MigrationApprovalPayloadSchema, digest: EpochDigestSchema })
  .refine((record) => record.digest === valueDigest(record.payload), {
    message: 'approval record digest mismatch',
  })
export const MigrationApprovalHistorySchema = z
  .array(MigrationApprovalSchema)
  .readonly()
  .superRefine((records, context) => {
    const latest = new Map<string, (typeof records)[number]>()
    for (const [index, record] of records.entries()) {
      const p = record.payload
      const previous = latest.get(p.runId)
      if (
        p.operationId !== records[0]!.payload.operationId ||
        p.sequence !== (previous ? previous.payload.sequence + 1 : 0) ||
        p.previousApprovalDigest !== (previous?.digest ?? null) ||
        (previous && p.approvedAt < previous.payload.approvedAt)
      )
        context.addIssue({ code: 'custom', path: [index], message: 'approval history mismatch' })
      latest.set(p.runId, record)
    }
  })
export const EpochSwitchArtifactReferenceSchema = z.strictObject({
  name: z.string().min(1),
  digest: EpochDigestSchema,
})
export const SourceArchiveInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('retained-epoch1-archive'),
    path: z.string().min(1),
    digest: EpochDigestSchema,
  }),
  z.strictObject({
    kind: z.literal('never-installed'),
    evidence: z.strictObject({
      sourceBornOn: z.literal('postgresql'),
      sourceGenerationId: z.string().min(1),
      sourceWatermark: z.string().min(1),
      catalogDigest: EpochDigestSchema,
      expectedAbsent: z.array(z.string().min(1)).min(6).readonly(),
    }),
  }),
])
export const EpochSourceLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('sqlite-file'),
    path: z.string().min(1),
    pointerPath: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('postgresql-database'),
    profileRef: z.string().regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|crewstation:source)$/),
  }),
  z.strictObject({
    kind: z.literal('backup'),
    sourceKind: z.enum(['sqlite-backup', 'logical-backup', 'logical-artifact', 'hosted-backup']),
    artifact: z.string().min(1),
    root: z.string().min(1),
  }),
])
export const EpochTargetLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sqlite-file'), relativePath: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('postgresql-target'),
    profileRef: z.string().regex(/^(env:[A-Za-z_][A-Za-z0-9_]*|crewstation:target)$/),
  }),
])
export const EmptyTableDecisionSchema = z.strictObject({
  table: z.string().min(1),
  catalogDigest: EpochDigestSchema,
  disposition: z.literal('archived'),
  reason: z.string().min(1),
})
export const ContentRootSpecSchema = z.strictObject({
  kind: z.enum(['app-home', 'backup']),
  root: z.string().min(1),
  runContentRoot: z.string().min(1).optional(),
  runsSupplied: z.boolean(),
  objects: z.enum(['none', 'crewstation']),
})
/** Inputs survive a new-run/restart, including backup restore choices. */
export const EpochSwitchInputsSchema = z.strictObject({
  emptyTables: z.array(EmptyTableDecisionSchema).readonly(),
  operatorDecisions: CanonicalOperatorDecisionsSchema,
  chunkLimit: z.number().int().min(1).max(10000),
  scratchProfileRef: z
    .string()
    .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/)
    .nullable(),
  contentRoot: ContentRootSpecSchema.nullable(),
  restoreConfig: z.boolean(),
})
export type EpochSwitchInputs = z.infer<typeof EpochSwitchInputsSchema>
export const EpochSwitchFailureSchema = z.strictObject({
  phase: EpochSwitchPhaseSchema,
  category: z.enum(EPOCH_SWITCH_FAILURE_CATEGORIES),
  detailCode: z.string().min(1),
  retryable: z.boolean(),
  failedAt: EpochTimestampSchema,
})
export type EpochSwitchFailure = z.infer<typeof EpochSwitchFailureSchema>
export const EpochSwitchJournalPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    previousDigest: EpochDigestSchema.nullable(),
    operationId: EpochOperationIdSchema,
    kind: EpochSwitchKindSchema,
    deployment: EpochDeploymentSchema,
    role: EpochGenerationRoleSchema,
    phase: EpochSwitchPhaseSchema,
    status: EpochSwitchStatusSchema,
    owner: z.strictObject({
      id: z.string().min(1),
      fence: z.number().int().nonnegative(),
      leaseExpiresAt: EpochTimestampSchema,
    }),
    inputs: EpochSwitchInputsSchema,
    source: z.strictObject({
      location: EpochSourceLocationSchema,
      provider: EpochProviderSchema,
      epoch: z.literal(1),
      generationId: z.string().min(1).nullable(),
      fingerprintDigest: EpochDigestSchema.nullable(),
      sourceVersion: z.string().min(1).nullable(),
      pointer: z.strictObject({
        bytesBase64: z.base64().nullable(),
        digest: EpochDigestSchema.nullable(),
      }),
    }),
    target: z.strictObject({
      provider: EpochProviderSchema,
      epoch: z.literal(2),
      generationId: EpochGenerationIdSchema.nullable(),
      location: EpochTargetLocationSchema.nullable(),
    }),
    plan: z
      .strictObject({
        digest: EpochDigestSchema,
        approvalDigest: EpochDigestSchema,
        /** Latest approved material digest; full document digests are only review evidence. */
        approvedDigest: EpochDigestSchema.nullable(),
        approvedAt: EpochTimestampSchema.nullable(),
        path: z.string().min(1),
      })
      .nullable(),
    /** Omitted only by pre-fix dormant callers; phase 2 records every approval here and in meta. */
    approvals: MigrationApprovalHistorySchema.optional(),
    artifacts: z.array(EpochSwitchArtifactReferenceSchema).readonly().optional(),
    backup: z
      .strictObject({
        id: z.string().min(1),
        digest: EpochDigestSchema,
        sourceWatermark: z.string().min(1),
        path: z.string().nullable(),
      })
      .nullable(),
    frozen: z
      .strictObject({
        watermark: z.string().min(1),
        preUpgradeWatermark: z.string().min(1).nullable(),
        planTime: EpochTimestampSchema,
        contentManifestDigest: EpochDigestSchema,
        preflightPath: z.string().min(1),
      })
      .nullable(),
    run: z
      .strictObject({
        runId: z.string().min(1),
        ordinal: z.number().int().nonnegative(),
        bindingDigest: EpochDigestSchema.nullable(),
        summaryDigest: EpochDigestSchema.nullable(),
        validationDigest: EpochDigestSchema.nullable(),
        receiptExportDigest: EpochDigestSchema.nullable(),
      })
      .nullable(),
    activation: z
      .strictObject({
        receiptDigest: EpochDigestSchema,
        receiptPath: z.string().min(1),
        pointerDigest: EpochDigestSchema.nullable(),
        preparedAt: EpochTimestampSchema,
        activatedAt: EpochTimestampSchema.nullable(),
      })
      .nullable(),
    firstLiveWriteAt: EpochTimestampSchema.nullable(),
    rollback: z
      .strictObject({ at: EpochTimestampSchema, receiptDigest: EpochDigestSchema })
      .nullable(),
    completion: z
      .strictObject({ at: EpochTimestampSchema, retained: z.array(z.string()).readonly() })
      .nullable(),
    checkpoints: z
      .array(
        z.strictObject({
          phase: EpochSwitchPhaseSchema,
          key: z.string().min(1),
          committedAt: EpochTimestampSchema,
          digest: EpochDigestSchema,
        }),
      )
      .readonly(),
    failure: EpochSwitchFailureSchema.nullable(),
    createdAt: EpochTimestampSchema,
    updatedAt: EpochTimestampSchema,
  })
  .superRefine((value, context) => {
    if ((value.kind === 'old-epoch-restore') !== (value.role === 'restored'))
      context.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'role must match operation kind',
      })
    if (
      value.target.location &&
      persistenceDialect(value.target.provider).targetLocationKind !== value.target.location.kind
    )
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'target provider/location mismatch',
      })
    if (
      value.source.location.kind !== 'backup' &&
      persistenceDialect(value.source.provider).sourceLocationKind !== value.source.location.kind
    )
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source provider/location mismatch',
      })
    if ((value.source.pointer.bytesBase64 === null) !== (value.source.pointer.digest === null))
      context.addIssue({
        code: 'custom',
        path: ['source', 'pointer'],
        message: 'pointer bytes and digest must be paired',
      })
    if (value.plan && (value.plan.approvedDigest === null) !== (value.plan.approvedAt === null))
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'approval digest and time must be paired',
      })
    if (value.approvals?.some((approval) => approval.payload.operationId !== value.operationId))
      context.addIssue({
        code: 'custom',
        path: ['approvals'],
        message: 'approval operation mismatch',
      })
  })
export type EpochSwitchJournalPayload = z.infer<typeof EpochSwitchJournalPayloadSchema>
export const EpochSwitchJournalSchema = z.strictObject({
  payload: EpochSwitchJournalPayloadSchema,
  digest: EpochDigestSchema,
})
export type EpochSwitchJournal = z.infer<typeof EpochSwitchJournalSchema>
export function createEpochSwitchJournal(input: EpochSwitchJournalPayload): EpochSwitchJournal {
  const payload = EpochSwitchJournalPayloadSchema.parse(input)
  return { payload, digest: valueDigest(payload) }
}
export function parseEpochSwitchJournal(text: string): EpochSwitchJournal {
  const journal = EpochSwitchJournalSchema.parse(JSON.parse(text) as unknown)
  if (valueDigest(journal.payload) !== journal.digest)
    throw new EpochSwitchError('v3-journal-digest-mismatch', { category: 'journal-corrupt' })
  return journal
}
export class EpochSwitchError extends Error {
  readonly category: EpochSwitchFailureCategory
  readonly retryable: boolean
  constructor(
    readonly code: string,
    options: {
      readonly category?: EpochSwitchFailureCategory
      readonly retryable?: boolean
      readonly message?: string
    } = {},
  ) {
    super(options.message ?? code)
    this.name = 'EpochSwitchError'
    this.category = options.category ?? 'internal'
    this.retryable = options.retryable ?? false
  }
}
