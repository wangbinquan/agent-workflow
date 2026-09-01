import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  cachedRepos,
  memories,
  repoGroupNodes,
  repoGroups,
  scheduledTasks,
  taskRepos,
  tasks,
} from '@/db/schema'
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

function changes(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

function sqliteExecutor(db: DbClient): RepositoryWorkspaceSqlExecutor {
  return {
    async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
      return db.all(query) as T[]
    },
    async run(query): Promise<number> {
      return changes(db.run(query))
    },
  }
}

function insertGroupNodes(tx: DbTxSync, nodes: readonly RepositoryGroupNodeRecord[]): void {
  for (const node of nodes) tx.insert(repoGroupNodes).values(node).run()
}

function graphVersionsMatch(
  actual: readonly { readonly id: string; readonly version: number }[],
  expected: readonly { readonly id: string; readonly version: number }[],
): boolean {
  if (actual.length !== expected.length) return false
  const expectedById = new Map(expected.map((row) => [row.id, row.version]))
  return actual.every((row) => expectedById.get(row.id) === row.version)
}

function applySealingMutation(tx: DbTxSync, mutation: RepositoryCredentialSealingMutation): void {
  for (const update of mutation.cachedRepoUpdates) {
    tx.update(cachedRepos).set(update.patch).where(eq(cachedRepos.id, update.id)).run()
  }
  for (const update of mutation.taskRepoUpdates) {
    tx.update(taskRepos)
      .set(update.patch)
      .where(and(eq(taskRepos.taskId, update.taskId), eq(taskRepos.repoIndex, update.repoIndex)))
      .run()
  }
  for (const update of mutation.taskUpdates) {
    tx.update(tasks).set(update.patch).where(eq(tasks.id, update.id)).run()
  }
  for (const update of mutation.scheduleUpdates) {
    tx.update(scheduledTasks)
      .set({ launchPayload: update.launchPayload })
      .where(eq(scheduledTasks.id, update.id))
      .run()
  }
}

export class SQLiteRepositoryWorkspaceStore
  extends RepositoryWorkspaceSqlStore
  implements RepositoryWorkspaceStore
{
  readonly runtimeIdentity: object

  constructor(private readonly db: DbClient) {
    super(sqliteExecutor(db))
    this.runtimeIdentity = db as object
  }

  async deleteCachedRepoAndDetachGroups(id: string): Promise<void> {
    dbTxSync(this.db, (tx) => {
      tx.update(repoGroupNodes)
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
      tx.delete(cachedRepos).where(eq(cachedRepos.id, id)).run()
    })
    this.invalidateCachedRepoFacets()
  }

  async applyCredentialSealingMutation(
    mutation: RepositoryCredentialSealingMutation,
  ): Promise<void> {
    dbTxSync(this.db, (tx) => applySealingMutation(tx, mutation))
  }

  async compactAfterCredentialScrub(): Promise<void> {
    this.db.run(sql`PRAGMA secure_delete = ON`)
    this.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    this.db.run(sql`VACUUM`)
  }

  async createRepositoryGroup(
    group: RepositoryGroupRecord,
    nodes: readonly RepositoryGroupNodeRecord[],
  ): Promise<'created' | 'name-conflict'> {
    return dbTxSync(this.db, (tx) => {
      const duplicate = tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${group.name})`)
        .limit(1)
        .all()[0]
      if (duplicate !== undefined) return 'name-conflict'
      tx.insert(repoGroups).values(group).run()
      insertGroupNodes(tx, nodes)
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
    return dbTxSync(this.db, (tx) => {
      const graphVersions = tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
        .all()
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const current = tx
        .select({ version: repoGroups.version })
        .from(repoGroups)
        .where(eq(repoGroups.id, input.id))
        .limit(1)
        .all()[0]
      if (current === undefined) return { status: 'missing' }
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return { status: 'stale', actualVersion: current.version }
      }
      const duplicate = tx
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(sql`lower(${repoGroups.name}) = lower(${input.name})`)
        .all()
        .some((row) => row.id !== input.id)
      if (duplicate) return { status: 'name-conflict' }
      tx.delete(repoGroupNodes).where(eq(repoGroupNodes.groupId, input.id)).run()
      insertGroupNodes(tx, input.nodes)
      const version = current.version + 1
      tx.update(repoGroups)
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
    return dbTxSync(this.db, (tx) => {
      const graphVersions = tx
        .select({ id: repoGroups.id, version: repoGroups.version })
        .from(repoGroups)
        .all()
      if (!graphVersionsMatch(graphVersions, input.expectedGraphVersions)) {
        return { status: 'graph-stale' }
      }
      const memoryRows = tx
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
        tx.update(memories)
          .set({ status: 'archived' })
          .where(
            inArray(
              memories.id,
              memoryRows.map((row) => row.id),
            ),
          )
          .run()
      }
      const references = tx
        .select({ groupId: repoGroupNodes.groupId })
        .from(repoGroupNodes)
        .where(eq(repoGroupNodes.childGroupId, input.id))
        .all()
      if (references.length > 0) {
        tx.update(repoGroupNodes)
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
        tx.update(scheduledTasks)
          .set({
            enabled: false,
            nextRunAt: null,
            lastError: `repo group ${input.id} was deleted; re-point this schedule before re-enabling`,
          })
          .where(inArray(scheduledTasks.id, [...input.scheduleIds]))
          .run()
      }
      tx.delete(repoGroups).where(eq(repoGroups.id, input.id)).run()
      return {
        status: 'ok',
        archivedMemories: memoryRows.length,
        detachedReferences: references.length,
        disabledSchedules: input.scheduleIds.length,
      }
    })
  }
}

export function composeSqliteRepositoryWorkspaceStore(db: DbClient): RepositoryWorkspaceStore {
  return new SQLiteRepositoryWorkspaceStore(db)
}
