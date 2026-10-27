import { ProbeResultSchema } from './switchReceipt'
export {
  ProbeResultSchema,
  HealthReportSchema,
  SwitchReceiptPayloadSchema,
  SwitchReceiptSchema,
  createSwitchReceipt,
  parseSwitchReceipt,
  type SwitchReceiptPayload,
  type SwitchReceipt,
} from './switchReceipt'
import { z } from 'zod'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  BootUpgradeEffectSchema,
  materialBootUpgradeEffects,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import {
  OperatorDecisionSchema,
  HISTORY_EXECUTION_UNUSED_REASONS,
  type ArchiveRef,
  type EncodedKey,
  type JsonValue,
} from '@/platform/persistence/migration/conversion/types'
import {
  VALIDATION_CHECKS,
  type MigrationApproval,
  type MigrationApprovalPayload,
} from '@/platform/persistence/migration/run/types'
import {
  canonicalOperatorDecisions,
  CanonicalOperatorDecisionsSchema,
  ContentRootSpecSchema,
  EmptyTableDecisionSchema,
  EpochDeploymentSchema,
  EpochDigestSchema,
  EpochGenerationIdSchema,
  EpochGenerationRoleSchema,
  EpochOperationIdSchema,
  EpochProviderSchema,
  EpochSourceLocationSchema,
  EpochSwitchError,
  EpochSwitchKindSchema,
  EpochTargetLocationSchema,
  EpochTimestampSchema,
  MigrationApprovalPayloadSchema,
  MigrationApprovalSchema,
  MigrationApprovalHistorySchema,
} from './model'

const text = z.string().min(1)
const count = z.number().int().nonnegative()
const json: z.ZodType<JsonValue> = z.json()
const key = z
  .string()
  .startsWith('mk1:')
  .transform((value): EncodedKey => value as EncodedKey)
