import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm'

import {
  cachedRepos,
  memories,
  repoGroupNodes,
  repoGroups,
  scheduledTasks,
  taskRepos,
  tasks,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  RepositoryCredentialSealingMutation,
  RepositoryGroupDeleteResult,
  RepositoryGroupNodeRecord,
  RepositoryGroupRecord,
  RepositoryGroupWriteResult,
  RepositoryWorkspaceStore,
} from '../ports/repositoryWorkspaceStore'
import {
  RepositoryWorkspaceSqlStore,
  type RepositoryWorkspaceSqlExecutor,
} from './repositoryWorkspaceSqlStore'

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

function changes(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

function postgresqlExecutor(db: PostgresqlDatabaseClient): RepositoryWorkspaceSqlExecutor {
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return await db.all<T>(query)
    },
    async run(query): Promise<number> {
      return changes(await db.run(query))
    },
    async cachedRepoFacets(input) {
      const rows = await db.all<{
        all_count: number
        referenced_count: number
        attention_count: number
      }>(sql`
        SELECT
          count(*) AS all_count,
          sum(case when ${input.referenced} then 1 else 0 end) AS referenced_count,
          sum(case when ${input.attention} then 1 else 0 end) AS attention_count
        FROM ${cachedRepos}
      `)
      return rows[0] ?? { all_count: 0, referenced_count: 0, attention_count: 0 }
    },
  }
}

async function insertGroupNodes(
  tx: PostgresqlTransaction,
  nodes: readonly RepositoryGroupNodeRecord[],
): Promise<void> {
  for (const node of nodes) await tx.insert(repoGroupNodes).values(node).run()
}

function graphVersionsMatch(
  actual: readonly { readonly id: string; readonly version: number }[],
  expected: readonly { readonly id: string; readonly version: number }[],
): boolean {
  if (actual.length !== expected.length) return false
  const expectedById = new Map(expected.map((row) => [row.id, row.version]))
  return actual.every((row) => expectedById.get(row.id) === row.version)
}

async function applySealingMutation(
  tx: PostgresqlTransaction,
  mutation: RepositoryCredentialSealingMutation,
): Promise<void> {
  for (const update of mutation.cachedRepoUpdates) {
    await tx.update(cachedRepos).set(update.patch).where(eq(cachedRepos.id, update.id)).run()
  }
  for (const update of mutation.taskRepoUpdates) {
    await tx
      .update(taskRepos)
      .set(update.patch)
      .where(and(eq(taskRepos.taskId, update.taskId), eq(taskRepos.repoIndex, update.repoIndex)))
      .run()
  }
  for (const update of mutation.taskUpdates) {
    await tx.update(tasks).set(update.patch).where(eq(tasks.id, update.id)).run()
  }
  for (const update of mutation.scheduleUpdates) {
    await tx
      .update(scheduledTasks)
      .set({ launchPayload: update.launchPayload })
      .where(eq(scheduledTasks.id, update.id))
      .run()
  }
}

