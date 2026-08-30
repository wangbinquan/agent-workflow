// RFC-344 — bootstrap composition for DevelopmentMission inbound operations.

import { readFileSync } from 'node:fs'
import { ulid } from 'ulid'
import { z } from 'zod'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import {
  cancelMission,
  launchMission,
  launchMissionInputSchema,
  previewDirectInput,
  previewMissionAdmission,
  retryBlockedMission,
  selectMissionRequirementSource,
  type LaunchDeps,
} from '../application/commands/launchMission'
import { composeDevelopmentAutomation, type DevelopmentAutomationModule } from '../composition'
import { runCutoverCommand, adoptActiveMr } from '../application/cutover'
import { readEvidenceFileRange, EVIDENCE_READ_MAX_BYTES } from '../application/pipelineEvidenceRead'
import { projectMissionJourney } from '../domain/journeyProjection'
import type { OperationFailureReceipt } from '../domain/operationFailure'
import { pipelineEvidenceManifestV1Schema } from '../domain/pipelineManifest'
import { createRepositoryBaselineResolver } from '../infrastructure/gitBaselineReader'
import {
  materializeMigrationCandidates,
  readPersistedMigrationRun,
  runMigrationAnalysis,
} from '../infrastructure/migrationAssets'
import {
  getDecisionTrace,
  getMissionDetail,
  getMissionMergeRequestView,
  listMissionEffects,
  listMissionSummaries,
  listMissionSummariesPage,
  listMissionTerminalOutcomeGroups,
  type MissionPageCursor,
} from '../infrastructure/missionReadModels'
import {
  createSqliteFactSnapshotReader,
  missionIdOfExecutionRef,
} from '../infrastructure/sqliteReconcilerReaders'
import { createSqliteAdmissionLookup } from '../infrastructure/sqliteAdmissionLookup'
import { createSqliteCutoverStore } from '../infrastructure/sqliteCutoverStore'
import { createSqliteMissionStore } from '../infrastructure/sqliteMissionStore'
import { insertUploadPlan } from '../infrastructure/sqliteUploadPlanStore'
import { createSqliteUploadSessionStore } from '../infrastructure/sqliteUploadSessionStore'
import type {
  DevelopmentMissionListInput,
  DevelopmentMissionOperations,
} from '../public/operations'
import { composeApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
} from '@/modules/source-control/composition'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
  resolveRepoClaimKey,
} from '@/services/developmentDeliveryDeps'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { DomainError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { DIGITAL_EMPLOYEE_MISSION_STATUSES } from '@agent-workflow/shared'

const log = createLogger('development-missions')

const MissionCursorSchema = z
  .object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) })
  .strict()
const MissionViewSchema = z.enum(['all', 'active', 'attention', 'finished'])
const RawMissionStatusesSchema = z.array(z.enum(DIGITAL_EMPLOYEE_MISSION_STATUSES))
const MissionStatusesSchema = z.array(
  z.enum([
    'pending',
    'running',
    'done',
    'failed',
    'canceled',
    'interrupted',
    'awaiting_review',
    'awaiting_human',
  ]),
)

function refreshFailureError(failure: OperationFailureReceipt): DomainError {
  if (failure.code === 'mission-not-found') {
    return new NotFoundError('mission-not-found', 'mission not found')
  }
  if (failure.category === 'invalid-user-input') {
    return new ValidationError(failure.code, failure.remediation)
  }
  return new ConflictError(failure.code, failure.remediation)
}

function encodeMissionCursor(cursor: MissionPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url')
}

