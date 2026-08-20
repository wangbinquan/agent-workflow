// RFC-310 PR-2 —— MissionStore 的 bun-sqlite/drizzle 实现。
//
// 全部同步（.get()/.all()/.run()），写路径的原子性来自两层：bun:sqlite 同一
// 连接上的同步执行（JS 层无真并发交错）+ `db.transaction` 包住的
// select→检查→update 序列；不变量的最终兜底是 0177 的唯一/部分唯一索引——
// 进程内检查只负责把索引冲突翻译成 typed 结果。

import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
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
import { ValidationError } from '@/util/errors'
import type { DeferredWakeRow } from '../domain/deferredWake'
import type {
  ActionRunRow,
  EffectRow,
  FeedbackLedgerRow,
  MissionRow,
  MissionSourceRow,
  MissionStore,
  OccResult,
} from '../application/ports/missionStore'

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed')
}

type MissionDbRow = typeof developmentMissions.$inferSelect

function toMissionRow(row: MissionDbRow): MissionRow {
  return row as unknown as MissionRow
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

export function createSqliteMissionStore(db: DbClient): MissionStore {
  function transitionEffect(
    id: string,
    to: EffectRow['state'],
    patch: Record<string, unknown>,
  ): void {
    db.transaction(() => {
      const row = db.select().from(developmentEffects).where(eq(developmentEffects.id, id)).get()
      if (row === undefined) {
        throw new ValidationError('development-effect-not-found', `effect not found: ${id}`)
      }
      if (!EFFECT_TRANSITIONS[row.state]!.includes(to)) {
        throw new ValidationError(
          'development-effect-illegal-transition',
          `effect ${id}: ${row.state} → ${to} is not a legal transition`,
        )
      }
      db.update(developmentEffects)
        .set({ state: to, ...patch })
        .where(eq(developmentEffects.id, id))
        .run()
    })
  }

  return {
    createMission(row) {
      try {
        db.insert(developmentMissions)
          .values(row as unknown as typeof developmentMissions.$inferInsert)
          .run()
        return { created: true, mission: row }
      } catch (error) {
        if (isUniqueViolation(error) && row.launchIdempotencyKey !== null) {
          const existing = this.findByIdempotencyKey(row.launchIdempotencyKey)
          if (existing !== null) return { created: false, mission: existing }
        }
        throw error
      }
    },
    getMission(id) {
      const row = db.select().from(developmentMissions).where(eq(developmentMissions.id, id)).get()
      return row === undefined ? null : toMissionRow(row)
    },
    findByIdempotencyKey(key) {
      const row = db
        .select()
        .from(developmentMissions)
        .where(eq(developmentMissions.launchIdempotencyKey, key))
        .get()
      return row === undefined ? null : toMissionRow(row)
    },
    occUpdate(missionId, expectedRevision, expectedEpoch, patch): OccResult {
      return db.transaction(() => {
        const row = db
          .select()
          .from(developmentMissions)
          .where(eq(developmentMissions.id, missionId))
          .get()
        if (row === undefined) return { ok: false, code: 'not-found' }
        if (row.epoch !== expectedEpoch) return { ok: false, code: 'epoch-conflict' }
        if (row.revision !== expectedRevision) return { ok: false, code: 'revision-conflict' }
        const next = expectedRevision + 1
        db.update(developmentMissions)
          .set({ ...(patch as Record<string, unknown>), revision: next, updatedAt: Date.now() })
          .where(
            and(
              eq(developmentMissions.id, missionId),
              eq(developmentMissions.revision, expectedRevision),
            ),
          )
          .run()
        return { ok: true, revision: next }
      })
    },
    bumpEpoch(missionId, expectedRevision, patch): OccResult {
      return db.transaction(() => {
        const row = db
          .select()
          .from(developmentMissions)
          .where(eq(developmentMissions.id, missionId))
          .get()
        if (row === undefined) return { ok: false, code: 'not-found' }
        if (row.revision !== expectedRevision) return { ok: false, code: 'revision-conflict' }
        const next = expectedRevision + 1
        db.update(developmentMissions)
          .set({
            ...(patch as Record<string, unknown>),
            revision: next,
            epoch: row.epoch + 1,
            updatedAt: Date.now(),
          })
          .where(eq(developmentMissions.id, missionId))
          .run()
        return { ok: true, revision: next }
      })
    },

    insertMissionSource(row) {
      db.insert(developmentMissionSources)
        .values(row as unknown as typeof developmentMissionSources.$inferInsert)
        .run()
    },
    listMissionSources(missionId) {
      return db
        .select()
        .from(developmentMissionSources)
        .where(eq(developmentMissionSources.missionId, missionId))
        .all()
        .map((r) => r as unknown as MissionSourceRow)
    },

    claimMr(input) {
      try {
        db.insert(developmentMrClaims)
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
          .run()
        return { ok: true }
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, code: 'mr-owned-by-another-mission' }
        throw error
      }
    },
    releaseMr(claimId, now) {
      db.update(developmentMrClaims)
        .set({ state: 'released', releasedAt: now })
        .where(eq(developmentMrClaims.id, claimId))
        .run()
    },
    getMrClaim(claimId) {
      const row = db
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
        .get()
      return row ?? null
    },
    findMrClaim(input) {
      const row = db
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
        .get()
      return row ?? null
    },

    recordWakeHint(input) {
      try {
        db.insert(developmentWakeHints)
          .values({
            id: input.id,
            missionId: input.missionId,
            source: input.source,
            deliveryKey: input.deliveryKey,
            observedAt: input.now,
          })
          .run()
        return { accepted: true }
      } catch (error) {
        if (isUniqueViolation(error)) return { accepted: false }
        throw error
      }
    },
    consumeWakeHints(missionId, now) {
      return db.transaction(() => {
        const open = db
          .select()
          .from(developmentWakeHints)
          .where(
            and(
              eq(developmentWakeHints.missionId, missionId),
              isNull(developmentWakeHints.consumedAt),
            ),
          )
          .all()
        for (const hint of open) {
          db.update(developmentWakeHints)
            .set({ consumedAt: now })
            .where(eq(developmentWakeHints.id, hint.id))
            .run()
        }
        return open.length
      })
    },

    upsertFeedbackObservation(input) {
      try {
        db.insert(developmentFeedbackLedger)
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
          .run()
        return { created: true }
      } catch (error) {
        if (isUniqueViolation(error)) return { created: false }
        throw error
      }
    },
    listFeedback(missionId) {
      return db
        .select()
        .from(developmentFeedbackLedger)
        .where(eq(developmentFeedbackLedger.missionId, missionId))
        .orderBy(asc(developmentFeedbackLedger.createdAt), asc(developmentFeedbackLedger.id))
        .all() as FeedbackLedgerRow[]
    },
    setFeedbackState(input) {
      db.update(developmentFeedbackLedger)
        .set({
          state: input.state,
          updatedAt: input.now,
          ...(input.actionRunId === undefined ? {} : { actionRunId: input.actionRunId }),
          ...(input.replyEffectId === undefined ? {} : { replyEffectId: input.replyEffectId }),
        })
        .where(eq(developmentFeedbackLedger.id, input.id))
        .run()
    },
    obsoleteFeedbackForOtherHeads(missionId, currentHeadSha, now) {
      return db.transaction(() => {
        const stale = db
          .select({ id: developmentFeedbackLedger.id })
          .from(developmentFeedbackLedger)
          .where(
            and(
              eq(developmentFeedbackLedger.missionId, missionId),
              ne(developmentFeedbackLedger.headSha, currentHeadSha),
              inArray(developmentFeedbackLedger.state, ['observed', 'selected']),
            ),
          )
          .all()
        for (const row of stale) {
          db.update(developmentFeedbackLedger)
            .set({ state: 'obsolete', updatedAt: now })
            .where(eq(developmentFeedbackLedger.id, row.id))
            .run()
        }
        return stale.length
      })
    },

    armWake(input) {
      db.insert(developmentDeferredWakes)
        .values({
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
        .run()
    },
    getWake(missionId, decisionId) {
      const row = db
        .select()
        .from(developmentDeferredWakes)
        .where(
          and(
            eq(developmentDeferredWakes.missionId, missionId),
            eq(developmentDeferredWakes.decisionId, decisionId),
          ),
        )
        .get()
      return row === undefined ? null : toWakeRow(row)
    },
    fireWake(id, _now) {
      return db.transaction(() => {
        const row = db
          .select()
          .from(developmentDeferredWakes)
          .where(eq(developmentDeferredWakes.id, id))
          .get()
        if (row === undefined || row.state !== 'armed') return false
        db.update(developmentDeferredWakes)
          .set({ state: 'fired' })
          .where(eq(developmentDeferredWakes.id, id))
          .run()
        return true
      })
    },
    settleWake(id, now) {
      db.update(developmentDeferredWakes)
        .set({ state: 'settled', settledAt: now })
        .where(eq(developmentDeferredWakes.id, id))
        .run()
    },
    listDueWakes(now) {
      return db
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
        .all()
        .map(toWakeRow)
    },

    insertFactSnapshot(input) {
      db.insert(developmentFactSnapshots)
        .values({
          id: input.id,
          missionId: input.missionId,
          missionRevision: input.missionRevision,
          capturedAt: input.capturedAt,
          cellsJson: input.cellsJson,
          refsJson: input.refsJson,
          digest: input.digest,
          createdAt: input.now,
        })
        .run()
    },

    insertDecision(input) {
      try {
        db.insert(developmentDecisions)
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
          .run()
        return { created: true, decisionId: input.id }
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = db
            .select()
            .from(developmentDecisions)
            .where(
              and(
                eq(developmentDecisions.missionId, input.missionId),
                eq(developmentDecisions.decisionInputDigest, input.decisionInputDigest),
              ),
            )
            .get()
          if (existing !== undefined) return { created: false, decisionId: existing.id }
        }
        throw error
      }
    },

    createActionRun(input) {
      try {
        db.insert(developmentActionRuns)
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
          .run()
        return { ok: true }
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, code: 'writable-action-already-active' }
        throw error
      }
    },
    settleActionRun(input) {
      db.update(developmentActionRuns)
        .set({
          status: input.status,
          resultRef: input.resultRef,
          failureJson: input.failureJson,
          settledAt: input.now,
        })
        .where(eq(developmentActionRuns.id, input.id))
        .run()
    },
    countActionRuns(missionId, capabilityId) {
      return db
        .select()
        .from(developmentActionRuns)
        .where(
          and(
            eq(developmentActionRuns.missionId, missionId),
            eq(developmentActionRuns.capabilityId, capabilityId),
          ),
        )
        .all().length
    },
    getActionRun(id) {
      const row = db
        .select()
        .from(developmentActionRuns)
        .where(eq(developmentActionRuns.id, id))
        .get()
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

    claimAttempt(input) {
      try {
        db.insert(developmentAgentAttempts)
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
          .run()
        return { ok: true }
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false, code: 'attempt-ordinal-taken' }
        throw error
      }
    },
    settleAttempt(input) {
      db.update(developmentAgentAttempts)
        .set({
          status: input.status,
          rejectionJson: input.rejectionJson,
          outcomeRef: input.outcomeRef,
          settledAt: input.now,
        })
        .where(eq(developmentAgentAttempts.id, input.id))
        .run()
    },
    listAttempts(actionRunId) {
      return db
        .select()
        .from(developmentAgentAttempts)
        .where(eq(developmentAgentAttempts.actionRunId, actionRunId))
        .orderBy(asc(developmentAgentAttempts.rerunSeq), asc(developmentAgentAttempts.attemptSeq))
        .all()
        .map((row) => ({
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

    prepareEffect(input) {
      try {
        db.insert(developmentEffects)
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
          .run()
        const row = db
          .select()
          .from(developmentEffects)
          .where(eq(developmentEffects.id, input.id))
          .get()
        return { created: true, effect: toEffectRow(row!) }
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = db
            .select()
            .from(developmentEffects)
            .where(eq(developmentEffects.idempotencyKey, input.idempotencyKey))
            .get()
          if (existing !== undefined) return { created: false, effect: toEffectRow(existing) }
        }
        throw error
      }
    },
    markEffectDispatched(id, _now) {
      transitionEffect(id, 'dispatched', {})
    },
    confirmEffect(id, receiptRef, now) {
      transitionEffect(id, 'confirmed', { receiptRef, settledAt: now })
    },
    invalidateEffect(id, now) {
      transitionEffect(id, 'invalidated', { settledAt: now })
    },
    failEffect(id, failureJson, now) {
      transitionEffect(id, 'failed', { failureJson, settledAt: now })
    },
    getEffect(id) {
      const row = db.select().from(developmentEffects).where(eq(developmentEffects.id, id)).get()
      return row === undefined ? null : toEffectRow(row)
    },
    listUnsettledEffects(missionId) {
      return db
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
        .all()
        .map(toEffectRow)
    },
    listPreparedEffects() {
      return db
        .select()
        .from(developmentEffects)
        .where(eq(developmentEffects.state, 'prepared'))
        .orderBy(asc(developmentEffects.createdAt))
        .all()
        .map(toEffectRow)
    },

    inTx(fn) {
      return db.transaction(() => fn())
    },
  }
}
