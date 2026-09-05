// RFC-359 W4-D10 —— Mission 持久化（RFC-310 PR-2 的存储合同）：一份实现，两个 provider 共用。
//
// 并发模型不变（port 头注释）：**OCC 即 lease**——每次 mutation 带 (expectedRevision, expectedEpoch)，条件
// UPDATE + RETURNING 就是 CAS；不变量的最终兜底全部落在 0177 的唯一 / 部分唯一索引上（launch idempotency、
// active MR claim、writable action 单活、attempt ordinal、effect idempotency、decision input 去重）——
// `insert … onConflictDoNothing().returning()` 在两个引擎上同形，进程内检查只负责把索引冲突翻译成 typed 结果。
// 多语句原子操作（launch、快照 + 决策、effect 状态机迁移、wake hint 消费）走统一事务原语；effect 迁移是
// 读—判—写，先 `lockAggregateRoot` 锁 effect 行（PG FOR UPDATE，SQLite 独占事务下 no-op）。

import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentActionRuns,
  developmentAgentAttempts,
  developmentDecisions,
  developmentDeferredWakes,
  developmentEffects,
  developmentFactSnapshots,
  developmentFeedbackLedger,
  developmentMissions,
  developmentMissionSources,
  developmentMrClaims,
  developmentWakeHints,
} from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { ValidationError } from '@/util/errors'
import type { DeferredWakeRow } from '../domain/deferredWake'
import { MISSION_STATUSES } from '../domain/mission'
import type {
  ActionRunRow,
  EffectRow,
  FeedbackLedgerRow,
  MissionDecisionWrite,
  MissionDecisionWriteReceipt,
  MissionFactSnapshotWrite,
  MissionRow,
  MissionPersistence,
  MissionSourceRow,
  OccResult,
} from '../application/ports/missionStore'
import { insertUploadPlan } from './uploadPlanStore'
import { claimUploadSessions } from './uploadSessionStore'

type MissionDbRow = typeof developmentMissions.$inferSelect

