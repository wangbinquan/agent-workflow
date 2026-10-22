// RFC-359 W4-B5 —— 数字员工工作区持久化：一份实现，两个 provider 共用。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { and, desc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  EmployeeCaseWorkspaceRow,
  EmployeeRoundWorkspaceStateRow,
  EmployeeWorkspacePersistence,
} from '../application/ports/employeeWorkspacePersistence'

const workspaceRow = (
  row: PersistenceTables['employeeCaseWorkspaces']['$inferSelect'],
): EmployeeCaseWorkspaceRow => row

const roundRow = (
  row: PersistenceTables['employeeRoundWorkspaceStates']['$inferSelect'],
): EmployeeRoundWorkspaceStateRow => row

export function createEmployeeWorkspacePersistence(
  db: PersistenceDb,
): EmployeeWorkspacePersistence {
  return {
    async workspace(caseId) {
      const { employeeCaseWorkspaces } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeCaseWorkspaces)
          .where(eq(employeeCaseWorkspaces.caseId, caseId))
          .limit(1)
      )[0]
      return row === undefined ? null : workspaceRow(row)
    },
    async insertWorkspace(row) {
      const { employeeCaseWorkspaces } = tablesOf(db)
      await insertOne(db, employeeCaseWorkspaces, row)
    },
    async repositoryLocalPath(cachedRepoId) {
      const { cachedRepos } = tablesOf(db)
      const row = (
        await db
          .select({ localPath: cachedRepos.localPath })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, cachedRepoId))
          .limit(1)
      )[0]
      return row?.localPath ?? null
    },
    async latestRoundState(roundId) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeRoundWorkspaceStates)
          .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
          .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
          .limit(1)
      )[0]
      return row === undefined ? null : roundRow(row)
    },
    async roundState(roundId, attemptOrdinal) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      const row = (
        await db
          .select()
          .from(employeeRoundWorkspaceStates)
          .where(
            and(
              eq(employeeRoundWorkspaceStates.roundId, roundId),
              eq(employeeRoundWorkspaceStates.attemptOrdinal, attemptOrdinal),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : roundRow(row)
    },
    async insertRoundState(row, conflict) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      const statement = db.insert(employeeRoundWorkspaceStates).values(row)
      if (conflict === 'ignore') await statement.onConflictDoNothing()
      else await statement
    },
    async upsertRoundState(row) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      await db
        .insert(employeeRoundWorkspaceStates)
        .values(row)
        .onConflictDoUpdate({
          target: [
            employeeRoundWorkspaceStates.roundId,
            employeeRoundWorkspaceStates.attemptOrdinal,
          ],
          set: {
            caseId: row.caseId,
            baselineSha: row.baselineSha,
            preStateJson: row.preStateJson,
            checkpointDigest: row.checkpointDigest,
            validationJson: row.validationJson,
            updatedAt: row.updatedAt,
          },
        })
    },
    async updateRoundState(input) {
      const { employeeRoundWorkspaceStates } = tablesOf(db)
      await db
        .update(employeeRoundWorkspaceStates)
        .set(input.patch)
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, input.roundId),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, input.attemptOrdinal),
          ),
        )
    },
  }
}
