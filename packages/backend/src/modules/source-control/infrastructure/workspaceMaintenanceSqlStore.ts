import { tablesOf } from '@/platform/persistence/sessionTables'
import type { RawRowCodecs } from '@/platform/persistence/queryHelpers'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { sql, type SQLWrapper } from 'drizzle-orm'
import {
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  type TaskStatus,
} from '@agent-workflow/shared'

import { WORKSPACE_PRUNING_LEASE_MS } from '../application/workspaceMaintenance'
import type {
  WebhookWorkspaceClaimRecord,
  WorkspaceMaintenanceStore,
  WorkspaceTaskRecord,
  WorkspaceTaskRepositoryRecord,
} from '../application/ports/workspaceMaintenance'

export interface WorkspaceMaintenanceSqlExecutor {
  readonly db: PersistenceDb
  all<T extends Record<string, unknown>>(
    query: SQLWrapper,
    codecs?: RawRowCodecs<T>,
  ): Promise<readonly T[]>
}

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

function mapTask(row: RawWorkspaceTaskRow): WorkspaceTaskRecord {
  return {
    id: row.id,
    status: row.status,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    spaceKind: row.space_kind,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    workspacePruningAt: row.workspace_pruning_at === null ? null : Number(row.workspace_pruning_at),
    workspacePruneCause: row.workspace_prune_cause,
    workspacePrunedAt: row.workspace_pruned_at === null ? null : Number(row.workspace_pruned_at),
    lifecycleEventRevision: Number(row.lifecycle_event_revision),
  }
}

function mapRepository(row: RawWorkspaceRepositoryRow): WorkspaceTaskRepositoryRecord {
  return {
    mountPath: row.mount_path,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
  }
}

/** Shared logical SQL projection. Each provider supplies its own fenced client. */
export class WorkspaceMaintenanceSqlStore implements WorkspaceMaintenanceStore {
  protected get database(): PersistenceDb {
    return this.executor.db
  }
  constructor(private readonly executor: WorkspaceMaintenanceSqlExecutor) {}

  async listGcCandidates(): Promise<readonly WorkspaceTaskRecord[]> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawWorkspaceTaskRow>(
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

  async listTasks(taskIds: readonly string[]): Promise<readonly WorkspaceTaskRecord[]> {
    const persistenceDb = this.database

    if (taskIds.length === 0) return []
    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawWorkspaceTaskRow>(
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

  async listTaskRepositories(taskId: string): Promise<readonly WorkspaceTaskRepositoryRecord[]> {
    const persistenceDb = this.database

    const { taskRepos } = tablesOf(persistenceDb)
    const rows = await this.executor.all<RawWorkspaceRepositoryRow>(sql`
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

  async anchoredTaskIds(taskIds: readonly string[]): Promise<ReadonlySet<string>> {
    const persistenceDb = this.database

    if (taskIds.length === 0) return new Set()
    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
      SELECT ${tasks.id} AS id
      FROM ${tasks}
      WHERE ${tasks.id} IN (${ids(taskIds)})
    `)
    return new Set(rows.map(({ id }) => id))
  }

  async hasLiveOrRevivableChild(taskId: string): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks, nodeRuns } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly status: string } & Record<string, unknown>>(sql`
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

  async claimWorkspace(taskId: string, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePruningAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.workspacePruneCause} IS NULL
        AND ${tasks.workspacePrunedAt} IS NULL
        AND (
          ${tasks.workspacePruningAt} IS NULL
          OR ${tasks.workspacePruningAt} < ${now - WORKSPACE_PRUNING_LEASE_MS}
        )
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async claimIsoWorkspace(taskId: string, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
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

  async reclaimWebhookWorkspace(taskId: string, expectedAt: number, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
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

  async finalizeWorkspace(taskId: string, now: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePrunedAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.workspacePruningAt} IS NOT NULL
        AND ${tasks.workspacePrunedAt} IS NULL
      RETURNING ${tasks.id} AS id
    `)
    if (rows.length === 1) return true
    const current = (await this.listTasks([taskId]))[0]
    return current !== undefined && current.workspacePrunedAt !== null
  }

  async releaseIsoClaim(taskId: string, expectedAt?: number): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const expected =
      expectedAt === undefined ? sql`1 = 1` : sql`${tasks.workspacePruningAt} = ${expectedAt}`
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
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
      current.workspacePrunedAt !== null ||
      (current.workspacePruningAt === null && current.workspacePruneCause === null)
    )
  }

  async healMissingWorkspace(
    taskId: string,
    now: number,
    expected: Pick<WorkspaceTaskRecord, 'worktreePath' | 'lifecycleEventRevision'>,
  ): Promise<boolean> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<{ readonly id: string } & Record<string, unknown>>(sql`
      UPDATE ${tasks}
      SET ${sql.identifier(tasks.workspacePrunedAt.name)} = ${now}
      WHERE ${tasks.id} = ${taskId}
        AND ${tasks.workspacePrunedAt} IS NULL
        AND ${tasks.workspacePruningAt} IS NULL
        AND ${tasks.status} IN (${terminalStatuses})
        AND ${tasks.deletedAt} IS NULL
        AND ${tasks.worktreePath} = ${expected.worktreePath}
        AND ${tasks.lifecycleEventRevision} = ${expected.lifecycleEventRevision}
      RETURNING ${tasks.id} AS id
    `)
    return rows.length === 1
  }

  async listUnstampedTerminalWorkspaces(): Promise<
    readonly Pick<WorkspaceTaskRecord, 'id' | 'worktreePath' | 'lifecycleEventRevision'>[]
  > {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<
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
        AND ${tasks.worktreePath} <> ''
    `,
      { lifecycle_event_revision: 'int' },
    )
    return rows.map((row) => ({
      id: row.id,
      worktreePath: row.worktree_path,
      lifecycleEventRevision: Number(row.lifecycle_event_revision),
    }))
  }

  async listStaleWebhookClaims(
    staleBefore: number,
  ): Promise<readonly WebhookWorkspaceClaimRecord[]> {
    const persistenceDb = this.database

    const { tasks } = tablesOf(persistenceDb)
    const rows = await this.executor.all<
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
      id: row.id,
      workspacePruningAt: Number(row.workspace_pruning_at),
    }))
  }
}