function toMissionRow(row: MissionDbRow): MissionRow {
  if (!MISSION_STATUSES.includes(row.status as MissionRow['status'])) {
    throw new Error(`invalid persisted mission status: ${row.status}`)
  }
  if (row.automationMode !== 'active' && row.automationMode !== 'tracking-only') {
    throw new Error(`invalid persisted automation mode: ${row.automationMode}`)
  }
  if (
    row.transitionFence !== 'none' &&
    row.transitionFence !== 'cancel-pending' &&
    row.transitionFence !== 'handoff-pending'
  ) {
    throw new Error(`invalid persisted transition fence: ${row.transitionFence}`)
  }
  if (row.sourceKind !== 'direct' && row.sourceKind !== 'external-reference') {
    throw new Error(`invalid persisted source kind: ${row.sourceKind}`)
  }
  if (row.deliveryKind !== 'create-merge-request' && row.deliveryKind !== 'adopt-merge-request') {
    throw new Error(`invalid persisted delivery kind: ${row.deliveryKind}`)
  }
  return {
    id: row.id,
    revision: row.revision,
    epoch: row.epoch,
    status: row.status as MissionRow['status'],
    automationMode: row.automationMode,
    transitionFence: row.transitionFence,
    repositoryId: row.repositoryId,
    sourceKind: row.sourceKind,
    sourceContentDigest: row.sourceContentDigest,
    requestedSourceKey: row.requestedSourceKey,
    externalId: row.externalId,
    resolvedSourceKey: row.resolvedSourceKey,
    resolvedAdapterId: row.resolvedAdapterId,
    resolvedAdapterRevision: row.resolvedAdapterRevision,
    deliveryKind: row.deliveryKind,
    deliveryTargetRef: row.deliveryTargetRef,
    deliverySourceBranch: row.deliverySourceBranch,
    adoptedMrRef: row.adoptedMrRef,
    assignmentId: row.assignmentId,
    employeeId: row.employeeId,
    employeeRevision: row.employeeRevision,
    policyId: row.policyId,
    policyRevision: row.policyRevision,
    requirementBundleRef: row.requirementBundleRef,
    repositoryFactsRef: row.repositoryFactsRef,
    uploadPlanRef: row.uploadPlanRef,
    uploadPlacementRef: row.uploadPlacementRef,
    uploadPublicationRef: row.uploadPublicationRef,
    mrClaimId: row.mrClaimId,
    currentActionRunId: row.currentActionRunId,
    readinessJson: row.readinessJson,
    blockCode: row.blockCode,
    blockDetail: row.blockDetail,
    terminalKind: row.terminalKind,
    terminalUploadFulfillment: row.terminalUploadFulfillment,
    terminalAt: row.terminalAt,
    reopenedFromMissionId: row.reopenedFromMissionId,
    launchIdempotencyKey: row.launchIdempotencyKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toEffectRow(row: typeof developmentEffects.$inferSelect): EffectRow {
  return {
    id: row.id,
    missionId: row.missionId,
    actionRunId: row.actionRunId,
    effectKind: row.effectKind,
    intentDigest: row.intentDigest,
    idempotencyKey: row.idempotencyKey,
    epoch: row.epoch,
    state: row.state as EffectRow['state'],
    receiptRef: row.receiptRef,
  }
}

function toMissionSourceRow(row: typeof developmentMissionSources.$inferSelect): MissionSourceRow {
  if (row.sourceKind !== 'direct' && row.sourceKind !== 'external-reference') {
    throw new Error(`invalid persisted mission source kind: ${row.sourceKind}`)
  }
  return {
    id: row.id,
    missionId: row.missionId,
    generation: row.generation,
    sourceKind: row.sourceKind,
    externalId: row.externalId,
    adapterId: row.adapterId,
    adapterRevision: row.adapterRevision,
    sourceRevision: row.sourceRevision,
    bundleRef: row.bundleRef,
    manifestDigest: row.manifestDigest,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    state: row.state,
  }
}

function toWakeRow(
  row: typeof developmentDeferredWakes.$inferSelect,
): DeferredWakeRow & { readonly id: string } {
  return {
    id: row.id,
    missionId: row.missionId,
    decisionId: row.decisionId,
    reason: row.reason,
    resumeAt: row.resumeAt,
    wakeSources: JSON.parse(row.wakeSourcesJson) as DeferredWakeRow['wakeSources'],
    attemptOrdinal: row.attemptOrdinal,
    state: row.state as DeferredWakeRow['state'],
  }
}

const EFFECT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  prepared: ['dispatched', 'invalidated'],
  dispatched: ['confirmed', 'invalidated', 'failed'],
  confirmed: [],
  invalidated: [],
  failed: [],
}

async function insertMissionRow(
  handle: ProviderNeutralDatabase,
  row: MissionRow,
): Promise<{ readonly created: boolean; readonly mission: MissionRow }> {
  const inserted = await handle
    .insert(developmentMissions)
    .values({ ...row, reopenedFromMissionId: row.reopenedFromMissionId ?? null })
    .onConflictDoNothing()
    .returning()
  if (inserted[0] !== undefined) return { created: true, mission: toMissionRow(inserted[0]) }
  if (row.launchIdempotencyKey === null) {
    throw new Error(`mission insert conflicted for non-idempotent id ${row.id}`)
  }
  const winner = (
    await handle
      .select()
      .from(developmentMissions)
      .where(eq(developmentMissions.launchIdempotencyKey, row.launchIdempotencyKey))
      .limit(1)
  )[0]
  if (winner === undefined) throw new Error('mission idempotency winner is unavailable')
  return { created: false, mission: toMissionRow(winner) }
}

async function insertFactSnapshotRow(
  handle: ProviderNeutralDatabase,
  input: MissionFactSnapshotWrite,
): Promise<void> {
  await handle.insert(developmentFactSnapshots).values({
    id: input.id,
    missionId: input.missionId,
    missionRevision: input.missionRevision,
    capturedAt: input.capturedAt,
    cellsJson: input.cellsJson,
    refsJson: input.refsJson,
    digest: input.digest,
    createdAt: input.now,
  })
}

async function insertDecisionRow(
  handle: ProviderNeutralDatabase,
  input: MissionDecisionWrite,
): Promise<MissionDecisionWriteReceipt> {
  const inserted = await handle
    .insert(developmentDecisions)
    .values({
      id: input.id,
      missionId: input.missionId,
      missionRevision: input.missionRevision,
      policyId: input.policyId,
      policyRevision: input.policyRevision,
      employeeId: input.employeeId,
      employeeRevision: input.employeeRevision,
      factSnapshotId: input.factSnapshotId,
      factDigest: input.factDigest,
      workSetJson: input.workSetJson,
      guardTraceJson: input.guardTraceJson,
      ruleTraceJson: input.ruleTraceJson,
      selectedJson: input.selectedJson,
      canonicalDigest: input.canonicalDigest,
      decisionInputDigest: input.decisionInputDigest,
      decidedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: developmentDecisions.id })
  if (inserted.length === 1) return { created: true, decisionId: input.id }
  const existing = (
    await handle
      .select({ id: developmentDecisions.id })
      .from(developmentDecisions)
      .where(
        and(
          eq(developmentDecisions.missionId, input.missionId),
          eq(developmentDecisions.decisionInputDigest, input.decisionInputDigest),
        ),
      )
      .limit(1)
  )[0]
  if (existing === undefined) throw new Error('decision idempotency winner is unavailable')
  return { created: false, decisionId: existing.id }
}

export function createMissionPersistence(db: ProviderNeutralDatabase): MissionPersistence {
  const session = databaseSessionFor(db)
  const engine = session.engine

  async function transitionEffect(
    id: string,
    to: EffectRow['state'],
    patch: Record<string, unknown>,
  ): Promise<void> {
    await session.transaction(async (tx: DatabaseTransaction) => {
      await engine.lockAggregateRoot(tx, developmentEffects, developmentEffects.id, id)
      const row = (
        await tx.select().from(developmentEffects).where(eq(developmentEffects.id, id)).limit(1)
      )[0]
      if (row === undefined) {
        throw new ValidationError('development-effect-not-found', `effect not found: ${id}`)
      }
      if (!EFFECT_TRANSITIONS[row.state]!.includes(to)) {
        throw new ValidationError(
          'development-effect-illegal-transition',
          `effect ${id}: ${row.state} → ${to} is not a legal transition`,
        )
      }
      await tx
        .update(developmentEffects)
        .set({ state: to, ...patch })
        .where(eq(developmentEffects.id, id))
    })
  }

  return {
    async commitMissionLaunch(input) {
      return await session.transaction(async (tx) => {
        const created = await insertMissionRow(tx, input.mission)
        if (!created.created) return created
        if (input.upload !== null) {
          await claimUploadSessions(tx, {
            missionId: input.mission.id,
            actorUserId: input.upload.actorUserId,
            uploadRefs: input.upload.uploadRefs,
            now: input.upload.now,
          })
          await insertUploadPlan(tx, input.upload.plan)
        }
        await tx.insert(developmentMissionSources).values(input.source)
        return created
      })
    },
    async createMission(row) {
      return await insertMissionRow(db, row)
    },
    async getMission(id) {
      const row = (
        await db.select().from(developmentMissions).where(eq(developmentMissions.id, id)).limit(1)
      )[0]
      return row === undefined ? null : toMissionRow(row)
    },
    async findByIdempotencyKey(key) {
      const row = (
        await db
          .select()
          .from(developmentMissions)
          .where(eq(developmentMissions.launchIdempotencyKey, key))
          .limit(1)
      )[0]
      return row === undefined ? null : toMissionRow(row)
    },
    async occUpdate(missionId, expectedRevision, expectedEpoch, patch): Promise<OccResult> {
      return await session.transaction(async (tx) => {
        const next = expectedRevision + 1
        const updated = await tx
          .update(developmentMissions)
          .set({ ...patch, revision: next, updatedAt: Date.now() })
          .where(
            and(
              eq(developmentMissions.id, missionId),
              eq(developmentMissions.revision, expectedRevision),
              eq(developmentMissions.epoch, expectedEpoch),
            ),
          )
          .returning({ id: developmentMissions.id })
        if (updated.length === 1) return { ok: true, revision: next }
        const current = (
          await tx
            .select({ revision: developmentMissions.revision, epoch: developmentMissions.epoch })
            .from(developmentMissions)
            .where(eq(developmentMissions.id, missionId))
            .limit(1)
        )[0]
        if (current === undefined) return { ok: false, code: 'not-found' }
        return current.epoch !== expectedEpoch
          ? { ok: false, code: 'epoch-conflict' }
          : { ok: false, code: 'revision-conflict' }
      })
    },
    async bumpEpoch(missionId, expectedRevision, patch): Promise<OccResult> {
      return await session.transaction(async (tx) => {
        const row = (
          await tx
            .select()
            .from(developmentMissions)
            .where(eq(developmentMissions.id, missionId))
            .limit(1)
        )[0]
        if (row === undefined) return { ok: false, code: 'not-found' }
        if (row.revision !== expectedRevision) return { ok: false, code: 'revision-conflict' }
        const next = expectedRevision + 1
        const updated = await tx
          .update(developmentMissions)
          .set({ ...patch, revision: next, epoch: row.epoch + 1, updatedAt: Date.now() })
          .where(
            and(
              eq(developmentMissions.id, missionId),
              eq(developmentMissions.revision, expectedRevision),
            ),
          )
          .returning({ id: developmentMissions.id })
        return updated.length === 1
          ? { ok: true, revision: next }
          : { ok: false, code: 'revision-conflict' }
      })
    },

    async insertMissionSource(row) {
      await db.insert(developmentMissionSources).values(row)
    },
    async listMissionSources(missionId) {
      return (
        await db
          .select()
          .from(developmentMissionSources)
          .where(eq(developmentMissionSources.missionId, missionId))
      ).map(toMissionSourceRow)
    },

    async claimMr(input) {
      const inserted = await db
        .insert(developmentMrClaims)
        .values({
          id: input.id,
          codeHostEndpointRef: input.codeHostEndpointRef,
          stableProjectRef: input.stableProjectRef,
          mrIid: input.mrIid,
          missionId: input.missionId,
          epoch: input.epoch,
          headSha: input.headSha,
          state: 'active',
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentMrClaims.id })
      return inserted.length === 1
        ? { ok: true }
        : { ok: false, code: 'mr-owned-by-another-mission' }
    },
    async releaseMr(claimId, now) {
      await db
        .update(developmentMrClaims)
        .set({ state: 'released', releasedAt: now })
        .where(eq(developmentMrClaims.id, claimId))
    },
    async getMrClaim(claimId) {
      const row = (
        await db
          .select({
            id: developmentMrClaims.id,
            codeHostEndpointRef: developmentMrClaims.codeHostEndpointRef,
            stableProjectRef: developmentMrClaims.stableProjectRef,
            mrIid: developmentMrClaims.mrIid,
            missionId: developmentMrClaims.missionId,
            state: developmentMrClaims.state,
          })
          .from(developmentMrClaims)
          .where(eq(developmentMrClaims.id, claimId))
          .limit(1)
      )[0]
      return row ?? null
    },
    async findMrClaim(input) {
      // 同一条 MR 可以有多行：唯一索引只约束 `state='active'`，released 的历史会累积——T81 的 reopen 链更是
      // **每重开一次就多一行**。所以这里必须显式定序：active 优先，同态取最新。不定序时返回哪一行是未定义的，
      // 而这个读面的调用方（webhook 反查、claim 撞车消歧）恰恰只关心「现在归谁」。
      const row = (
        await db
          .select({
            id: developmentMrClaims.id,
            missionId: developmentMrClaims.missionId,
            state: developmentMrClaims.state,
          })
          .from(developmentMrClaims)
          .where(
            and(
              eq(developmentMrClaims.codeHostEndpointRef, input.codeHostEndpointRef),
              eq(developmentMrClaims.stableProjectRef, input.stableProjectRef),
              eq(developmentMrClaims.mrIid, input.mrIid),
            ),
          )
          .orderBy(
            sql`case when ${developmentMrClaims.state} = 'active' then 0 else 1 end`,
            desc(developmentMrClaims.createdAt),
            desc(developmentMrClaims.id),
          )
          .limit(1)
      )[0]
      return row ?? null
    },

    async recordWakeHint(input) {
      const inserted = await db
        .insert(developmentWakeHints)
        .values({
          id: input.id,
          missionId: input.missionId,
          source: input.source,
          deliveryKey: input.deliveryKey,
          observedAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentWakeHints.id })
      return { accepted: inserted.length === 1 }
    },
    async consumeWakeHints(missionId, now) {
      return await session.transaction(async (tx) => {
        const open = await tx
          .select({ id: developmentWakeHints.id })
          .from(developmentWakeHints)
          .where(
            and(
              eq(developmentWakeHints.missionId, missionId),
              isNull(developmentWakeHints.consumedAt),
            ),
          )
        if (open.length > 0) {
          await tx
            .update(developmentWakeHints)
            .set({ consumedAt: now })
            .where(
              inArray(
                developmentWakeHints.id,
                open.map((hint) => hint.id),
              ),
            )
        }
        return open.length
      })
    },

    async upsertFeedbackObservation(input) {
      const inserted = await db
        .insert(developmentFeedbackLedger)
        .values({
          id: input.id,
          missionId: input.missionId,
          threadRef: input.threadRef,
          revision: input.revision,
          headSha: input.headSha,
          fingerprint: input.fingerprint,
          authorClass: input.authorClass,
          state: 'observed',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentFeedbackLedger.id })
      return { created: inserted.length === 1 }
    },
    async listFeedback(missionId) {
      return (await db
        .select()
        .from(developmentFeedbackLedger)
        .where(eq(developmentFeedbackLedger.missionId, missionId))
        .orderBy(
          asc(developmentFeedbackLedger.createdAt),
          asc(developmentFeedbackLedger.id),
        )) as FeedbackLedgerRow[]
    },
    async setFeedbackState(input) {
      await db
        .update(developmentFeedbackLedger)
        .set({
          state: input.state,
          updatedAt: input.now,
          ...(input.actionRunId === undefined ? {} : { actionRunId: input.actionRunId }),
          ...(input.replyEffectId === undefined ? {} : { replyEffectId: input.replyEffectId }),
        })
        .where(eq(developmentFeedbackLedger.id, input.id))
    },
    async obsoleteFeedbackForOtherHeads(missionId, currentHeadSha, now) {
      const stale = await db
        .update(developmentFeedbackLedger)
        .set({ state: 'obsolete', updatedAt: now })
        .where(
          and(
            eq(developmentFeedbackLedger.missionId, missionId),
            ne(developmentFeedbackLedger.headSha, currentHeadSha),
            inArray(developmentFeedbackLedger.state, ['observed', 'selected']),
          ),
        )
        .returning({ id: developmentFeedbackLedger.id })
      return stale.length
    },

    async armWake(input) {
      await db.insert(developmentDeferredWakes).values({
        id: input.id,
        missionId: input.missionId,
        decisionId: input.decisionId,
        reason: input.reason,
        resumeAt: input.resumeAt,
        wakeSourcesJson: JSON.stringify(input.wakeSources),
        attemptOrdinal: input.attemptOrdinal,
        state: 'armed',
        createdAt: input.now,
      })
    },
    async getWake(missionId, decisionId) {
      const row = (
        await db
          .select()
          .from(developmentDeferredWakes)
          .where(
            and(
              eq(developmentDeferredWakes.missionId, missionId),
              eq(developmentDeferredWakes.decisionId, decisionId),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : toWakeRow(row)
    },
    async fireWake(id, _now) {
      const updated = await db
        .update(developmentDeferredWakes)
        .set({ state: 'fired' })
        .where(
          and(eq(developmentDeferredWakes.id, id), eq(developmentDeferredWakes.state, 'armed')),
        )
        .returning({ id: developmentDeferredWakes.id })
      return updated.length === 1
    },
    async settleWake(id, now) {
      await db
        .update(developmentDeferredWakes)
        .set({ state: 'settled', settledAt: now })
        .where(eq(developmentDeferredWakes.id, id))
    },
    async listDueWakes(now) {
      return (
        await db
          .select()
          .from(developmentDeferredWakes)
          .where(
            and(
              eq(developmentDeferredWakes.state, 'armed'),
              // resumeAt NULL 的行只有外部 wake source 能唤，永远不因时间 due。
              lte(developmentDeferredWakes.resumeAt, now),
            ),
          )
          .orderBy(asc(developmentDeferredWakes.resumeAt))
      ).map(toWakeRow)
    },

    async insertFactSnapshot(input) {
      await insertFactSnapshotRow(db, input)
    },
    async insertDecision(input) {
      return await insertDecisionRow(db, input)
    },

    async createActionRun(input) {
      const inserted = await db
        .insert(developmentActionRuns)
        .values({
          id: input.id,
          missionId: input.missionId,
          missionRevision: input.missionRevision,
          decisionId: input.decisionId,
          capabilityId: input.capabilityId,
          capabilityContractVersion: input.capabilityContractVersion,
          templateId: input.templateId,
          templateRevision: input.templateRevision,
          workSetDigest: input.workSetDigest,
          inputFactDigest: input.inputFactDigest,
          baselineRef: input.baselineRef,
          writable: input.writable ? 1 : 0,
          status: 'claimed',
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentActionRuns.id })
      return inserted.length === 1
        ? { ok: true }
        : { ok: false, code: 'writable-action-already-active' }
    },
    async settleActionRun(input) {
      await db
        .update(developmentActionRuns)
        .set({
          status: input.status,
          resultRef: input.resultRef,
          failureJson: input.failureJson,
          settledAt: input.now,
        })
        .where(eq(developmentActionRuns.id, input.id))
    },
    async countActionRuns(missionId, capabilityId) {
      return (
        await db
          .select({ id: developmentActionRuns.id })
          .from(developmentActionRuns)
          .where(
            and(
              eq(developmentActionRuns.missionId, missionId),
              eq(developmentActionRuns.capabilityId, capabilityId),
            ),
          )
      ).length
    },
    async getActionRun(id) {
      const row = (
        await db
          .select()
          .from(developmentActionRuns)
          .where(eq(developmentActionRuns.id, id))
          .limit(1)
      )[0]
      if (row === undefined) return null
      return {
        id: row.id,
        missionId: row.missionId,
        decisionId: row.decisionId,
        capabilityId: row.capabilityId,
        writable: row.writable === 1,
        status: row.status,
        resultRef: row.resultRef,
        failureJson: row.failureJson,
      } satisfies ActionRunRow
    },

    async claimAttempt(input) {
      const inserted = await db
        .insert(developmentAgentAttempts)
        .values({
          id: input.id,
          actionRunId: input.actionRunId,
          rerunSeq: input.rerunSeq,
          attemptSeq: input.attemptSeq,
          executionRef: input.executionRef,
          baselineRef: input.baselineRef,
          nonceDigest: input.nonceDigest,
          inputDigest: input.inputDigest,
          preSnapshotRef: input.preSnapshotRef ?? null,
          status: 'claimed',
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentAgentAttempts.id })
      return inserted.length === 1 ? { ok: true } : { ok: false, code: 'attempt-ordinal-taken' }
    },
    async settleAttempt(input) {
      await db
        .update(developmentAgentAttempts)
        .set({
          status: input.status,
          rejectionJson: input.rejectionJson,
          outcomeRef: input.outcomeRef,
          settledAt: input.now,
        })
        .where(eq(developmentAgentAttempts.id, input.id))
    },
    async listAttempts(actionRunId) {
      return (
        await db
          .select()
          .from(developmentAgentAttempts)
          .where(eq(developmentAgentAttempts.actionRunId, actionRunId))
          .orderBy(asc(developmentAgentAttempts.rerunSeq), asc(developmentAgentAttempts.attemptSeq))
      ).map((row) => ({
        id: row.id,
        actionRunId: row.actionRunId,
        rerunSeq: row.rerunSeq,
        attemptSeq: row.attemptSeq,
        executionRef: row.executionRef,
        baselineRef: row.baselineRef,
        nonceDigest: row.nonceDigest,
        inputDigest: row.inputDigest,
        status: row.status,
        rejectionJson: row.rejectionJson,
        outcomeRef: row.outcomeRef,
        preSnapshotRef: row.preSnapshotRef,
      }))
    },

    async prepareEffect(input) {
      const inserted = await db
        .insert(developmentEffects)
        .values({
          id: input.id,
          missionId: input.missionId,
          actionRunId: input.actionRunId,
          effectKind: input.effectKind,
          intentDigest: input.intentDigest,
          idempotencyKey: input.idempotencyKey,
          epoch: input.epoch,
          state: 'prepared',
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning()
      if (inserted[0] !== undefined) return { created: true, effect: toEffectRow(inserted[0]) }
      const existing = (
        await db
          .select()
          .from(developmentEffects)
          .where(eq(developmentEffects.idempotencyKey, input.idempotencyKey))
          .limit(1)
      )[0]
      if (existing === undefined) throw new Error('effect idempotency winner is unavailable')
      return { created: false, effect: toEffectRow(existing) }
    },
    async markEffectDispatched(id, _now) {
      await transitionEffect(id, 'dispatched', {})
    },
    async confirmEffect(id, receiptRef, now) {
      await transitionEffect(id, 'confirmed', { receiptRef, settledAt: now })
    },
    async invalidateEffect(id, now) {
      await transitionEffect(id, 'invalidated', { settledAt: now })
    },
    async failEffect(id, failureJson, now) {
      await transitionEffect(id, 'failed', { failureJson, settledAt: now })
    },
    async getEffect(id) {
      const row = (
        await db.select().from(developmentEffects).where(eq(developmentEffects.id, id)).limit(1)
      )[0]
      return row === undefined ? null : toEffectRow(row)
    },
    async listUnsettledEffects(missionId) {
      return (
        await db
          .select()
          .from(developmentEffects)
          .where(
            and(
              eq(developmentEffects.missionId, missionId),
              or(
                eq(developmentEffects.state, 'prepared'),
                eq(developmentEffects.state, 'dispatched'),
              ),
            ),
          )
      ).map(toEffectRow)
    },
    async listPreparedEffects() {
      return (
        await db
          .select()
          .from(developmentEffects)
          .where(eq(developmentEffects.state, 'prepared'))
          .orderBy(asc(developmentEffects.createdAt))
      ).map(toEffectRow)
    },

    async commitFactSnapshotAndDecision(input) {
      return await session.transaction(async (tx) => {
        await insertFactSnapshotRow(tx, input.snapshot)
        return await insertDecisionRow(tx, input.decision)
      })
    },
  }
}