function decodeMissionCursor(raw: string): MissionPageCursor | null {
  try {
    const parsed = MissionCursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface DevelopmentMissionOperationCompositionDeps {
  readonly db: DbClient
  readonly configPath: string
  readonly appHome: string
  readonly secretBox?: SecretBox
  readonly schedulerDriver: SchedulerDriverPort
  readonly repositoryPublicationTransport: RepositoryPublicationTransport
  /**
   * Bootstrap-owned daemon participant. Production injects the same instance
   * that owns recovery and wake sweeps; isolated route tests omit it and get
   * one local composition for that app.
   */
  readonly automation?: DevelopmentAutomationModule
  readonly legacyAdmissionsEnabled: () => boolean
}

export function composeDevelopmentMissionOperations(
  deps: DevelopmentMissionOperationCompositionDeps,
): DevelopmentMissionOperations {
  const uploadSessions = createSqliteUploadSessionStore(deps.db)
  const snapshots = createSqliteFactSnapshotReader(deps.db)
  const missionStore = createSqliteMissionStore(deps.db)
  let fireReconcile: (missionId: string) => void = () => undefined
  const automation =
    deps.automation ??
    composeDevelopmentAutomation({
      db: deps.db,
      appHome: deps.appHome,
      requirementSource: composeRequirementSourceRunner(deps.db),
      changeCandidate: bindChangeCandidateParticipant(),
      candidateDelivery: bindCandidateDeliveryParticipant({
        publicationTransport: deps.repositoryPublicationTransport,
      }),
      conflictMerge: bindConflictMergeParticipant(),
      ...buildDevelopmentDeliveryDeps(deps.db, deps.secretBox),
      ...buildDevelopmentPipelineDeps(deps.db),
      ...buildDevelopmentMrFactsDeps(deps.db, deps.secretBox),
      agentLauncher: composeAgentActionExecution({
        db: deps.db,
        startDeps: buildStartTaskDeps(
          deps.db,
          deps.schedulerDriver,
          deps.configPath,
          SYSTEM_USER_ID,
          deps.secretBox,
        ),
        onTerminal: (executionRef) => {
          const missionId = missionIdOfExecutionRef(deps.db, executionRef)
          if (missionId === null) return
          missionStore.recordWakeHint({
            id: ulid(),
            missionId,
            source: 'agent-execution',
            deliveryKey: `agent-exec:${executionRef}`,
            now: Date.now(),
          })
          fireReconcile(missionId)
        },
      }),
      scriptLauncher: composeScriptActionExecution({
        db: deps.db,
        startDeps: buildStartTaskDeps(
          deps.db,
          deps.schedulerDriver,
          deps.configPath,
          SYSTEM_USER_ID,
          deps.secretBox,
        ),
        onTerminal: (executionRef) => {
          const missionId = missionIdOfExecutionRef(deps.db, executionRef)
          if (missionId === null) return
          missionStore.recordWakeHint({
            id: ulid(),
            missionId,
            source: 'agent-execution',
            deliveryKey: `script-exec:${executionRef}`,
            now: Date.now(),
          })
          fireReconcile(missionId)
        },
      }),
      approvalGateway: composeApprovalGatewayRunner(deps.db),
    })
  const launchDeps: LaunchDeps = {
    store: missionStore,
    lookup: createSqliteAdmissionLookup(deps.db),
    now: () => Date.now(),
    uploadAdmission: {
      sessions: uploadSessions,
      transact: (fn) => deps.db.transaction(() => fn()),
      resolveBaseline: createRepositoryBaselineResolver(deps.db),
      persistPlan: (plan) => insertUploadPlan(deps.db, plan),
    },
  }

  fireReconcile = (missionId: string): void => {
    void automation
      .drive(missionId)
      .then((outcome) => {
        if (outcome.stop === 'step-budget') {
          log.warn('mission drive reached its bounded step budget', {
            missionId,
            steps: outcome.steps,
          })
        }
      })
      .catch((error: unknown) => {
        log.warn('mission drive after route mutation failed', {
          missionId,
          err: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const stashDirectAfterLaunch = async (raw: unknown, missionId: string): Promise<boolean> => {
    const parsed = launchMissionInputSchema.safeParse(raw)
    if (!parsed.success || parsed.data.submission.kind !== 'direct') return false
    const submission = parsed.data.submission
    const stashed = await automation.materializer.stashDirectSubmission({
      missionId,
      submission: {
        title: submission.title,
        body: submission.body,
        uploads: submission.uploads.map((upload, ordinal) => {
          const row = uploadSessions.getUpload(upload.uploadRef)
          return {
            ordinal,
            fileName: row?.originalName ?? '',
            sha256: row?.sha256 ?? null,
            targetPath: upload.repositoryTargetPath,
            collisionMode: upload.collisionMode ?? 'create-only',
            contentPolicy: upload.contentPolicy ?? 'preserve-upload',
            fileMode: upload.fileMode ?? 'regular',
          }
        }),
      },
    })
    if (!stashed.ok) {
      throw new ConflictError(
        stashed.failure.code,
        `direct submission stash failed: ${stashed.failure.remediation}`,
      )
    }
    return true
  }

  const requireMission = (missionId: string) => {
    const detail = getMissionDetail(deps.db, missionId)
    if (detail === null) throw new NotFoundError('mission-not-found', 'mission not found')
    return detail
  }

  const cutoverStore = createSqliteCutoverStore(deps.db)
  const cutoverDeps = {
    cutoverStore,
    now: () => Date.now(),
    mintId: () => ulid(),
  }
  const adoptPorts = {
    mrEffects: buildDevelopmentDeliveryDeps(deps.db, deps.secretBox).mrEffects,
  }

  const operations: DevelopmentMissionOperations = {
    maxPipelineEvidenceReadBytes: EVIDENCE_READ_MAX_BYTES,
    async launch(actor, body) {
      if (!deps.legacyAdmissionsEnabled()) {
        throw new ConflictError(
          'legacy-mission-admission-retired',
          'new work must be launched through a published Digital Employee; existing Missions remain available until they reach terminal state',
        )
      }
      const input = { ...body, actorUserId: actor.userId }
      const result = await launchMission(launchDeps, input)
      const directStashed = await stashDirectAfterLaunch(input, result.missionId)
      if (!result.created && directStashed) {
        const mission = missionStore.getMission(result.missionId)
        if (
          mission?.status === 'blocked' &&
          mission.blockCode === 'requirement-acquire-failed:direct-submission-not-staged'
        ) {
          await retryBlockedMission(launchDeps, { missionId: result.missionId })
        }
      }
      if (result.created || directStashed) fireReconcile(result.missionId)
      return { created: result.created, body: { ...result } }
    },
    async preview(actor, body) {
      const result = await previewMissionAdmission(launchDeps, {
        ...body,
        actorUserId: actor.userId,
      })
      return { ...result }
    },
    async previewDirectInput(actor, body) {
      const result = await previewDirectInput(launchDeps, {
        ...body,
        actorUserId: actor.userId,
      })
      return { ...result }
    },
    async list(input: DevelopmentMissionListInput) {
      const paged = Object.values(input).some((value) => value !== undefined)
      if (!paged) return { items: listMissionSummaries(deps.db) }
      const view = MissionViewSchema.safeParse(input.view ?? 'all')
      if (!view.success) {
        throw new ValidationError('mission-view-invalid', `'${String(input.view)}' is not a view`)
      }
      const rawMissionStatuses = RawMissionStatusesSchema.safeParse(
        input.missionStatuses === undefined || input.missionStatuses === ''
          ? []
          : input.missionStatuses.split(','),
      )
      if (!rawMissionStatuses.success) {
        throw new ValidationError(
          'mission-raw-statuses-invalid',
          `'${String(input.missionStatuses)}' is not a mission status set`,
        )
      }
      const statuses = MissionStatusesSchema.safeParse(
        input.statuses === undefined || input.statuses === '' ? [] : input.statuses.split(','),
      )
      if (!statuses.success) {
        throw new ValidationError(
          'mission-statuses-invalid',
          `'${String(input.statuses)}' is not a status set`,
        )
      }
      const limit = input.limit === undefined ? 50 : Number(input.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ValidationError(
          'mission-limit-invalid',
          `'${String(input.limit)}' is not a limit`,
        )
      }
      let cursor: MissionPageCursor | undefined
      if (input.cursor !== undefined) {
        const parsed = decodeMissionCursor(input.cursor)
        if (parsed === null) {
          throw new ValidationError('mission-cursor-invalid', 'cursor is not decodable')
        }
        cursor = parsed
      }
      const page = listMissionSummariesPage(deps.db, {
        limit,
        view: view.data,
        statuses: statuses.data,
        ...(input.q === undefined || input.q === '' ? {} : { q: input.q }),
        ...(input.employeeId === undefined || input.employeeId === ''
          ? {}
          : { employeeId: input.employeeId }),
        ...(rawMissionStatuses.data.length === 0
          ? {}
          : { missionStatuses: rawMissionStatuses.data }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      return {
        items: page.items,
        nextCursor: page.nextCursor === null ? null : encodeMissionCursor(page.nextCursor),
        counts: page.counts,
      }
    },
    async listOutcomeSummaries() {
      return listMissionTerminalOutcomeGroups(deps.db)
    },
    async get(actor, missionId) {
      const detail = requireMission(missionId)
      const mission = missionStore.getMission(missionId)
      const cells =
        mission?.requirementBundleRef == null
          ? null
          : snapshots.getCells(mission.requirementBundleRef)
      const knownString = (id: string): string | null => {
        const cell = cells?.[id]
        return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
          ? cell.value
          : null
      }
      const pendingQuestionSetRef = knownString('__requirement.pendingQuestionSetRef')
      const questions =
        pendingQuestionSetRef === null
          ? null
          : automation.materializer.loadQuestionSet(pendingQuestionSetRef)
      const mergeRequest = getMissionMergeRequestView(deps.db, missionId, detail.repositoryId)
      const collaborationReceipts = automation.collaboration(missionId)
      const activeChild = [...collaborationReceipts.children]
        .reverse()
        .find(
          (child) =>
            !child.completionSatisfied &&
            child.childMissionId !== null &&
            !['blocked', 'handoff', 'canceled', 'closed-unmerged'].includes(child.status ?? ''),
        )
      const activeApproval = [...collaborationReceipts.approvals]
        .reverse()
        .find((approval) => approval.status === 'submitting' || approval.status === 'pending')
      const collaboration =
        activeApproval !== undefined &&
        (activeChild === undefined || activeApproval.updatedAt >= (activeChild.observedAt ?? 0))
          ? {
              kind: 'approval' as const,
              href:
                activeApproval.externalRequestRef !== null &&
                /^https?:\/\//.test(activeApproval.externalRequestRef)
                  ? activeApproval.externalRequestRef
                  : null,
              resumeAt: activeApproval.nextObserveAt,
              deadlineAt: activeApproval.deadlineAt,
              needsHuman: activeApproval.status === 'pending',
            }
          : activeChild === undefined
            ? null
            : {
                kind: 'child-mission' as const,
                href: `/code/missions/${encodeURIComponent(activeChild.childMissionId!)}`,
                resumeAt: null,
                deadlineAt: activeChild.deadlineAt,
              }
      const pipeline = (() => {
        const manifestRef = knownString('__pipeline.manifestRef')
        if (manifestRef === null) return null
        try {
          const parsed = pipelineEvidenceManifestV1Schema.safeParse(
            JSON.parse(readFileSync(automation.evidence.blobPath(manifestRef), 'utf8')),
          )
          if (!parsed.success) return null
          return {
            bundleId: parsed.data.bundleId,
            headSha: parsed.data.headSha,
            completeness: parsed.data.completeness,
            collectedAt: knownString('__pipeline.collectedAt'),
            gates: parsed.data.gates.map((gate) => ({
              gateKey: gate.gateKey,
              required: gate.required,
              status: gate.status,
              runRef: gate.runRef,
              attempt: gate.attempt,
              failureCategories: gate.failureCategories,
            })),
            files: parsed.data.files.map((file) => ({
              fileId: file.fileId,
              relativePath: file.relativePath,
              mediaType: file.mediaType,
              bytes: file.bytes,
              sha256: file.sha256,
            })),
          }
        } catch {
          return null
        }
      })()
      return {
        ...detail,
        questions:
          questions === null || pendingQuestionSetRef === null
            ? null
            : {
                questionSetRef: pendingQuestionSetRef,
                origin: questions.origin,
                channel: questions.channel,
                items: questions.questions,
              },
        action: {
          lastOutcome: knownString('action.lastOutcome'),
          lastCapability: knownString('action.lastCapability'),
          candidateRef: knownString('__action.candidateRef'),
          clarificationState: knownString('requirement.clarificationState'),
        },
        effects: listMissionEffects(deps.db, missionId),
        collaboration: collaborationReceipts,
        mergeRequest,
        journey: projectMissionJourney({
          missionId,
          status: detail.status,
          automationMode: detail.automationMode,
          transitionFence: detail.transitionFence,
          blockCode: detail.blockCode,
          hasQuestions: questions !== null,
          hasMergeRequest: mergeRequest !== null,
          mergeRequestHref: mergeRequest?.href ?? null,
          canInteract: actor.permissions.has('development-missions:interact'),
          canRetry: actor.permissions.has('development-missions:retry'),
          canAttach: actor.permissions.has('development-missions:attach'),
          canResume: actor.permissions.has('development-missions:resume'),
          collaboration,
        }),
        pipeline,
      }
    },
    async getRequirementManifest(missionId) {
      requireMission(missionId)
      const manifest = automation.materializer.getRequirementManifest(missionId)
      if (manifest === null) {
        throw new NotFoundError(
          'requirement-manifest-not-found',
          'no requirement bundle has been materialized for this mission yet',
        )
      }
      return { missionId, manifest }
    },
    async getRequirementFile(missionId, sha256) {
      requireMission(missionId)
      const manifest = automation.materializer.getRequirementManifest(missionId)
      if (manifest === null) {
        throw new NotFoundError(
          'requirement-manifest-not-found',
          'no requirement bundle has been materialized for this mission yet',
        )
      }
      const entry = manifest.files.find((file) => file.sha256 === sha256)
      if (entry === undefined) {
        throw new NotFoundError(
          'requirement-file-not-found',
          'the hash is not part of this mission requirement bundle',
        )
      }
      const blob = Bun.file(automation.evidence.blobPath(sha256))
      if (!(await blob.exists())) {
        throw new NotFoundError('evidence-blob-missing', 'evidence blob is missing on disk')
      }
      return {
        mediaType: entry.mediaType,
        bytes: entry.bytes,
        openAll: () => blob.stream(),
        open: (start, endInclusive) => blob.slice(start, endInclusive + 1).stream(),
      }
    },
    async selectRequirementSource(missionId, sourceKey) {
      const result = await selectMissionRequirementSource(launchDeps, {
        missionId,
        sourceKey,
      })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async submitAnswers(missionId, input) {
      const result = await automation.submitAnswers({ ...input, missionId })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async confirmNoChange(actor, missionId, input) {
      const result = await automation.confirmNoChange({ ...input, missionId })
      log.info('mission no-change confirmed', { missionId, userId: actor.userId })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async previewSourceRefresh(missionId) {
      requireMission(missionId)
      const out = await automation.materializer.previewExternalRefresh(missionId)
      if (!out.ok) throw refreshFailureError(out.failure)
      return {
        missionId,
        changed: out.changed,
        currentSourceRevision: out.currentSourceRevision,
        newSourceRevision: out.newSourceRevision,
        manifestDigest: out.manifestDigest,
        fileCount: out.fileCount,
        totalBytes: out.totalBytes,
      }
    },
    async applySourceRefresh(missionId) {
      requireMission(missionId)
      const out = await automation.materializer.applyExternalRefresh(missionId)
      if (!out.ok) throw refreshFailureError(out.failure)
      fireReconcile(missionId)
      return { missionId, changed: out.changed, sourceRevision: out.sourceRevision }
    },
    async cancel(missionId) {
      const result = await cancelMission(launchDeps, { missionId })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async retry(missionId) {
      const result = await retryBlockedMission(launchDeps, { missionId })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async decisionTrace(missionId) {
      requireMission(missionId)
      return getDecisionTrace(deps.db, missionId)
    },
    async readPipelineEvidence(missionId, sha256, offset, limit) {
      requireMission(missionId)
      const mission = missionStore.getMission(missionId)
      const cells =
        mission?.requirementBundleRef == null
          ? null
          : snapshots.getCells(mission.requirementBundleRef)
      const manifestRefCell = cells?.['__pipeline.manifestRef']
      const manifestRef =
        manifestRefCell !== undefined &&
        manifestRefCell.state === 'known' &&
        typeof manifestRefCell.value === 'string'
          ? manifestRefCell.value
          : null
      if (manifestRef === null) {
        throw new NotFoundError(
          'evidence-not-collected',
          'no pipeline evidence has been collected for this mission yet',
        )
      }
      const manifestBlob = Bun.file(automation.evidence.blobPath(manifestRef))
      if (!(await manifestBlob.exists())) {
        throw new NotFoundError('evidence-blob-missing', 'pipeline manifest blob is missing')
      }
      let manifestJson: unknown
      try {
        manifestJson = JSON.parse(await manifestBlob.text())
      } catch {
        throw new NotFoundError('pipeline-manifest-invalid', 'stored pipeline manifest is invalid')
      }
      const manifest = pipelineEvidenceManifestV1Schema.safeParse(manifestJson)
      if (!manifest.success) {
        throw new NotFoundError('pipeline-manifest-invalid', 'stored pipeline manifest is invalid')
      }
      const entry = manifest.data.files.find((file) => file.sha256 === sha256)
      if (entry === undefined) {
        throw new NotFoundError(
          'pipeline-evidence-file-not-found',
          'the hash is not part of this mission pipeline evidence bundle',
        )
      }
      const read = readEvidenceFileRange(
        { blobPath: (ref) => automation.evidence.blobPath(ref) },
        { sha256, offsetBytes: offset, limitBytes: limit },
      )
      if (!read.ok) {
        if (read.code === 'range-invalid') {
          throw new ValidationError('range-invalid', 'offset/limit must be valid integers')
        }
        throw new NotFoundError('evidence-blob-missing', 'evidence blob is missing on disk')
      }
      return {
        mediaType: entry.mediaType,
        bytes: read.bytes,
        totalBytes: read.totalBytes,
        truncated: read.truncated,
        nextOffset: read.nextOffset,
      }
    },
    async handoff(actor, missionId, input) {
      const result = await automation.handoff({ ...input, missionId })
      log.info('mission handoff', { missionId, userId: actor.userId, pending: result.pending })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async attachMergeRequest(actor, missionId, input) {
      const result = await automation.attachMr({ ...input, missionId })
      log.info('mission attach-mr', {
        missionId,
        userId: actor.userId,
        mrClaimId: result.mrClaimId,
      })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async resume(actor, missionId) {
      const result = await automation.resume({ missionId })
      log.info('mission resume', { missionId, userId: actor.userId })
      fireReconcile(missionId)
      return { missionId, ...result }
    },
    async readCutover() {
      return {
        state: cutoverStore.readState(),
        preflight: await runMigrationAnalysis(deps.db, Date.now()),
        persisted: await readPersistedMigrationRun(deps.db),
      }
    },
    async materializeCutover(actor) {
      const report = await runMigrationAnalysis(deps.db, Date.now())
      const result = await materializeMigrationCandidates(deps.db, report)
      log.info('cutover materialize', {
        userId: actor.userId,
        created: result.created.length,
        skipped: result.skipped.length,
      })
      return { report, ...result }
    },
    async commandCutover(actor, command) {
      const result = runCutoverCommand(cutoverDeps, command)
      if (!result.ok) {
        throw new ConflictError(
          result.code === 'cutover-rollback-after-flip'
            ? 'cutover-rollback-after-flip'
            : 'cutover-phase-invalid',
          result.detail,
        )
      }
      log.info('cutover command', { command, userId: actor.userId, state: result.state })
      return { state: result.state }
    },
    async adoptMergeRequest(actor, raw) {
      const body = z
        .object({
          repositoryId: z.string().min(1),
          mrIid: z.string().min(1),
          employee: z.object({ id: z.string(), revision: z.number().int() }).nullish(),
          policy: z.object({ id: z.string(), revision: z.number().int() }).nullish(),
          legacyWorkItemId: z.string().nullish(),
          legacyRoundId: z.string().nullish(),
        })
        .strict()
        .parse(raw)
      const claimKey = resolveRepoClaimKey(deps.db, deps.secretBox, body.repositoryId)
      if (claimKey === null) {
        throw new ValidationError(
          'cutover-repo-binding-missing',
          'repository has no resolvable code-host binding',
        )
      }
      const result = await adoptActiveMr(
        { store: missionStore, ports: adoptPorts, ...cutoverDeps },
        {
          repositoryId: body.repositoryId,
          mrIid: body.mrIid,
          codeHostEndpointRef: claimKey.codeHostEndpointRef,
          stableProjectRef: claimKey.stableProjectRef,
          employee: body.employee ?? null,
          policy: body.policy ?? null,
          legacyWorkItemId: body.legacyWorkItemId ?? null,
          legacyRoundId: body.legacyRoundId ?? null,
          actorUserId: actor.userId,
        },
      )
      if (!result.ok) {
        throw new ConflictError('cutover-adopt-rejected', `${result.code}: ${result.detail}`)
      }
      log.info('cutover adopt-mr', {
        userId: actor.userId,
        missionId: result.missionId,
        terminal: result.terminal,
      })
      if (result.terminal === null) fireReconcile(result.missionId)
      return { ...result }
    },
  }
  return Object.freeze(operations)
}
