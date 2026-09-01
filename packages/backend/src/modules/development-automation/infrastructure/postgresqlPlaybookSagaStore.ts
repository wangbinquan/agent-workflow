import { and, asc, eq, sql } from 'drizzle-orm'

import {
  developmentApprovalSagas,
  developmentMissionLinks,
  developmentStepJoins,
  developmentStepRuns,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ApprovalSagaRow,
  MissionLinkRow,
  PlaybookSagaPersistence,
  StepJoinRow,
  StepRunRow,
} from '../application/ports/playbookSagaStore'
import { canonicalDigest } from '../domain/canonicalJson'
import { canTransitionStepRun, stepRunStateSchema } from '../domain/stepSaga'

function step(row: typeof developmentStepRuns.$inferSelect): StepRunRow {
  return { ...row, state: stepRunStateSchema.parse(row.state) }
}

function link(row: typeof developmentMissionLinks.$inferSelect): MissionLinkRow {
  return {
    ...row,
    completion: row.completion as MissionLinkRow['completion'],
    completionSatisfied: row.completionSatisfied === 1,
  }
}

function approval(row: typeof developmentApprovalSagas.$inferSelect): ApprovalSagaRow {
  return { ...row, latestStatus: row.latestStatus as ApprovalSagaRow['latestStatus'] }
}

function join(row: typeof developmentStepJoins.$inferSelect): StepJoinRow {
  return {
    ...row,
    mode: row.mode as StepJoinRow['mode'],
    memberState: row.memberState as StepJoinRow['memberState'],
  }
}

export function createPostgresqlPlaybookSagaPersistence(
  db: PostgresqlDatabaseClient,
): PlaybookSagaPersistence {
  return {
    async claimStepRun(input) {
      const inserted = await db
        .insert(developmentStepRuns)
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
        .onConflictDoNothing()
        .returning()
        .all()
      if (inserted[0] !== undefined) return { created: true, row: step(inserted[0]) }
      const existing = await db
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
        .limit(1)
        .get()
      if (existing === undefined) throw new Error('step-run claim winner is unavailable')
      return { created: false, row: step(existing) }
    },
    async getStepRun(id) {
      const row = await db
        .select()
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.id, id))
        .limit(1)
        .get()
      return row === undefined ? null : step(row)
    },
    async listStepRuns(missionId) {
      return (
        await db
          .select()
          .from(developmentStepRuns)
          .where(eq(developmentStepRuns.missionId, missionId))
          .orderBy(asc(developmentStepRuns.createdAt), asc(developmentStepRuns.id))
          .all()
      ).map(step)
    },
    async findStepRunByAction(actionRunId) {
      const row = await db
        .select()
        .from(developmentStepRuns)
        .where(eq(developmentStepRuns.actionRunId, actionRunId))
        .limit(1)
        .get()
      return row === undefined ? null : step(row)
    },
    async updateStepRun(input) {
      return await db.transaction(async (tx) => {
        const current = await tx
          .select({ state: developmentStepRuns.state })
          .from(developmentStepRuns)
          .where(eq(developmentStepRuns.id, input.id))
          .limit(1)
          .get()
        if (current === undefined) return false
        const from = stepRunStateSchema.parse(current.state)
        if (!input.from.includes(from) || !canTransitionStepRun(from, input.state)) return false
        const terminal = input.state === 'succeeded' || input.state === 'failed'
        const updated = await tx
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
          .returning({ id: developmentStepRuns.id })
          .all()
        return updated.length === 1
      })
    },

    async claimMissionLink(input) {
      const inserted = await db
        .insert(developmentMissionLinks)
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
        .onConflictDoNothing()
        .returning()
        .all()
      if (inserted[0] !== undefined) return { created: true, row: link(inserted[0]) }
      const existing = await db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .get()
      if (existing === undefined) throw new Error('mission-link claim winner is unavailable')
      return { created: false, row: link(existing) }
    },
    async getMissionLinkByStepRun(stepRunId) {
      const row = await db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.parentStepRunId, stepRunId))
        .limit(1)
        .get()
      return row === undefined ? null : link(row)
    },
    async findParentMissionLink(childMissionId) {
      const row = await db
        .select()
        .from(developmentMissionLinks)
        .where(eq(developmentMissionLinks.childMissionId, childMissionId))
        .limit(1)
        .get()
      return row === undefined ? null : link(row)
    },
    async listMissionLinks(missionId) {
      return (
        await db
          .select()
          .from(developmentMissionLinks)
          .where(eq(developmentMissionLinks.parentMissionId, missionId))
          .orderBy(asc(developmentMissionLinks.createdAt), asc(developmentMissionLinks.id))
          .all()
      ).map(link)
    },
    async observeMissionLink(input) {
      await db
        .update(developmentMissionLinks)
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

    async claimApprovalSaga(input) {
      const inserted = await db
        .insert(developmentApprovalSagas)
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
        .onConflictDoNothing()
        .returning()
        .all()
      if (inserted[0] !== undefined) return { created: true, row: approval(inserted[0]) }
      const existing = await db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .get()
      if (existing === undefined) throw new Error('approval-saga claim winner is unavailable')
      return { created: false, row: approval(existing) }
    },
    async getApprovalSaga(id) {
      const row = await db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.id, id))
        .limit(1)
        .get()
      return row === undefined ? null : approval(row)
    },
    async getApprovalSagaByStepRun(stepRunId) {
      const row = await db
        .select()
        .from(developmentApprovalSagas)
        .where(eq(developmentApprovalSagas.stepRunId, stepRunId))
        .limit(1)
        .get()
      return row === undefined ? null : approval(row)
    },
    async listApprovalSagas(missionId) {
      return (
        await db
          .select()
          .from(developmentApprovalSagas)
          .where(eq(developmentApprovalSagas.missionId, missionId))
          .orderBy(asc(developmentApprovalSagas.createdAt), asc(developmentApprovalSagas.id))
          .all()
      ).map(approval)
    },
    async recordApprovalSubmitted(input) {
      await db
        .update(developmentApprovalSagas)
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
    async recordApprovalObservation(input) {
      const settled = ['approved', 'rejected', 'expired', 'unavailable'].includes(input.status)
      await db
        .update(developmentApprovalSagas)
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

    async upsertJoinMember(input) {
      await db
        .insert(developmentStepJoins)
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
    async listJoinMembers(missionId, groupId) {
      return (
        await db
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
      ).map(join)
    },
    async settleJoin(missionId, groupId, result, now) {
      await db
        .update(developmentStepJoins)
        .set({ settledResult: result, updatedAt: now })
        .where(
          and(
            eq(developmentStepJoins.missionId, missionId),
            eq(developmentStepJoins.groupId, groupId),
          ),
        )
        .run()
    },
    async sagaDigest(missionId) {
      return await db.transaction(async (tx) => {
        const steps = await tx
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
        const links = await tx
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
        const approvals = await tx
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
      })
    },
  }
}
