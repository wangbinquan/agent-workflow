import { and, desc, eq } from 'drizzle-orm'

import { cachedRepos, employeeCaseWorkspaces, employeeRoundWorkspaceStates } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
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

export function createPostgresqlEmployeeWorkspacePersistence(
  db: PostgresqlDatabaseClient,
): EmployeeWorkspacePersistence {
  return {
    async workspace(caseId) {
      const row = await db
        .select()
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, caseId))
        .limit(1)
        .get()
      return row === undefined ? null : workspaceRow(row)
    },
    async insertWorkspace(row) {
      await db.insert(employeeCaseWorkspaces).values(row).run()
    },
    async repositoryLocalPath(cachedRepoId) {
      const row = await db
        .select({ localPath: cachedRepos.localPath })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, cachedRepoId))
        .limit(1)
        .get()
      return row?.localPath ?? null
    },
    async latestRoundState(roundId) {
      const row = await db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(eq(employeeRoundWorkspaceStates.roundId, roundId))
        .orderBy(desc(employeeRoundWorkspaceStates.attemptOrdinal))
        .limit(1)
        .get()
      return row === undefined ? null : roundRow(row)
    },
    async roundState(roundId, attemptOrdinal) {
      const row = await db
        .select()
        .from(employeeRoundWorkspaceStates)
        .where(
          and(
            eq(employeeRoundWorkspaceStates.roundId, roundId),
            eq(employeeRoundWorkspaceStates.attemptOrdinal, attemptOrdinal),
          ),
        )
        .limit(1)
        .get()
      return row === undefined ? null : roundRow(row)
    },
    async insertRoundState(row, conflict) {
      const statement = db.insert(employeeRoundWorkspaceStates).values(row)
      if (conflict === 'ignore') await statement.onConflictDoNothing().run()
      else await statement.run()
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
        .run()
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
        .run()
    },
  }
}
