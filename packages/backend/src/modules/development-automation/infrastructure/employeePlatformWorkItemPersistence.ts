// RFC-359 W4-D13 —— 数字员工平台工作项（审批 saga / change candidate / case workspace）的持久化：一份实现，两个 provider 共用。
// prepareApprovalSaga 的幂等落 `employee_approval_sagas_idempotency_unique`（onConflictDoNothing + 回读同一笔事务）；
// publishCandidateAndWorkspace 两张表的更新在统一事务里。

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { desc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  EmployeeApprovalSagaRecord,
  EmployeeChangeCandidateRecord,
  EmployeePlatformWorkItemPersistence,
} from '../application/ports/employeePlatformWorkItemPersistence'
import type { EmployeeCaseWorkspaceRow } from '../application/ports/employeeWorkspacePersistence'

function approvalRecord(
  row: PersistenceTables['employeeApprovalSagas']['$inferSelect'],
): EmployeeApprovalSagaRecord {
  return row
}

function candidateRecord(
  row: PersistenceTables['employeeChangeCandidates']['$inferSelect'],
): EmployeeChangeCandidateRecord {
  return row
}

function workspaceRecord(
  row: PersistenceTables['employeeCaseWorkspaces']['$inferSelect'],
): EmployeeCaseWorkspaceRow {
  return row
}

export function createEmployeePlatformWorkItemPersistence(
  db: PersistenceDb,
): EmployeePlatformWorkItemPersistence {
  const session = databaseSessionFor(db)
  return {
    async currentWorkspace(caseId) {
      const { employeeCaseWorkspaces, cachedRepos } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeCaseWorkspaces)
          .where(eq(employeeCaseWorkspaces.caseId, caseId))
          .limit(1)
      )[0]
      if (row === undefined) return null
      const repository = (
        await db
          .select({ localPath: cachedRepos.localPath })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, row.cachedRepoId))
          .limit(1)
      )[0]
      return repository === undefined
        ? null
        : { row: workspaceRecord(row), repositoryLocalPath: repository.localPath }
    },
    async prepareApprovalSaga(input) {
      return await session.transaction(async (tx) => {
        const { employeeApprovalSagas } = tablesOf(tx)
        await tx
          .insert(employeeApprovalSagas)
          .values(input)
          .onConflictDoNothing({ target: employeeApprovalSagas.idempotencyKey })
        const row = (
          await tx
            .select()
            .from(employeeApprovalSagas)
            .where(eq(employeeApprovalSagas.idempotencyKey, input.idempotencyKey))
            .limit(1)
        )[0]
        return row === undefined ? null : approvalRecord(row)
      })
    },
    async approvalSaga(idempotencyKey) {
      const { employeeApprovalSagas } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeApprovalSagas)
          .where(eq(employeeApprovalSagas.idempotencyKey, idempotencyKey))
          .limit(1)
      )[0]
      return row === undefined ? null : approvalRecord(row)
    },
    async recordApprovalSubmission(input) {
      const { employeeApprovalSagas } = tablesOf(db)
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
    },
    async recordApprovalObservation(input) {
      const { employeeApprovalSagas } = tablesOf(db)
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
    },
    async insertCandidate(input) {
      const { employeeChangeCandidates } = tablesOf(db)
      await db
        .insert(employeeChangeCandidates)
        .values({
          ...input,
          state: 'prepared',
          commitSha: null,
          pushReceiptJson: null,
        })
        .onConflictDoNothing()
    },
    async candidate(candidateRef) {
      const { employeeChangeCandidates } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeChangeCandidates)
          .where(eq(employeeChangeCandidates.candidateRef, candidateRef))
          .limit(1)
      )[0]
      return row === undefined ? null : candidateRecord(row)
    },
    async recordCandidateCommit(input) {
      const { employeeChangeCandidates } = tablesOf(db)
      await db
        .update(employeeChangeCandidates)
        .set({ state: 'committed', commitSha: input.commitSha, updatedAt: input.updatedAt })
        .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
    },
    async publishCandidateAndWorkspace(input) {
      await session.transaction(async (tx) => {
        const { employeeChangeCandidates, employeeCaseWorkspaces } = tablesOf(tx)
        await tx
          .update(employeeChangeCandidates)
          .set({
            state: 'published',
            commitSha: input.commitSha,
            pushReceiptJson: input.pushReceiptJson,
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeChangeCandidates.candidateRef, input.candidateRef))
        await tx
          .update(employeeCaseWorkspaces)
          .set({
            baselineSha: input.commitSha,
            remoteHeadSha: input.commitSha,
            state: 'published',
            updatedAt: input.updatedAt,
          })
          .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
      })
    },
    async updateWorkspaceHead(input) {
      const { employeeCaseWorkspaces } = tablesOf(db)
      await db
        .update(employeeCaseWorkspaces)
        .set({
          baselineSha: input.baselineSha,
          remoteHeadSha: input.remoteHeadSha,
          state: 'published',
          updatedAt: input.updatedAt,
        })
        .where(eq(employeeCaseWorkspaces.caseId, input.caseId))
    },
    async latestRoundValidation(roundId) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      const row = (
        await db
          .select({ validationJson: employeeRoundWorkspaceStates.validationJson })
          .from(employeeRoundWorkspaceStates)
          .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
          .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
          .limit(1)
      )[0]
      return row?.validationJson ?? null
    },
  }
}