const phase = z.enum(['current', 'pre-upgrade'])
const rule = z.strictObject({ id: text, version: z.number().int().positive() })
const targetRef = z.strictObject({ table: text, key })
const historyBase = {
  taskId: text,
  runId: text.nullable(),
  missingFields: z.array(text).readonly(),
}
export const HistoryRestrictionSchema = z.discriminatedUnion('execution', [
  z.strictObject({ ...historyBase, execution: z.literal('retryable-history') }),
  z.strictObject({ ...historyBase, execution: z.literal('terminal-history') }),
  z.strictObject({
    ...historyBase,
    execution: z.literal('executable'),
    executionUse: z.literal('none'),
    reason: z.enum(HISTORY_EXECUTION_UNUSED_REASONS),
  }),
])
export const ConversionBlockSchema = z.strictObject({
  code: text,
  scope: z.enum(['global', 'table', 'row']),
  sourceTable: text.nullable(),
  sourceKey: key.nullable(),
  sourcePhase: phase.optional(),
  taskId: text.nullable(),
  runId: text.nullable(),
  missingFields: z.array(text).readonly(),
  detail: json,
  acknowledgeable: z.boolean().optional(),
})
export const ExecutableTaskBlockDetailSchema = z.object({
  executableTask: z.strictObject({ taskId: text, status: text }),
})
export const MigrationRowDispositionSchema = z.strictObject({
  sourceTable: text,
  sourceKey: key,
  sourcePhase: phase.optional(),
  class: z.enum(['converted', 'preserved', 'archived', 'blocked']),
  kind: z.enum([
    'derived-id',
    'merged',
    'deleted-placeholder',
    'history-only',
    'archived',
    'blocked',
    'conflict-resolved',
  ]),
  targets: z.array(targetRef).readonly(),
  archive: z
    .string()
    .regex(/^archive:sha256:[a-f0-9]{64}$/)
    .transform((value): ArchiveRef => value as ArchiveRef)
    .nullable(),
  rule,
  history: HistoryRestrictionSchema.optional(),
  codecColumns: z.array(text).readonly().optional(),
  allocation: z.strictObject({ column: text, value: text, sourceHighWater: text }).optional(),
  decision: z.strictObject({ code: text, detail: json }).nullable(),
})
export const ConversionPlanSectionSchema = z
  .strictObject({
    version: z.literal(1),
    digest: EpochDigestSchema,
    converterVersion: text,
    ruleSetDigest: EpochDigestSchema,
    sourceFingerprint: EpochDigestSchema,
    sourceVersion: text,
    sourceGenerationId: text,
    sourceWatermark: text,
    targetContractDigest: EpochDigestSchema,
    targetGeneration: text,
    candidateBuild: text,
    sourceBackupId: text.nullable(),
    contentManifestDigest: text,
    bootUpgradeEnvironmentDigest: EpochDigestSchema.optional(),
    planTime: EpochTimestampSchema,
    coverage: z.enum(['complete', 'partial']),
    chunkLimit: z.number().int().min(1).max(10000),
    preUpgradeWatermark: text.nullable(),
    operatorDecisions: z.array(OperatorDecisionSchema).readonly(),
    tables: z
      .array(
        z.strictObject({
          table: text,
          phase,
          rows: count,
          rule: text.nullable(),
          targets: z.array(text).readonly(),
        }),
      )
      .readonly(),
    topology: z.strictObject({
      order: z.array(text).readonly(),
      selfReferences: z.array(z.strictObject({ table: text, foreignKey: text })).readonly(),
      deferredForeignKeys: z
        .array(z.strictObject({ table: text, foreignKey: text, target: text }))
        .readonly(),
    }),
    deferredChecks: z.array(z.strictObject({ table: text, name: text })).readonly(),
    blocks: z.array(ConversionBlockSchema).readonly(),
  })
  .transform((input) => {
    const operatorDecisions = canonicalOperatorDecisions(input.operatorDecisions)
    if (valueDigest(operatorDecisions) === valueDigest(input.operatorDecisions)) return input
    const { digest: _digest, ...payload } = input
    const canonical = { ...payload, operatorDecisions }
    return { ...canonical, digest: valueDigest(canonical) }
  })
