import { desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  cachedRepos,
  employeeApprovalSagas,
  employeeCaseWorkspaces,
  employeeChangeCandidates,
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  EmployeeApprovalSagaRecord,
  EmployeeChangeCandidateRecord,
  EmployeePlatformWorkItemPersistence,
} from '../application/ports/employeePlatformWorkItemPersistence'
import type { EmployeeCaseWorkspaceRow } from '../application/ports/employeeWorkspacePersistence'

function approvalRecord(
  row: typeof employeeApprovalSagas.$inferSelect,
): EmployeeApprovalSagaRecord {
  return row
}

function candidateRecord(
  row: typeof employeeChangeCandidates.$inferSelect,
): EmployeeChangeCandidateRecord {
  return row
}

function workspaceRecord(
  row: typeof employeeCaseWorkspaces.$inferSelect,
): EmployeeCaseWorkspaceRow {
  return row
}

export function createSqliteEmployeePlatformWorkItemPersistence(
  db: DbClient,
): EmployeePlatformWorkItemPersistence {
  return {
    async currentWorkspace(caseId) {
      const row = db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, caseId))
        .get()
      if (row === undefined) return null
      const repository = db
        .select({ localPath: cachedRepos.localPath })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, row.cachedRepoId))
        .get()
      return repository === undefined
        ? null
        : { row: workspaceRecord(row), repositoryLocalPath: repository.localPath }
    },
    async prepareApprovalSaga(input) {
      db.insert(employeeApprovalSagas)
        .values(input)
        .onConflictDoNothing({ target: employeeApprovalSagas.idempotencyKey })
        .run()
      const row = db
        .select()
        .from(employeeApprovalSagas)
        .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
        .get()
      return row === undefined ? null : approvalRecord(row)
    },
    async approvalSaga(idempotencyKey) {
      const row = db
        .select()
        .from(employeeApprovalSagas)
        .where(eq(employeeApprovalSagas.idempotencyKey, idempotencyKey))
        .get()
      return row === undefined ? null : approvalRecord(row)
    },
    async recordApprovalSubmission(input) {
      db.update(employeeApprovalSagas)
        .set({
          correlationRef: input.correlationRef,
          externalRequestRef: input.externalRequestRef,
          submittedRevision: input.submittedRevision,
          submittedAt: input.submittedAt,
          latestStatus: 'pending',
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
        .run()
    },
    async recordApprovalObservation(input) {
      db.update(employeeApprovalSagas)
        .set({
          latestStatus: input.latestStatus,
          observedRevision: input.observedRevision,
          evidenceRef: input.evidenceRef,
          observedAt: input.observedAt,
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
        .run()
    },
    async insertCandidate(input) {
      db.insert(employeeChangeCandidates)
        .values({
          ...input,
          state: 'prepared',
          commitSha: null,
          pushReceiptJson: null,
        })
        .onConflictDoNothing()
        .run()
    },
    async candidate(candidateRef) {
      const row = db
        .select()
        .from(employeeChangeCandidates)
        .where(eq(employeeChangeCandidates.candidateRef, candidateRef))
        .get()
      return row === undefined ? null : candidateRecord(row)
    },
    async recordCandidateCommit(input) {
      db.update(employeeChangeCandidates)
        .set({ state: 'committed', commitSha: input.commitSha, updatedAt: input.updatedAt })
        .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
        .run()
    },
    async publishCandidateAndWorkspace(input) {
      dbTxSync(db, (tx) => {
        tx.update(employeeChangeCandidates)
          .set({
            state: 'published',
            commitSha: input.commitSha,
            pushReceiptJson: input.pushReceiptJson,
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
          .run()
        tx.update(employeeCaseWorkspaces)
          .set({
            baselineSha: input.commitSha,
            remoteHeadSha: input.commitSha,
            state: 'published',
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
          .run()
      })
    },
    async updateWorkspaceHead(input) {
      db.update(employeeCaseWorkspaces)
        .set({
          baselineSha: input.baselineSha,
          remoteHeadSha: input.remoteHeadSha,
          state: 'published',
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
        .run()
    },
    async latestRoundValidation(roundId) {
      return (
        db
          .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
          .from(employeeRoundWorkspaceStates)
          .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
          .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
          .get()?.validationJson ?? null
      )
    },
  }
}

export function createPostgresqlEmployeePlatformWorkItemPersistence(
  db: PostgresqlDatabaseClient,
): EmployeePlatformWorkItemPersistence {
  return {
    async currentWorkspace(caseId) {
      const row = await db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, caseId))
        .limit(1)
        .get()
      if (row === undefined) return null
      const repository = await db
        .select({ localPath: cachedRepos.localPath })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, row.cachedRepoId))
        .limit(1)
        .get()
      return repository === undefined
        ? null
        : { row: workspaceRecord(row), repositoryLocalPath: repository.localPath }
    },
    async prepareApprovalSaga(input) {
      return await db.transaction(async (tx) => {
        await tx
          .insert(employeeApprovalSagas)
          .values(input)
          .onConflictDoNothing({ target: employeeApprovalSagas.idempotencyKey })
          .run()
        const row = await tx
          .select()
          .from(employeeApprovalSagas)
          .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
          .limit(1)
          .get()
        return row === undefined ? null : approvalRecord(row)
      })
    },
    async approvalSaga(idempotencyKey) {
      const row = await db
        .select()
        .from(employeeApprovalSagas)
        .where(eq(employeeApprovalSagas.idempotencyKey, idempotencyKey))
        .limit(1)
        .get()
      return row === undefined ? null : approvalRecord(row)
    },
    async recordApprovalSubmission(input) {
      await db
        .update(employeeApprovalSagas)
        .set({
          correlationRef: input.correlationRef,
          externalRequestRef: input.externalRequestRef,
          submittedRevision: input.submittedRevision,
          submittedAt: input.submittedAt,
          latestStatus: 'pending',
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
        .run()
    },
    async recordApprovalObservation(input) {
      await db
        .update(employeeApprovalSagas)
        .set({
          latestStatus: input.latestStatus,
          observedRevision: input.observedRevision,
          evidenceRef: input.evidenceRef,
          observedAt: input.observedAt,
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
        .run()
    },
    async insertCandidate(input) {
      await db
        .insert(employeeChangeCandidates)
        .values({
          ...input,
          state: 'prepared',
          commitSha: null,
          pushReceiptJson: null,
        })
        .onConflictDoNothing()
        .run()
    },
    async candidate(candidateRef) {
      const row = await db
        .select()
        .from(employeeChangeCandidates)
        .where(eq(employeeChangeCandidates.candidateRef, candidateRef))
        .limit(1)
        .get()
      return row === undefined ? null : candidateRecord(row)
    },
    async recordCandidateCommit(input) {
      await db
        .update(employeeChangeCandidates)
        .set({ state: 'committed', commitSha: input.commitSha, updatedAt: input.updatedAt })
        .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
        .run()
    },
    async publishCandidateAndWorkspace(input) {
      await db.transaction(async (tx) => {
        await tx
          .update(employeeChangeCandidates)
          .set({
            state: 'published',
            commitSha: input.commitSha,
            pushReceiptJson: input.pushReceiptJson,
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
          .run()
        await tx
          .update(employeeCaseWorkspaces)
          .set({
            baselineSha: input.commitSha,
            remoteHeadSha: input.commitSha,
            state: 'published',
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
          .run()
      })
    },
    async updateWorkspaceHead(input) {
      await db
        .update(employeeCaseWorkspaces)
        .set({
          baselineSha: input.baselineSha,
          remoteHeadSha: input.remoteHeadSha,
          state: 'published',
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
        .run()
    },
    async latestRoundValidation(roundId) {
      const row = await db
        .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
        .from(employeeRoundWorkspaceStates)
        .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
        .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
        .limit(1)
        .get()
      return row?.validationJson ?? null
    },
  }
}