export class PostgresqlRepositoryWorkspaceStore
  extends RepositoryWorkspaceSqlStore
  implements RepositoryWorkspaceStore
{
  readonly runtimeIdentity: object

  constructor(private readonly db: PostgresqlDatabaseClient) {
    super(postgresqlExecutor(db))
    this.runtimeIdentity = db
  }

  async deleteCachedRepoAndDetachGroups(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(repoGroupNodes)
        .set({
          attachmentKind: null,
          cachedRepoId: null,
          childGroupId: null,
          ref: '',
          subdir: '',
          readonly: false,
        })
        .where(eq(repoGroupNodes.cachedRepoId, id))
        .run()
      await tx.delete(cachedRepos).where(eq(cachedRepos.id, id)).run()
    })
    this.invalidateCachedRepoFacets()
  }

  async applyCredentialSealingMutation(
    mutation: RepositoryCredentialSealingMutation,
  ): Promise<void> {
    await this.db.transaction(async (tx) => await applySealingMutation(tx, mutation))
  }

  async compactAfterCredentialScrub(): Promise<void> {
    // PostgreSQL owns page reclamation/autovacuum. Credential cells are updated
    // transactionally; issuing SQLite PRAGMAs or VACUUM from the daemon would
    // be both invalid and operationally unsafe.
  }

  async createRepositoryGroup(
    group: RepositoryGroupRecord,
    nodes: readonly RepositoryGroupNodeRecord[],
  ): Promise<'created' | 'name-conflict'> {
    return await this.db.transaction(async (tx) => {
      await tx.run(sql`LOCK TABLE ${repoGroups}, ${repoGroupNodes} IN SHARE ROW EXCLUSIVE MODE`)
      const duplicates = await tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${group.name})`)
        .limit(1)
        .all()
      if (duplicates.length > 0) return 'name-conflict'
      await tx.insert(repoGroups).values(group).run()
      await insertGroupNodes(tx, nodes)
      return 'created'
    })
  }

  async updateRepositoryGroup(input: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly expectedVersion?: number
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
    readonly updatedAt: number
    readonly nodes: readonly RepositoryGroupNodeRecord[]
  }): Promise<RepositoryGroupWriteResult> {
    return await this.db.transaction(async (tx) => {
      await tx.run(sql`LOCK TABLE ${repoGroups}, ${repoGroupNodes} IN SHARE ROW EXCLUSIVE MODE`)
      const graphVersions = await tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
        .all()
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const currentRows = await tx
        .select({ version: repoGroups.version })
        .from(repoGroups)
        .where(eq(repoGroups.id, input.id))
        .limit(1)
        .all()
      const current = currentRows[0]
      if (current === undefined) return { status: 'missing' }
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return { status: 'stale', actualVersion: current.version }
      }
      const duplicates = await tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${input.name})`)
        .all()
      if (duplicates.some((row) => row.id !== input.id)) {
        return { status: 'name-conflict' }
      }
      await tx.delete(repoGroupNodes).where(eq(repoGroupNodes.groupId, input.id)).run()
      await insertGroupNodes(tx, input.nodes)
      const version = current.version + 1
      await tx
        .update(repoGroups)
        .set({
          name: input.name,
          description: input.description,
          version,
          updatedAt: input.updatedAt,
          schemaVersion: 2,
        })
        .where(eq(repoGroups.id, input.id))
        .run()
      return { status: 'ok', version }
    })
  }

  async deleteRepositoryGroup(input: {
    readonly id: string
    readonly scheduleIds: readonly string[]
    readonly expectedGraphVersions: readonly {
      readonly id: string
      readonly version: number
    }[]
  }): Promise<RepositoryGroupDeleteResult> {
    return await this.db.transaction(async (tx) => {
      await tx.run(sql`LOCK TABLE ${repoGroups}, ${repoGroupNodes} IN SHARE ROW EXCLUSIVE MODE`)
      const graphVersions = await tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
        .all()
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const memoryRows = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.scopeType, 'repo_group'),
            eq(memories.scopeId, input.id),
            inArray(memories.status, ['candidate', 'approved', 'superseded', 'rejected']),
          ),
        )
        .all()
      if (memoryRows.length > 0) {
        await tx
          .update(memories)
          .set({ status: 'archived' })
          .where(
            inArray(
              memories.id,
              memoryRows.map((row) => row.id),
            ),
          )
          .run()
      }
      const references = await tx
        .select({ groupId: repoGroupNodes.groupId })
        .from(repoGroupNodes)
        .where(eq(repoGroupNodes.childGroupId, input.id))
        .all()
      if (references.length > 0) {
        await tx
          .update(repoGroupNodes)
          .set({
            attachmentKind: null,
            cachedRepoId: null,
            childGroupId: null,
            ref: '',
            subdir: '',
            readonly: false,
          })
          .where(eq(repoGroupNodes.childGroupId, input.id))
          .run()
      }
      if (input.scheduleIds.length > 0) {
        await tx
          .update(scheduledTasks)
          .set({
            enabled: false,
            nextRunAt: null,
            lastError: `repo group ${input.id} was deleted; re-point this schedule before re-enabling`,
          })
          .where(inArray(scheduledTasks.id, [...input.scheduleIds]))
          .run()
      }
      await tx.delete(repoGroups).where(eq(repoGroups.id, input.id)).run()
      return {
        status: 'ok',
        archivedMemories: memoryRows.length,
        detachedReferences: references.length,
        disabledSchedules: input.scheduleIds.length,
      }
    })
  }
}

export function composePostgresqlRepositoryWorkspaceStore(
  db: PostgresqlDatabaseClient,
): RepositoryWorkspaceStore {
  return new PostgresqlRepositoryWorkspaceStore(db)
}