export const FoldedIdentityHighWaterSchema = z.strictObject({
  table: text,
  column: text,
  value: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  basis: z.enum(['sequence', 'max-row', 'both']),
  warnings: z.array(z.string()).readonly(),
})
export const MigrationRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity-high-water'),
    table: text,
    column: text,
    value: text,
    basis: z.enum(['sequence', 'max-row', 'both']),
    warning: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('source-journal'), entries: json }),
  z.strictObject({ kind: z.literal('source-generation'), generationId: text, evidence: json }),
  z.strictObject({ kind: z.literal('writer-drain'), payload: json }),
  z.strictObject({ kind: z.literal('family-cutover-source'), payload: json }),
  z.strictObject({ kind: z.literal('source-metadata'), table: text, payload: json }),
  z.strictObject({ kind: z.literal('decision'), code: text, payload: json }),
])
export const SwitchBackupReceiptSchema = z.strictObject({
  version: z.literal(1),
  id: text,
  kind: z.enum([
    'sqlite-vacuum',
    'postgresql-logical',
    'platform-retained',
    'immutable-backup-source',
  ]),
  path: text.nullable(),
  digest: EpochDigestSchema,
  sourceWatermark: text,
  contentManifestDigest: EpochDigestSchema.nullable(),
  createdAt: EpochTimestampSchema,
})
const bytes = z.strictObject({ size: count, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const ContentDriftSchema = z.strictObject({
  sourceTable: text,
  sourceKey: key,
  sourceColumn: text,
  originalReference: z.string().nullable(),
  reason: z.enum(['missing', 'size-changed', 'digest-changed', 'unlisted', 'unreadable']),
  expected: bytes.nullable(),
  actual: bytes.nullable(),
})
export const ValidationReportSchema = z.strictObject({
  version: z.literal(1),
  runId: text,
  validatedAt: EpochTimestampSchema,
  passed: z.boolean(),
  checks: z
    .array(z.strictObject({ check: z.enum(VALIDATION_CHECKS), passed: z.boolean(), detail: json }))
    .readonly(),
  blocks: z.array(ConversionBlockSchema).readonly(),
  contentDrift: z.array(ContentDriftSchema).readonly(),
  historyRestrictionsDigest: EpochDigestSchema,
  probes: z.array(ProbeResultSchema).readonly(),
  digest: EpochDigestSchema,
})
export const PlanSourceSchema = z.strictObject({
  location: EpochSourceLocationSchema,
  provider: EpochProviderSchema,
  epoch: z.literal(1),
  generationId: text,
  fingerprintDigest: EpochDigestSchema,
  sourceVersion: text,
  watermark: text,
  preUpgradeWatermark: text.nullable(),
})
export const PlanTargetSchema = z.strictObject({
  provider: EpochProviderSchema,
  epoch: z.literal(2),
  generationId: EpochGenerationIdSchema,
  location: EpochTargetLocationSchema,
  contractDigest: EpochDigestSchema,
  planDigest: EpochDigestSchema,
})
export const MigrationPlanBlockSchema = z.strictObject({
  id: text,
  block: ConversionBlockSchema,
  remediation: z.strictObject({
    action: z.enum([
      'acknowledge',
      'supply-input',
      'new-run',
      'repair-source',
      'repair-target',
      'unsupported',
    ]),
    message: text,
  }),
})
export type MigrationPlanBlock = z.infer<typeof MigrationPlanBlockSchema>
export const RestoreFileChangeSchema = z.strictObject({
  kind: z.enum(['skills', 'config']),
  sourcePath: text,
  destinationPath: text,
  replacedPath: text.nullable(),
})
export type RestoreFileChange = z.infer<typeof RestoreFileChangeSchema>
export const MigrationPlanDocumentPayloadSchema = z.strictObject({
  version: z.literal(1),
  operationId: EpochOperationIdSchema,
  kind: EpochSwitchKindSchema,
  deployment: EpochDeploymentSchema,
  role: EpochGenerationRoleSchema,
  source: PlanSourceSchema,
  target: PlanTargetSchema,
  candidateBuild: text,
  converterVersion: text,
  sourceBackupId: text.nullable(),
  contentManifestDigest: EpochDigestSchema,
  contentManifestPath: text.optional(),
  bootUpgradeEffects: z.array(BootUpgradeEffectSchema).readonly(),
  bootUpgradeEnvironmentDigest: EpochDigestSchema,
  bootUpgradeFactsDigest: EpochDigestSchema,
  conversionPlan: ConversionPlanSectionSchema,
  emptyTables: z.array(EmptyTableDecisionSchema).readonly(),
  operatorDecisions: CanonicalOperatorDecisionsSchema,
  restrictions: z.array(MigrationRowDispositionSchema).readonly(),
  blocks: z.array(MigrationPlanBlockSchema).readonly(),
  unfinishedTasks: z.array(z.strictObject({ status: text, count })).readonly(),
  estimates: z.strictObject({
    sourceBytes: count.nullable(),
    targetBytes: count.nullable(),
    backupBytes: count.nullable(),
    stagingBytes: count.nullable(),
    requiredBytes: count.nullable(),
    availableBytes: count.nullable(),
    rehearsalMs: count.nullable(),
    maintenanceMs: count.nullable(),
    components: z
      .strictObject({
        operationBytes: count.nullable(),
        runBackupBytes: count.nullable(),
        switchBackupBytes: count.nullable(),
        artifactMirrorBytes: count.nullable(),
        targetFilesystemBytes: count.nullable(),
      })
      .optional(),
  }),
  backup: z.strictObject({
    destination: text.nullable(),
    kind: SwitchBackupReceiptSchema.shape.kind,
    receipt: SwitchBackupReceiptSchema.nullable(),
  }),
  content: ContentRootSpecSchema,
  scratchProfileRef: z
    .string()
    .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/)
    .nullable(),
  requiresOfflineUpgrade: z.boolean(),
  validation: ValidationReportSchema.nullable(),
  switchMethod: z.enum(['pointer-v2', 'platform-switch']),
  recoveryMethod: z.literal('retained-source-until-first-write'),
  retention: z.strictObject({
    automaticDeletion: z.literal(false),
    compactRequiresVerifiedExport: z.literal(true),
  }),
  restoreFiles: z.array(RestoreFileChangeSchema).readonly(),
  createdAt: EpochTimestampSchema,
})
export type MigrationPlanDocumentPayload = z.infer<typeof MigrationPlanDocumentPayloadSchema>
export const MigrationPlanDocumentSchema = z.strictObject({
  payload: MigrationPlanDocumentPayloadSchema,
  digest: EpochDigestSchema,
  approvalDigest: EpochDigestSchema,
})
export type MigrationPlanDocument = z.infer<typeof MigrationPlanDocumentSchema>

const stableSet = <T>(values: readonly T[]): T[] =>
  [...values].sort((a, b) => valueDigest(a).localeCompare(valueDigest(b)))
/** Counts, watermarks and timings belong to the document digest, not material re-approval. */
export function migrationPlanApprovalDigest(input: MigrationPlanDocumentPayload): string {
  const p = MigrationPlanDocumentPayloadSchema.parse(input)
  return valueDigest({
    version: p.version,
    operationId: p.operationId,
    kind: p.kind,
    deployment: p.deployment,
    role: p.role,
    source: {
      location: p.source.location,
      provider: p.source.provider,
      epoch: p.source.epoch,
      generationId: p.source.generationId,
      sourceVersion: p.source.sourceVersion,
    },
    target: p.target,
    candidateBuild: p.candidateBuild,
    converterVersion: p.converterVersion,
    rules: p.conversionPlan.ruleSetDigest,
    coverage: p.conversionPlan.coverage,
    bootUpgradeEffects: materialBootUpgradeEffects(p.bootUpgradeEffects),
    bootUpgradeEnvironmentDigest: p.bootUpgradeEnvironmentDigest,
    tables: stableSet(p.conversionPlan.tables.map(({ rows: _rows, ...mapping }) => mapping)),
    emptyTables: stableSet(p.emptyTables),
    operatorDecisions: stableSet(p.operatorDecisions),
    restrictions: stableSet(p.restrictions),
    blocks: stableSet(p.blocks),
    content: p.content,
    backup: { kind: p.backup.kind, destination: p.backup.destination },
    scratchProfileRef: p.scratchProfileRef,
    requiresOfflineUpgrade: p.requiresOfflineUpgrade,
    switchMethod: p.switchMethod,
    recoveryMethod: p.recoveryMethod,
    retention: p.retention,
    restoreFiles: p.restoreFiles,
  })
}
export function createMigrationPlanDocument(
  input: MigrationPlanDocumentPayload,
): MigrationPlanDocument {
  const payload = MigrationPlanDocumentPayloadSchema.parse(input)
  if (
    valueDigest(payload.operatorDecisions) !== valueDigest(payload.conversionPlan.operatorDecisions)
  )
    throw new EpochSwitchError('v3-plan-operator-decisions-mismatch')
  return {
    payload,
    digest: valueDigest(payload),
    approvalDigest: migrationPlanApprovalDigest(payload),
  }
}
export function parseMigrationPlanDocument(text: string): MigrationPlanDocument {
  const document = MigrationPlanDocumentSchema.parse(JSON.parse(text) as unknown)
  const expected = createMigrationPlanDocument(document.payload)
  if (document.digest !== expected.digest || document.approvalDigest !== expected.approvalDigest)
    throw new EpochSwitchError('v3-plan-digest-mismatch')
  return document
}

export const ActivationReceiptPayloadSchema = z.strictObject({
  version: z.literal(1),
  operationId: EpochOperationIdSchema,
  runId: text,
  kind: EpochSwitchKindSchema,
  deployment: EpochDeploymentSchema,
  role: EpochGenerationRoleSchema,
  source: PlanSourceSchema,
  target: PlanTargetSchema,
  migrationPlanDigest: EpochDigestSchema,
  approvalDigest: EpochDigestSchema,
  /** The latest approval of this run, separate from the immutable initial run binding. */
  approvalRecordDigest: EpochDigestSchema.optional(),
  conversionPlanDigest: EpochDigestSchema,
  bindingDigest: EpochDigestSchema,
  summaryDigest: EpochDigestSchema,
  validationDigest: EpochDigestSchema,
  receiptExportDigest: EpochDigestSchema,
  backup: SwitchBackupReceiptSchema,
  contentManifestDigest: EpochDigestSchema,
  writerDrain: z.array(json).readonly(),
  familyCutoverSource: z.array(json).readonly(),
  lineage: z.array(MigrationRecordSchema).readonly(),
  identityHighWater: z.array(FoldedIdentityHighWaterSchema).readonly(),
  historyRestrictionsDigest: EpochDigestSchema,
  operatorDecisions: CanonicalOperatorDecisionsSchema,
  acknowledgementsDigest: EpochDigestSchema,
  candidateBuild: text,
  previousPointer: z.strictObject({
    bytesBase64: z.base64().nullable(),
    digest: EpochDigestSchema.nullable(),
    generationId: text.nullable(),
  }),
  restoreFiles: z.array(RestoreFileChangeSchema).readonly(),
  preparedAt: EpochTimestampSchema,
})
export type ActivationReceiptPayload = z.infer<typeof ActivationReceiptPayloadSchema>
export const ActivationReceiptSchema = z.strictObject({
  payload: ActivationReceiptPayloadSchema,
  digest: EpochDigestSchema,
})
export type ActivationReceipt = z.infer<typeof ActivationReceiptSchema>
export const RollbackReceiptPayloadSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('rolled-back'),
  operationId: EpochOperationIdSchema,
  runId: text.nullable(),
  generationId: EpochGenerationIdSchema.nullable(),
  /** Null when target meta never recorded activation, even if a prepared file exists. */
  activationReceiptDigest: EpochDigestSchema.nullable(),
  previousPointerDigest: EpochDigestSchema.nullable(),
  restoredPointerDigest: EpochDigestSchema.nullable(),
  firstLiveWriteAt: z.null(),
  targetState: z.enum(['not-created', 'retired']),
  restoredFiles: z.array(RestoreFileChangeSchema).readonly(),
  recordedAt: EpochTimestampSchema,
})
export type RollbackReceiptPayload = z.infer<typeof RollbackReceiptPayloadSchema>
export const RollbackReceiptSchema = z.strictObject({
  payload: RollbackReceiptPayloadSchema,
  digest: EpochDigestSchema,
})
export type RollbackReceipt = z.infer<typeof RollbackReceiptSchema>

