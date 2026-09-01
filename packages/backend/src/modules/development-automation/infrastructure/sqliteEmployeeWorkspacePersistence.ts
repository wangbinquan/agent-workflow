import { and, desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
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

export function createSqliteEmployeeWorkspacePersistence(
  db: DbClient,
): EmployeeWorkspacePersistence {
  return {
    async workspace(caseId) {
      const row = db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, caseId))
        .get()
      return row === undefined ? null : workspaceRow(row)
    },
    async insertWorkspace(row) {
      db.insert(employeeCaseWorkspaces).values(row).run()
    },
    async repositoryLocalPath(cachedRepoId) {
      return (
        db
          .select({ localPath: cachedRepos.localPath })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, cachedRepoId))
          .get()?.localPath ?? null
      )
    },
    async latestRoundState(roundId) {
      const row = db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
        .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
        .get()
      return row === undefined ? null : roundRow(row)
    },
    async roundState(roundId, attemptOrdinal) {
      const row = db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, roundId),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, attemptOrdinal),
          ),
        )
        .get()
      return row === undefined ? null : roundRow(row)
    },
    async insertRoundState(row, conflict) {
      const statement = db.insert(employeeRoundWorkspaceStates).values(row)
      if (conflict === 'ignore') statement.onConflictDoNothing().run()
      else statement.run()
    },
    async upsertRoundState(row) {
      db.insert(employeeRoundWorkspaceStates)
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
        .run()
    },
    async updateRoundState(input) {
      db.update(employeeRoundWorkspaceStates)
        .set(input.patch)
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, input.roundId),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, input.attemptOrdinal),
          ),
        )
        .run()
    },
  }
}
