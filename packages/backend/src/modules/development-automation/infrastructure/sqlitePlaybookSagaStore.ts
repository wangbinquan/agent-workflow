import { and, asc, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentStepJoins,
  developmentStepRuns,
} from '@/db/schema'
import type {
  ApprovalSagaRow,
  MissionLinkRow,
  PlaybookSagaPersistence,
  PlaybookSagaStore,
  StepJoinRow,
  StepRunRow,
} from '../application/ports/playbookSagaStore'
import { canonicalDigest } from '../domain/canonicalJson'
import { canTransitionStepRun, stepRunStateSchema } from '../domain/stepSaga'

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/.test(error.message)
  )
}

function step(row: typeof developmentStepRuns.$inferSelect): StepRunRow {
  return {
    ...row,
    state: stepRunStateSchema.parse(row.state),
  }
}

function link(row: typeof developmentMissionLinks.$inferSelect): MissionLinkRow {
  return {
    ...row,
    completion: row.completion as MissionLinkRow['completion'],
    completionSatisfied: row.completionSatisfied === 1,
  }
}

function approval(row: typeof developmentApprovalSagas.$inferSelect): ApprovalSagaRow {
  return {
    ...row,
    latestStatus: row.latestStatus as ApprovalSagaRow['latestStatus'],
  }
}

function join(row: typeof developmentStepJoins.$inferSelect): StepJoinRow {
  return {
    ...row,
    mode: row.mode as StepJoinRow['mode'],
    memberState: row.memberState as StepJoinRow['memberState'],
  }
}

