import { taskWorkspaceUnboundSql, taskWorkspaceRootMatchesSql } from './taskRepositorySql'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { RawRowCodecs } from '@/platform/persistence/queryHelpers'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { sql, type SQLWrapper } from 'drizzle-orm'
import {
  isTaskWorkspaceUnbound,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  type TaskStatus,
} from '@agent-workflow/shared'

import type {
  WorkspaceGcTask,
  WorkspaceGcMount,
  TaskWorkspaceGcQueries,
  TaskWorkspacePruneCommands,
} from '../application/ports/taskWorkspaceMaintenance'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { existingTaskIds } from './existingTaskIds'

interface RawWorkspaceTaskRow extends Record<string, unknown> {
  readonly id: string
  readonly status: string
  readonly repo_path: string
  readonly worktree_path: string
  readonly branch: string
  readonly base_branch: string
  readonly space_kind: string
  readonly started_at: number
  readonly finished_at: number | null
  readonly workspace_pruning_at: number | null
  readonly workspace_prune_cause: string | null
  readonly workspace_pruned_at: number | null
  readonly lifecycle_event_revision: number
}

interface RawWorkspaceRepositoryRow extends Record<string, unknown> {
  readonly mount_path: string
  readonly repo_path: string
  readonly worktree_path: string
  readonly branch: string
  readonly base_branch: string
}

const taskProjection = (db: object) => {
  const { tasks } = tablesOf(db)
  return sql`
  ${tasks.id} AS id,
  ${tasks.status} AS status,
  ${tasks.repoPath} AS repo_path,
  ${tasks.worktreePath} AS worktree_path,
  ${tasks.branch} AS branch,
  ${tasks.baseBranch} AS base_branch,
  ${tasks.spaceKind} AS space_kind,
  ${tasks.startedAt} AS started_at,
  ${tasks.finishedAt} AS finished_at,
  ${tasks.workspacePruningAt} AS workspace_pruning_at,
  ${tasks.workspacePruneCause} AS workspace_prune_cause,
  ${tasks.workspacePrunedAt} AS workspace_pruned_at,
  ${tasks.lifecycleEventRevision} AS lifecycle_event_revision
`
}

const terminalStatuses = sql.join(
  TERMINAL_TASK_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)

