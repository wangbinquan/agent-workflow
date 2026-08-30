// RFC-344 — transport-neutral current-user operations for legacy DevelopmentMission inbound.

import { z } from 'zod'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { defineCommandOperation, defineQueryOperation } from '@/platform/operations/definitions'

/** Branded authority minted by identity-access; never a transport Actor. */
type Actor = DirectAuthenticatedAuthority

export interface DevelopmentMissionListInput {
  readonly limit?: string
  readonly cursor?: string
  readonly view?: string
  readonly statuses?: string
  readonly q?: string
  readonly employeeId?: string
  readonly missionStatuses?: string
}

export interface DevelopmentMissionFileView {
  readonly mediaType: string
  readonly bytes: number
  readonly openAll: () => ReadableStream<Uint8Array>
  readonly open: (start: number, endInclusive: number) => ReadableStream<Uint8Array>
}

export interface DevelopmentPipelineEvidenceReadView {
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly totalBytes: number
  readonly truncated: boolean
  readonly nextOffset: number | null
}

export type DevelopmentCutoverCommand = 'freeze' | 'flip' | 'rollback'

/**
 * Exact method surface consumed by the HTTP adapter. Body fields remain
 * versioned by the existing application schemas invoked behind these methods;
 * transport status/range headers are deliberately absent.
 */