export function createSqlitePlaybookSagaStore(db: DbClient): PlaybookSagaStore {
  return {
    claimStepRun(input) {
      try {
        db.insert(developmentStepRuns)
          .values({
            id: input.id,
            missionId: input.missionId,
            employeeId: input.employeeId,
            employeeRevision: input.employeeRevision,
            stepId: input.stepId,
            attempt: input.attempt,
            inputDigest: input.inputDigest,
            producerKind: input.producerKind,
            state: 'claimed',
            deadlineAt: input.deadlineAt,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        return {
          created: true,
          row: step(
            db
              .select()
              .from(developmentStepRuns)
              .where(eq(developmentStepRuns.id, input.id))
              .get()!,
          ),
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const existing = db
          .select()
          .from(developmentStepRuns)
          .where(
            and(
              eq(developmentStepRuns.missionId, input.missionId),
              eq(developmentStepRuns.employeeId, input.employeeId),
              eq(developmentStepRuns.employeeRevision, input.employeeRevision),
              eq(developmentStepRuns.stepId, input.stepId),
              eq(developmentStepRuns.attempt, input.attempt),
              eq(developmentStepRuns.inputDigest, input.inputDigest),
            ),
          )
          .get()
        if (existing === undefined) throw error
        return { created: false, row: step(existing) }
      }
    },
    getStepRun(id) {
      const row = db.select().from(developmentStepRuns).where(eq(developmentStepRuns.id, id)).get()
      return row === undefined ? null : step(row)
    },
    listStepRuns(missionId) {
      return db
        .select()
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.missionId, missionId))
        .orderBy(asc(developmentStepRuns.createdAt), asc(developmentStepRuns.id))
        .all()
        .map(step)
    },
    findStepRunByAction(actionRunId) {
      const row = db
        .select()
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.actionRunId, actionRunId))
        .get()
      return row === undefined ? null : step(row)
    },
    updateStepRun(input) {
      const current = db
        .select()
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.id, input.id))
        .get()
      if (current === undefined) return false
      const from = stepRunStateSchema.parse(current.state)
      if (!input.from.includes(from) || !canTransitionStepRun(from, input.state)) return false
      const terminal = input.state === 'succeeded' || input.state === 'failed'
      const result = db
        .update(developmentStepRuns)
        .set({
          state: input.state,
          ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
          ...(input.actionRunId === undefined ? {} : { actionRunId: input.actionRunId }),
          ...(input.outputRef === undefined ? {} : { outputRef: input.outputRef }),
          ...(input.outputRevision === undefined ? {} : { outputRevision: input.outputRevision }),
          ...(input.failureCategory === undefined
            ? {}
            : { failureCategory: input.failureCategory }),
          ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
          updatedAt: input.now,
          ...(terminal ? { settledAt: input.now } : {}),
        })
        .where(and(eq(developmentStepRuns.id, input.id), eq(developmentStepRuns.state, from)))
        .run()
      return (result as unknown as { changes?: number }).changes === 1
    },

    claimMissionLink(input) {
      try {
        db.insert(developmentMissionLinks)
          .values({
            id: input.id,
            parentMissionId: input.parentMissionId,
            parentStepRunId: input.parentStepRunId,
            targetRepositoryId: input.targetRepositoryId,
            targetEmployeeId: input.targetEmployeeId,
            targetEmployeeRevision: input.targetEmployeeRevision,
            inputDigest: input.inputDigest,
            idempotencyKey: input.idempotencyKey,
            completion: input.completion,
            state: 'creating',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        return {
          created: true,
          row: link(
            db
              .select()
              .from(developmentMissionLinks)
              .where(eq(developmentMissionLinks.id, input.id))
              .get()!,
          ),
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const existing = db
          .select()
          .from(developmentMissionLinks)
          .where(eq(developmentMissionLinks.idempotencyKey, input.idempotencyKey))
          .get()
        if (existing === undefined) throw error
        return { created: false, row: link(existing) }
      }
    },
    getMissionLinkByStepRun(stepRunId) {
      const row = db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.parentStepRunId, stepRunId))
        .get()
      return row === undefined ? null : link(row)
    },
    findParentMissionLink(childMissionId) {
      const row = db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.childMissionId, childMissionId))
        .get()
      return row === undefined ? null : link(row)
    },
    listMissionLinks(missionId) {
      return db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.parentMissionId, missionId))
        .orderBy(asc(developmentMissionLinks.createdAt), asc(developmentMissionLinks.id))
        .all()
        .map(link)
    },
    observeMissionLink(input) {
      db.update(developmentMissionLinks)
        .set({
          childMissionId: input.childMissionId,
          latestChildRevision: input.childRevision,
          latestStatus: input.status,
          completionSatisfied: input.completionSatisfied ? 1 : 0,
          outputRef: input.outputRef,
          state: input.completionSatisfied ? 'satisfied' : 'observing',
          observedAt: input.observedAt,
          updatedAt: input.observedAt,
        })
        .where(eq(developmentMissionLinks.id, input.id))
        .run()
    },

    claimApprovalSaga(input) {
      try {
        db.insert(developmentApprovalSagas)
          .values({
            id: input.id,
            missionId: input.missionId,
            stepRunId: input.stepRunId,
            adapterId: input.adapterId,
            adapterRevision: input.adapterRevision,
            draftRef: input.draftRef,
            submitIntentDigest: input.submitIntentDigest,
            idempotencyKey: input.idempotencyKey,
            deadlineAt: input.deadlineAt,
            latestStatus: 'submitting',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        return {
          created: true,
          row: approval(
            db
              .select()
              .from(developmentApprovalSagas)
              .where(eq(developmentApprovalSagas.id, input.id))
              .get()!,
          ),
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const existing = db
          .select()
          .from(developmentApprovalSagas)
          .where(eq(developmentApprovalSagas.idempotencyKey, input.idempotencyKey))
          .get()
        if (existing === undefined) throw error
        return { created: false, row: approval(existing) }
      }
    },
    getApprovalSaga(id) {
      const row = db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.id, id))
        .get()
      return row === undefined ? null : approval(row)
    },
    getApprovalSagaByStepRun(stepRunId) {
      const row = db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.stepRunId, stepRunId))
        .get()
      return row === undefined ? null : approval(row)
    },
    listApprovalSagas(missionId) {
      return db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.missionId, missionId))
        .orderBy(asc(developmentApprovalSagas.createdAt), asc(developmentApprovalSagas.id))
        .all()
        .map(approval)
    },
    recordApprovalSubmitted(input) {
      db.update(developmentApprovalSagas)
        .set({
          correlationRef: input.correlationRef,
          externalRequestRef: input.externalRequestRef,
          submittedRevision: input.submittedRevision,
          latestStatus: 'pending',
          updatedAt: input.now,
        })
        .where(eq(developmentApprovalSagas.id, input.id))
        .run()
    },
    recordApprovalObservation(input) {
      const settled = ['approved', 'rejected', 'expired', 'unavailable'].includes(input.status)
      db.update(developmentApprovalSagas)
        .set({
          latestStatus: input.status,
          observedRevision: input.observedRevision,
          evidenceRef: input.evidenceRef,
          nextObserveAt: input.nextObserveAt,
          attemptOrdinal: sql`${developmentApprovalSagas.attemptOrdinal} + 1`,
          updatedAt: input.now,
          ...(settled ? { settledAt: input.now } : {}),
        })
        .where(eq(developmentApprovalSagas.id, input.id))
        .run()
    },

    upsertJoinMember(input) {
      db.insert(developmentStepJoins)
        .values({
          missionId: input.missionId,
          groupId: input.groupId,
          memberStepId: input.memberStepId,
          mode: input.mode,
          quorum: input.quorum,
          deadlineAt: input.deadlineAt,
          memberState: input.memberState,
          receiptRevision: input.receiptRevision,
          settledResult: input.settledResult,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            developmentStepJoins.missionId,
            developmentStepJoins.groupId,
            developmentStepJoins.memberStepId,
          ],
          set: {
            memberState: input.memberState,
            receiptRevision: input.receiptRevision,
            settledResult: input.settledResult,
            updatedAt: input.now,
          },
        })
        .run()
    },
    listJoinMembers(missionId, groupId) {
      return db
        .select()
        .from(developmentStepJoins)
        .where(
          and(
            eq(developmentStepJoins.missionId, missionId),
            eq(developmentStepJoins.groupId, groupId),
          ),
        )
        .orderBy(asc(developmentStepJoins.memberStepId))
        .all()
        .map(join)
    },
    settleJoin(missionId, groupId, result, now) {
      db.update(developmentStepJoins)
        .set({ settledResult: result, updatedAt: now })
        .where(
          and(
            eq(developmentStepJoins.missionId, missionId),
            eq(developmentStepJoins.groupId, groupId),
          ),
        )
        .run()
    },
    sagaDigest(missionId) {
      const steps = db
        .select({
          id: developmentStepRuns.id,
          stepId: developmentStepRuns.stepId,
          attempt: developmentStepRuns.attempt,
          state: developmentStepRuns.state,
          outputRevision: developmentStepRuns.outputRevision,
          failureCode: developmentStepRuns.failureCode,
        })
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.missionId, missionId))
        .orderBy(asc(developmentStepRuns.createdAt), asc(developmentStepRuns.id))
        .all()
      const links = db
        .select({
          id: developmentMissionLinks.id,
          childMissionId: developmentMissionLinks.childMissionId,
          childRevision: developmentMissionLinks.latestChildRevision,
          status: developmentMissionLinks.latestStatus,
          satisfied: developmentMissionLinks.completionSatisfied,
        })
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.parentMissionId, missionId))
        .orderBy(asc(developmentMissionLinks.id))
        .all()
      const approvals = db
        .select({
          id: developmentApprovalSagas.id,
          status: developmentApprovalSagas.latestStatus,
          revision: developmentApprovalSagas.observedRevision,
          ordinal: developmentApprovalSagas.attemptOrdinal,
        })
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.missionId, missionId))
        .orderBy(asc(developmentApprovalSagas.id))
        .all()
      return canonicalDigest({ steps, links, approvals })
    },
  }
}