function ids(values: readonly string[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

function mapTask(row: RawWorkspaceTaskRow): WorkspaceGcTask {
  return {
    taskId: row.id,
    status: row.status,
    workspaceRootRef: isTaskWorkspaceUnbound(row.worktree_path) ? null : row.worktree_path,
    primary: { repoPath: row.repo_path, branch: row.branch, baseBranch: row.base_branch },
    spaceKind: row.space_kind,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    prune: {
      pruningAt: row.workspace_pruning_at === null ? null : Number(row.workspace_pruning_at),
      cause: row.workspace_prune_cause,
      prunedAt: row.workspace_pruned_at === null ? null : Number(row.workspace_pruned_at),
    },
    lifecycleRevision: Number(row.lifecycle_event_revision),
  }
}

function mapRepository(row: RawWorkspaceRepositoryRow): WorkspaceGcMount {
  return {
    mountPath: row.mount_path,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
  }
}

/** Shared logical SQL projection. Each provider supplies its own fenced client. */
export class TaskWorkspaceMaintenanceStore
  implements TaskWorkspaceGcQueries, TaskWorkspacePruneCommands
{
  constructor(private readonly database: PersistenceDb) {}

  private async all<T extends Record<string, unknown>>(
    query: SQLWrapper,
    codecs?: RawRowCodecs<T>,
  ): Promise<readonly T[]> {
    return await rawRows<T>(this.database, query, codecs)
  }

  async listGcCandidates(): Promise<readonly WorkspaceGcTask[]> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<RawWorkspaceTaskRow>(
      sql`
      SELECT ${taskProjection(persistenceDb)}
      FROM ${tasks}
      WHERE ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.spaceKind} <> 'internal'
        AND ${tasks.spaceKind} <> 'inherited'
        AND ${tasks.workspacePruneCause} IS NULL
        AND ${tasks.workspacePrunedAt} IS NULL
    `,
      {
        started_at: 'int',
        finished_at: 'int',
        workspace_pruning_at: 'int',
        workspace_pruned_at: 'int',
        lifecycle_event_revision: 'int',
      },
    )
    return rows.map(mapTask)
  }

  async listTasks(taskIds: readonly string[]): Promise<readonly WorkspaceGcTask[]> {
    const persistenceDb = this.database

    if (taskIds.length === 0) return []
    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<RawWorkspaceTaskRow>(
      sql`
      SELECT ${taskProjection(persistenceDb)}
      FROM ${tasks}
      WHERE ${tasks.id} IN (${ids(taskIds)})
    `,
      {
        started_at: 'int',
        finished_at: 'int',
        workspace_pruning_at: 'int',
        workspace_pruned_at: 'int',
        lifecycle_event_revision: 'int',
      },
    )
    return rows.map(mapTask)
  }

  async listMounts(taskId: string): Promise<readonly WorkspaceGcMount[]> {
    const persistenceDb = this.database

    const { taskRepos } = tablesOf(persistenceDb)
    const rows = await this.all<RawWorkspaceRepositoryRow>(sql`
      SELECT
        ${taskRepos.mountPath} AS mount_path,
        ${taskRepos.repoPath} AS repo_path,
        ${taskRepos.worktreePath} AS worktree_path,
        ${taskRepos.branch} AS branch,
        ${taskRepos.baseBranch} AS base_branch
      FROM ${taskRepos}
      WHERE ${taskRepos.taskId} = ${taskId}
      ORDER BY ${taskRepos.repoIndex}
    `)
    return rows.map(mapRepository)
  }

  async existingTaskIds(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
    return await existingTaskIds(this.database, taskIds)
  }

  async hasLiveOrRevivableChild(taskId: string): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks, nodeRuns } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly status: string } & Record<string, unknown>>(sql`
      SELECT ${tasks.status} AS status
      FROM ${tasks}
      WHERE ${tasks.id} IN (
        SELECT ${nodeRuns.childTaskId}
        FROM ${nodeRuns}
        WHERE ${nodeRuns.taskId} = ${taskId}
          AND ${nodeRuns.childTaskId} IS NOT NULL
      )
    `)
    return rows.some(
      ({ status }) => !isTerminalTaskStatus(status as TaskStatus) || status === 'interrupted',
    )
  }

  async claim(taskId: string, now: number, staleClaimBefore: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePruningAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.workspacePruneCause} IS NULL
        AND ${tasks.workspacePrunedAt} IS NULL
        AND (
          ${tasks.workspacePruningAt} IS NULL
          OR ${tasks.workspacePruningAt} < ${staleClaimBefore}
        )
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async claimIsolation(taskId: string, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePruningAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.workspacePruningAt} IS NULL
        AND ${tasks.workspacePruneCause} IS NULL
        AND ${tasks.workspacePrunedAt} IS NULL
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async reclaimWebhook(taskId: string, expectedAt: number, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePruningAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.workspacePruningAt} = ${expectedAt}
        AND ${tasks.workspacePruneCause} = 'webhook-terminal'
        AND ${tasks.workspacePrunedAt} IS NULL
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async finalize(taskId: string, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePrunedAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.workspacePruningAt} IS NOT NULL
        AND ${tasks.workspacePrunedAt} IS NULL
      RETURNING ${tasks.id} AS id
    `)
    if (rows.length === 1) return true
    const current = (await this.listTasks([taskId]))[0]
    return current !== undefined && current.prune.prunedAt !== null
  }

  async releaseIsolation(taskId: string, expectedAt?: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const expected =
      expectedAt === undefined ? sql`1 = 1` : sql`${tasks.workspacePruningAt} = ${expectedAt}`
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePruningAt.name)} = NULL
      WHERE ${tasks.id} = ${taskId}
        AND ${expected}
        AND ${tasks.workspacePruneCause} IS NULL
        AND ${tasks.workspacePrunedAt} IS NULL
      RETURNING ${tasks.id} AS id
    `)
    if (rows.length === 1) return true
    const current = (await this.listTasks([taskId]))[0]
    return (
      current === undefined ||
      current.prune.prunedAt !== null ||
      (current.prune.pruningAt === null && current.prune.cause === null)
    )
  }

  async healMissing(
    taskId: string,
    now: number,
    expected: { workspaceRootRef: string; lifecycleRevision: number },
  ): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePrunedAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.workspacePrunedAt} IS NULL
        AND ${tasks.workspacePruningAt} IS NULL
        AND ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.deletedAt} IS NULL
        AND ${taskWorkspaceRootMatchesSql(tasks.worktreePath, expected.workspaceRootRef)}
        AND ${tasks.lifecycleEventRevision} = ${expected.lifecycleRevision}
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async listUnstampedTerminalWorkspaces(): Promise<
    readonly { taskId: string; workspaceRootRef: string; lifecycleRevision: number }[]
  > {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<
      {
        readonly id: string
        readonly worktree_path: string
        readonly lifecycle_event_revision: number
      } & Record<string, unknown>
    >(
      sql`
      SELECT ${tasks.id} AS id, ${tasks.worktreePath} AS worktree_path,
        ${tasks.lifecycleEventRevision} AS lifecycle_event_revision
      FROM ${tasks}
      WHERE ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.workspacePrunedAt} IS NULL
        AND ${tasks.workspacePruningAt} IS NULL
        AND not ${taskWorkspaceUnboundSql(tasks.worktreePath)}
    `,
      { lifecycle_event_revision: 'int' },
    )
    return rows.map((row) => ({
      taskId: row.id,
      workspaceRootRef: row.worktree_path,
      lifecycleRevision: Number(row.lifecycle_event_revision),
    }))
  }

  async listStaleWebhookClaims(
    staleBefore: number,
  ): Promise<readonly { taskId: string; pruningAt: number }[]> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.all<
      {
        readonly id: string
        readonly workspace_pruning_at: number
      } & Record<string, unknown>
    >(
      sql`
      SELECT
        ${tasks.id} AS id,
        ${tasks.workspacePruningAt} AS workspace_pruning_at
      FROM ${tasks}
      WHERE ${tasks.status} IN ('done', 'canceled')
        AND (${tasks.eventSubscriptionId} IS NOT NULL OR ${tasks.webhookTriggerId} IS NOT NULL)
        AND ${tasks.spaceKind} IN ('remote', 'scratch')
        AND ${tasks.workspacePruningAt} IS NOT NULL
        AND ${tasks.workspacePruningAt} < ${staleBefore}
        AND ${tasks.workspacePruneCause} = 'webhook-terminal'
        AND ${tasks.workspacePrunedAt} IS NULL
    `,
      { workspace_pruning_at: 'int' },
    )
    return rows.map((row) => ({
      taskId: row.id,
      pruningAt: Number(row.workspace_pruning_at),
    }))
  }
}
