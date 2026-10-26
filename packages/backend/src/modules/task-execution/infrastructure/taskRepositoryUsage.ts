import { requestedSourceCachedRepoSql } from '@/platform/persistence/taskRepositorySurface'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { rawRows, type RawRowCodecs } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, sql, type SQLWrapper } from 'drizzle-orm'
import type {
  TaskRepositorySourceStore,
  TaskRepositoryUsageQueries,
} from '../application/ports/taskRepositoryUsage'
import { decodeRequestedSourceJson, encodeRequestedSource } from '../domain/requestedSourceCodec'
import { TaskAggregateCasMiss, taskAggregateWrite } from './taskDefinitionWriteParticipant'
import { taskRequestedSourceColumns, taskRequestedSourceReferenceSql } from './taskRepositorySql'

export type TaskRepositoryUsageRead = <T extends Record<string, unknown>>(
  query: SQLWrapper,
  codecs?: RawRowCodecs<T>,
) => Promise<readonly T[]>

function chunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)]
  const result: string[][] = []
  for (let start = 0; start < unique.length; start += 500)
    result.push(unique.slice(start, start + 500))
  return result
}

/** Requested sources and mounts each use their own cached-repository index. */
export function createTaskRepositoryUsageQueries(
  db: PersistenceDb,
  read: TaskRepositoryUsageRead = async (query, codecs) => await rawRows(db, query, codecs),
): TaskRepositoryUsageQueries {
  return {
    async referencedAmong(ids) {
      const mounted = new Set<string>()
      const requestedOnly = new Set<string>()
      const { taskRepositoryMounts: taskRepos } = tablesOf(db)
      for (const chunk of chunks(ids)) {
        const candidates = sql.join(
          chunk.map((id) => sql`(${id})`),
          sql`, `,
        )
        const rows = await read<{
          cached_repo_id: string
          mounted: boolean
          requested_only: boolean
        }>(
          sql`
          WITH candidates(id) AS (VALUES ${candidates})
          SELECT candidates.id AS cached_repo_id,
            coalesce((SELECT true FROM ${taskRepos} WHERE ${taskRepos.cachedRepoId} = candidates.id LIMIT 1), false) AS mounted,
            ${taskRequestedSourceReferenceSql(db, sql`candidates.id`)} AS requested_only
          FROM candidates
        `,
          { mounted: 'bool', requested_only: 'bool' },
        )
        for (const row of rows) {
          if (row.mounted) mounted.add(row.cached_repo_id)
          if (row.requested_only) requestedOnly.add(row.cached_repo_id)
        }
      }
      return { mounted, requestedOnly }
    },
    async countTaskReferences(ids) {
      const counts = new Map<string, number>()
      const { taskWorkspaces: workspace, taskRepositoryMounts: taskRepos } = tablesOf(db)
      for (const chunk of chunks(ids)) {
        const candidates = sql.join(
          chunk.map((id) => sql`(${id})`),
          sql`, `,
        )
        const rows = await read<{ cached_repo_id: string; count: number }>(
          sql`
          WITH candidates(id) AS (VALUES ${candidates})
          SELECT candidates.id AS cached_repo_id,
            (SELECT count(distinct ${taskRepos.taskId}) FROM ${taskRepos}
              WHERE ${taskRepos.cachedRepoId} = candidates.id)
            + (SELECT count(*) FROM ${workspace}
              WHERE ${requestedSourceCachedRepoSql(db)} = candidates.id
                AND NOT EXISTS (SELECT 1 FROM ${taskRepos} WHERE ${taskRepos.taskId} = ${workspace.taskId})) AS count
          FROM candidates
        `,
          { count: 'int' },
        )
        for (const row of rows)
          if (Number(row.count) > 0) counts.set(row.cached_repo_id, Number(row.count))
      }
      return counts
    },
  }
}

export function createTaskRepositorySourceStore(db: PersistenceDb): TaskRepositorySourceStore {
  return {
    async listSources() {
      const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
      const [mounts, requested] = await Promise.all([
        db
          .select({
            taskId: taskRepos.taskId,
            ordinal: taskRepos.ordinal,
            repoUrl: taskRepos.repoUrl,
            cachedRepoId: taskRepos.cachedRepoId,
            submoduleInitError: taskRepos.submoduleInitError,
          })
          .from(taskRepos),
        db
          .select({
            taskId: tasks.id,
            repoUrl: taskRequestedSourceColumns(db).repoUrl,
            cachedRepoId: taskRequestedSourceColumns(db).cachedRepoId,
          })
          .from(tasks),
      ])
      return { mounts, requested }
    },
    participant(tx) {
      const { tasks, taskWorkspaces, taskRepositoryMounts: taskRepos } = tablesOf(tx)
      return {
        async updateRequestedSource(taskId, patch) {
          await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
          const row = (
            await tx
              .select({
                requestedSource: taskWorkspaces.requestedSource,
              })
              .from(tasks)
              .innerJoin(taskWorkspaces, eq(taskWorkspaces.taskId, tasks.id))
              .where(eq(tasks.id, taskId))
          )[0]
          if (!row) throw new TaskAggregateCasMiss(taskId)
          const source = decodeRequestedSourceJson(row.requestedSource)
          await tx
            .update(taskWorkspaces)
            .set({ requestedSource: encodeRequestedSource({ ...source, ...patch }) })
            .where(eq(taskWorkspaces.taskId, taskId))
          // Source normalization is serialized by the root lock, not a lifecycle CAS.
        },
        async updateMount(taskId, ordinal, patch) {
          await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
          await tx
            .update(taskRepos)
            .set(patch)
            .where(and(eq(taskRepos.taskId, taskId), eq(taskRepos.ordinal, ordinal)))
        },
      }
    },
  }
}
