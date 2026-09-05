// RFC-359 W4-B5 —— 数字员工工作区持久化：一份实现，两个 provider 共用。

import { and, desc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos, employeeCaseWorkspaces, employeeRoundWorkspaceStates } from '@/db/schema'
import type {
  EmployeeCaseWorkspaceRow,
  EmployeeRoundWorkspaceStateRow,
  EmployeeWorkspacePersistence,
} from '../application/ports/employeeWorkspacePersistence'

const workspaceRow = (row: typeof employeeCaseWorkspaces.$inferSelect): EmployeeCaseWorkspaceRow =>
  row

const roundRow = (
  row: typeof employeeRoundWorkspaceStates.$inferSelect,
): EmployeeRoundWorkspaceStateRow => row

export function createEmployeeWorkspacePersistence(
  db: ProviderNeutralDatabase,
): EmployeeWorkspacePersistence {
  return {
    async workspace(caseId) {
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
      await db.insert(employeeCaseWorkspaces).values(row)
    },
    async repositoryLocalPath(cachedRepoId) {
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
      const statement = db.insert(employeeRoundWorkspaceStates).values(row)
      if (conflict === 'ignore') await statement.onConflictDoNothing()
      else await statement
    },
    async upsertRoundState(row) {
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