export interface DevelopmentMissionOperations {
  readonly maxPipelineEvidenceReadBytes: number
  launch(
    actor: Actor,
    input: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly created: boolean
    readonly body: Record<string, unknown>
  }>
  preview(actor: Actor, input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>
  previewDirectInput(
    actor: Actor,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  list(input: DevelopmentMissionListInput): Promise<Record<string, unknown>>
  listOutcomeSummaries(): Promise<ReadonlyArray<unknown>>
  get(actor: Actor, missionId: string): Promise<Record<string, unknown>>
  getRequirementManifest(missionId: string): Promise<Record<string, unknown>>
  getRequirementFile(missionId: string, sha256: string): Promise<DevelopmentMissionFileView>
  selectRequirementSource(missionId: string, sourceKey: string): Promise<Record<string, unknown>>
  submitAnswers(
    missionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  confirmNoChange(
    actor: Actor,
    missionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  previewSourceRefresh(missionId: string): Promise<Record<string, unknown>>
  applySourceRefresh(missionId: string): Promise<Record<string, unknown>>
  cancel(missionId: string): Promise<Record<string, unknown>>
  retry(missionId: string): Promise<Record<string, unknown>>
  decisionTrace(missionId: string): Promise<ReadonlyArray<unknown>>
  readPipelineEvidence(
    missionId: string,
    sha256: string,
    offset: number,
    limit: number,
  ): Promise<DevelopmentPipelineEvidenceReadView>
  handoff(
    actor: Actor,
    missionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  attachMergeRequest(
    actor: Actor,
    missionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  resume(actor: Actor, missionId: string): Promise<Record<string, unknown>>
  readCutover(): Promise<Record<string, unknown>>
  materializeCutover(actor: Actor): Promise<Record<string, unknown>>
  commandCutover(actor: Actor, command: DevelopmentCutoverCommand): Promise<Record<string, unknown>>
  adoptMergeRequest(actor: Actor, input: unknown): Promise<Record<string, unknown>>
}

const publicErrors = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'unavailable',
  'internal-error',
] as const)
const emptySchema = z.object({}).strict()
const idSchema = z.object({ missionId: z.string().min(1) }).strict()
const jsonRecordSchema = z.record(z.unknown())
const bodySchema = z.record(z.unknown())
const actorBodySchema = z.object({ body: bodySchema }).strict()
const idBodySchema = z.object({ missionId: z.string().min(1), body: bodySchema }).strict()
const listSchema = z
  .object({
    limit: z.string().optional(),
    cursor: z.string().optional(),
    view: z.string().optional(),
    statuses: z.string().optional(),
    q: z.string().optional(),
    employeeId: z.string().optional(),
    missionStatuses: z.string().optional(),
  })
  .strict()
const sourceSchema = z
  .object({ missionId: z.string().min(1), sourceKey: z.string().min(1) })
  .strict()
const fileSchema = z.object({ missionId: z.string().min(1), sha256: z.string().min(1) }).strict()
const fileViewSchema = z.custom<DevelopmentMissionFileView>((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  return (
    Object.keys(record).sort().join(',') === 'bytes,mediaType,open,openAll' &&
    typeof record.mediaType === 'string' &&
    Number.isSafeInteger(record.bytes) &&
    typeof record.open === 'function' &&
    typeof record.openAll === 'function'
  )
})
const evidenceSchema = z
  .object({
    missionId: z.string().min(1),
    sha256: z.string().min(1),
    offset: z.number(),
    limit: z.number(),
  })
  .strict()
const evidenceViewSchema = z
  .object({
    mediaType: z.string(),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict()
export function createDevelopmentMissionDescriptors(operations: DevelopmentMissionOperations) {
  return Object.freeze({
    launch: defineCommandOperation({
      id: 'development-automation.launch-mission.v1',
      summary: 'Launch a development mission (direct body/uploads or external id)',
      permissions: ['development-missions:launch'],
      publicErrors,
      inputSchema: actorBodySchema,
      outputSchema: z.object({ created: z.boolean(), body: jsonRecordSchema }).strict(),
      invoke: (actor: Actor, input: z.infer<typeof actorBodySchema>) =>
        operations.launch(actor, input.body),
    }),
    preview: defineQueryOperation({
      id: 'development-automation.preview-mission.v1',
      summary:
        'Preview employee, policy and requirement-source admission without creating a mission',
      permissions: ['development-missions:launch'],
      publicErrors,
      inputSchema: actorBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof actorBodySchema>) =>
        operations.preview(actor, input.body),
    }),
    previewDirectInput: defineQueryOperation({
      id: 'development-automation.preview-direct-input.v1',
      summary: 'Preview per-upload target dispositions against the current repository baseline',
      permissions: ['development-missions:launch'],
      publicErrors,
      inputSchema: actorBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof actorBodySchema>) =>
        operations.previewDirectInput(actor, input.body),
    }),
    list: defineQueryOperation({
      id: 'development-automation.list-missions.v1',
      summary: 'List development missions (paged when `limit`/`cursor` is given)',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: listSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof listSchema>) => operations.list(input),
    }),
    listOutcomeSummaries: defineQueryOperation({
      id: 'development-automation.list-mission-outcome-summaries.v1',
      summary: 'List terminal legacy Mission outcome groups for every digital employee',
      permissions: ['digital-employees:read'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: z.array(z.unknown()),
      invoke: async () => [...(await operations.listOutcomeSummaries())],
    }),
    get: defineQueryOperation({
      id: 'development-automation.get-mission.v1',
      summary: 'Read one development mission (sources, readiness, block detail)',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.get(actor, input.missionId),
    }),
    getRequirementManifest: defineQueryOperation({
      id: 'development-automation.get-requirement-manifest.v1',
      summary: 'Read the immutable requirement bundle manifest for a mission',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.getRequirementManifest(input.missionId),
    }),
    getRequirementFile: defineQueryOperation({
      id: 'development-automation.get-requirement-file.v1',
      summary: 'Stream one requirement bundle file by content hash (supports Range)',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: fileSchema,
      outputSchema: fileViewSchema,
      invoke: (_actor: Actor, input: z.infer<typeof fileSchema>) =>
        operations.getRequirementFile(input.missionId, input.sha256),
    }),
    selectRequirementSource: defineCommandOperation({
      id: 'development-automation.select-requirement-source.v1',
      summary: 'Resolve the requirement source for a mission awaiting selection',
      permissions: ['development-missions:interact'],
      publicErrors,
      inputSchema: sourceSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof sourceSchema>) =>
        operations.selectRequirementSource(input.missionId, input.sourceKey),
    }),
    submitAnswers: defineCommandOperation({
      id: 'development-automation.submit-mission-answers.v1',
      summary: 'Submit platform-channel answers for the pending question set',
      permissions: ['development-missions:interact'],
      publicErrors,
      inputSchema: idBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idBodySchema>) =>
        operations.submitAnswers(input.missionId, input.body),
    }),
    confirmNoChange: defineCommandOperation({
      id: 'development-automation.confirm-no-change.v1',
      summary: 'Confirm the pending no-change gate (the only path into completed-no-change)',
      permissions: ['development-missions:interact'],
      publicErrors,
      inputSchema: idBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idBodySchema>) =>
        operations.confirmNoChange(actor, input.missionId, input.body),
    }),
    previewSourceRefresh: defineQueryOperation({
      id: 'development-automation.preview-source-refresh.v1',
      summary:
        'Re-fetch the external requirement source and compare source revisions (no state change)',
      permissions: ['development-missions:interact'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.previewSourceRefresh(input.missionId),
    }),
    applySourceRefresh: defineCommandOperation({
      id: 'development-automation.apply-source-refresh.v1',
      summary: 'Apply an external requirement source refresh (new source generation + cell reset)',
      permissions: ['development-missions:interact'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.applySourceRefresh(input.missionId),
    }),
    cancel: defineCommandOperation({
      id: 'development-automation.cancel-mission.v1',
      summary: 'Cancel a mission (fences writes; settles dispatched effects first)',
      permissions: ['development-missions:cancel'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.cancel(input.missionId),
    }),
    retry: defineCommandOperation({
      id: 'development-automation.retry-mission.v1',
      summary: 'Retry a blocked mission after remediation',
      permissions: ['development-missions:retry'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (_actor: Actor, input: z.infer<typeof idSchema>) => operations.retry(input.missionId),
    }),
    decisionTrace: defineQueryOperation({
      id: 'development-automation.get-decision-trace.v1',
      summary: 'Read the canonical guard/rule decision trace for a mission',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: z.array(z.unknown()),
      invoke: async (_actor: Actor, input: z.infer<typeof idSchema>) => [
        ...(await operations.decisionTrace(input.missionId)),
      ],
    }),
    readPipelineEvidence: defineQueryOperation({
      id: 'development-automation.read-pipeline-evidence.v1',
      summary:
        'Bounded ranged read of one pipeline evidence file (offset/limit, honest truncation)',
      permissions: ['development-missions:read'],
      publicErrors,
      inputSchema: evidenceSchema,
      outputSchema: evidenceViewSchema,
      invoke: (_actor: Actor, input: z.infer<typeof evidenceSchema>) =>
        operations.readPipelineEvidence(input.missionId, input.sha256, input.offset, input.limit),
    }),
    handoff: defineCommandOperation({
      id: 'development-automation.handoff-mission.v1',
      summary: 'Hand the mission over to a human (automation becomes tracking-only)',
      permissions: ['development-missions:handoff'],
      publicErrors,
      inputSchema: idBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idBodySchema>) =>
        operations.handoff(actor, input.missionId, input.body),
    }),
    attachMergeRequest: defineCommandOperation({
      id: 'development-automation.attach-mission-merge-request.v1',
      summary: 'Attach a manually created merge request to a handed-over mission',
      permissions: ['development-missions:attach'],
      publicErrors,
      inputSchema: idBodySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idBodySchema>) =>
        operations.attachMergeRequest(actor, input.missionId, input.body),
    }),
    resume: defineCommandOperation({
      id: 'development-automation.resume-mission.v1',
      summary: 'Resume automation on a tracking-only mission (facts refresh first)',
      permissions: ['development-missions:resume'],
      publicErrors,
      inputSchema: idSchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: z.infer<typeof idSchema>) =>
        operations.resume(actor, input.missionId),
    }),
    readCutover: defineQueryOperation({
      id: 'development-automation.read-cutover.v1',
      summary: 'Cutover state + freshly computed migration preflight report (T97 reconciliation)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: jsonRecordSchema,
      invoke: () => operations.readCutover(),
    }),
    materializeCutover: defineCommandOperation({
      id: 'development-automation.materialize-cutover.v1',
      summary: 'Materialize migration candidates as unpublished drafts (T95, idempotent)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor) => operations.materializeCutover(actor),
    }),
    freezeCutover: defineCommandOperation({
      id: 'development-automation.freeze-cutover.v1',
      summary: 'Freeze legacy admission (T99: rounds API + code-round webhooks reject new work)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor) => operations.commandCutover(actor, 'freeze'),
    }),
    flipCutover: defineCommandOperation({
      id: 'development-automation.flip-cutover.v1',
      summary: 'Flip the writer generation to missions (T101)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor) => operations.commandCutover(actor, 'flip'),
    }),
    rollbackCutover: defineCommandOperation({
      id: 'development-automation.rollback-cutover.v1',
      summary: 'Roll back a frozen cutover to pre (T102; refused after flip)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: emptySchema,
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor) => operations.commandCutover(actor, 'rollback'),
    }),
    adoptMergeRequest: defineCommandOperation({
      id: 'development-automation.adopt-merge-request.v1',
      summary: 'Adopt an externally open MR as a watching mission (T100; runbook step 4/5)',
      permissions: ['development-missions:cutover'],
      publicErrors,
      inputSchema: z.object({ body: bodySchema }).strict(),
      outputSchema: jsonRecordSchema,
      invoke: (actor: Actor, input: { readonly body: Record<string, unknown> }) =>
        operations.adoptMergeRequest(actor, input.body),
    }),
  })
}