function seal<T>(schema: z.ZodType<T>, input: T): { payload: T; digest: string } {
  const payload = schema.parse(input)
  return { payload, digest: valueDigest(payload) }
}
function read<T extends { readonly payload: unknown; readonly digest: string }>(
  schema: z.ZodType<T>,
  text: string,
): T {
  const receipt = schema.parse(JSON.parse(text) as unknown)
  if (valueDigest(receipt.payload) !== receipt.digest)
    throw new EpochSwitchError('v3-receipt-digest-mismatch')
  return receipt
}
export function createActivationReceipt(payload: ActivationReceiptPayload): ActivationReceipt {
  const operatorDecisions = canonicalOperatorDecisions(payload.operatorDecisions)
  const acknowledgementsDigest = valueDigest(operatorDecisions)
  if (
    valueDigest(payload.operatorDecisions) !== payload.acknowledgementsDigest &&
    acknowledgementsDigest !== payload.acknowledgementsDigest
  )
    throw new EpochSwitchError('v3-acknowledgements-digest-mismatch')
  return seal(ActivationReceiptPayloadSchema, {
    ...payload,
    operatorDecisions,
    acknowledgementsDigest,
  })
}
export function parseActivationReceipt(text: string): ActivationReceipt {
  const receipt = read(ActivationReceiptSchema, text)
  createActivationReceipt(receipt.payload)
  return receipt
}
export function createRollbackReceipt(payload: RollbackReceiptPayload): RollbackReceipt {
  return seal(RollbackReceiptPayloadSchema, payload)
}
export function parseRollbackReceipt(text: string): RollbackReceipt {
  return read(RollbackReceiptSchema, text)
}