/** Promise adapter used by provider-selected composition; the legacy factory
 * remains synchronous so the established SQLite behavior oracle is unchanged. */
export function createSqlitePlaybookSagaPersistence(db: DbClient): PlaybookSagaPersistence {
  const store = createSqlitePlaybookSagaStore(db)
  return {
    async claimStepRun(input) {
      return store.claimStepRun(input)
    },
    async getStepRun(id) {
      return store.getStepRun(id)
    },
    async listStepRuns(missionId) {
      return store.listStepRuns(missionId)
    },
    async findStepRunByAction(actionRunId) {
      return store.findStepRunByAction(actionRunId)
    },
    async updateStepRun(input) {
      return store.updateStepRun(input)
    },
    async claimMissionLink(input) {
      return store.claimMissionLink(input)
    },
    async getMissionLinkByStepRun(stepRunId) {
      return store.getMissionLinkByStepRun(stepRunId)
    },
    async findParentMissionLink(childMissionId) {
      return store.findParentMissionLink(childMissionId)
    },
    async listMissionLinks(missionId) {
      return store.listMissionLinks(missionId)
    },
    async observeMissionLink(input) {
      store.observeMissionLink(input)
    },
    async claimApprovalSaga(input) {
      return store.claimApprovalSaga(input)
    },
    async getApprovalSaga(id) {
      return store.getApprovalSaga(id)
    },
    async getApprovalSagaByStepRun(stepRunId) {
      return store.getApprovalSagaByStepRun(stepRunId)
    },
    async listApprovalSagas(missionId) {
      return store.listApprovalSagas(missionId)
    },
    async recordApprovalSubmitted(input) {
      store.recordApprovalSubmitted(input)
    },
    async recordApprovalObservation(input) {
      store.recordApprovalObservation(input)
    },
    async upsertJoinMember(input) {
      store.upsertJoinMember(input)
    },
    async listJoinMembers(missionId, groupId) {
      return store.listJoinMembers(missionId, groupId)
    },
    async settleJoin(missionId, groupId, result, now) {
      store.settleJoin(missionId, groupId, result, now)
    },
    async sagaDigest(missionId) {
      return store.sagaDigest(missionId)
    },
  }
}