export function createMigrationApproval(payload: MigrationApprovalPayload): MigrationApproval {
  return MigrationApprovalSchema.parse(seal(MigrationApprovalPayloadSchema, payload))
}
/** Append before mirroring into target meta; a retry must reuse the exact recorded approval. */
export function appendMigrationApproval(
  history: readonly MigrationApproval[],
  approval: MigrationApproval,
): readonly MigrationApproval[] {
  const records = MigrationApprovalHistorySchema.parse(history)
  const next = MigrationApprovalSchema.parse(approval)
  const existing = records.find(
    (record) =>
      record.payload.runId === next.payload.runId &&
      record.payload.sequence === next.payload.sequence,
  )
  if (existing) {
    if (existing.digest !== next.digest)
      throw new EpochSwitchError('v3-approval-history-conflict', { category: 'receipt-conflict' })
    return records
  }
  return MigrationApprovalHistorySchema.parse([...records, next])
}
export function latestMigrationApproval(
  history: readonly MigrationApproval[],
  runId: string,
): MigrationApproval | null {
  return (
    MigrationApprovalHistorySchema.parse(history)
      .filter((record) => record.payload.runId === runId)
      .at(-1) ?? null
  )
}
export function approveMigrationPlan(input: {
  readonly plan: MigrationPlanDocument
  readonly approve: string
  readonly runId: string
  readonly approvedAt: number
  readonly history: readonly MigrationApproval[]
}): MigrationApproval {
  const plan = parseMigrationPlanDocument(JSON.stringify(input.plan))
  if (input.approve !== plan.approvalDigest)
    throw new EpochSwitchError('v3-approval-digest-mismatch', { category: 'approval-required' })
  const latest = latestMigrationApproval(input.history, input.runId)
  if (
    latest?.payload.operationId === plan.payload.operationId &&
    latest.payload.approvalDigest === plan.approvalDigest
  )
    return latest
  const approval = createMigrationApproval({
    version: 1,
    operationId: plan.payload.operationId,
    runId: input.runId,
    sequence: latest ? latest.payload.sequence + 1 : 0,
    planDigest: plan.digest,
    approvalDigest: plan.approvalDigest,
    approvedAt: input.approvedAt,
    previousApprovalDigest: latest?.digest ?? null,
  })
  appendMigrationApproval(input.history, approval)
  return approval
}
/** Re-rendered numeric evidence may change planDigest; the approved material facts must match. */
export function assertActivationApproval(
  receipt: ActivationReceipt,
  history: readonly MigrationApproval[],
): MigrationApproval {
  const latest = latestMigrationApproval(history, receipt.payload.runId)
  if (
    !latest ||
    latest.payload.operationId !== receipt.payload.operationId ||
    latest.payload.approvalDigest !== receipt.payload.approvalDigest ||
    latest.digest !== receipt.payload.approvalRecordDigest
  )
    throw new EpochSwitchError('v3-activation-approval-mismatch', { category: 'approval-required' })
  return latest
}
