import { asc, eq } from 'drizzle-orm'
import type { Task, WebhookTaskSourceLink } from '@agent-workflow/shared'
import { parseTriggerContextJson, webhookTaskSourceLinkOf } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { projectStoredTaskRepositorySurface } from '@/platform/persistence/taskRepositorySurface'
import { decodeTaskRepositoryMount } from './taskRepositoryCodec'
import {
  decodeTaskSubject,
  projectTaskSubject,
  taskSubjectWorkflowVersion,
} from '../domain/taskSubject'
import { taskWorkgroupConfigFromRow } from './taskWorkgroupConfig'
import { DatabaseTaskSubjectQueries } from './taskSubjectQueries'
import type { TaskDetailQueries } from '../application/ports/taskDetailQueries'

export function createTaskDetailQueries(db: PersistenceDb): TaskDetailQueries {
  return {
    async read(id) {
      const { tasks, taskRepos, taskSpaceNodes } = tablesOf(db)
      const rows = await db
        .select({
          task: tasks,
        })
        .from(tasks)
        .where(eq(tasks.id, id))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      // RFC-066: hydrate per-repo metadata. Defensive fallback when task_repos is
      // empty (legacy rows that landed before migration 0034 backfill, or the
      // ultra-rare mid-migration crash): synthesize a single repo entry from the
      // legacy `tasks.*` mirror columns so callers always see at least one entry.
      const repoRows = await db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, id))
        .orderBy(asc(taskRepos.repoIndex))
      const frozenNodeRows = await db
        .select({ path: taskSpaceNodes.nodePath })
        .from(taskSpaceNodes)
        .where(eq(taskSpaceNodes.taskId, id))
      const repository = projectStoredTaskRepositorySurface(
        row.task,
        repoRows.map(decodeTaskRepositoryMount),
        frozenNodeRows.map((node) => node.path),
      )
      const parsedTriggerContext = parseTriggerContextJson(row.task.triggerContextJson)
      const webhookSourceLink =
        parsedTriggerContext.kind === 'ok'
          ? webhookTaskSourceLinkOf(parsedTriggerContext.value)
          : null
      const definition = (
        await new DatabaseTaskSubjectQueries(db).taskDefinitionProjection([id])
      ).get(id)
      if (definition === undefined) return null
      const task = rowToTask(row.task, definition.workflowName, repository, webhookSourceLink)

      return { task, definitionOrigin: definition.origin }
    },
  }
}

function rowToTask(
  row: PersistenceTables['tasks']['$inferSelect'],
  workflowName: string | null,
  repository: ReturnType<typeof projectStoredTaskRepositorySurface>,
  webhookSourceLink: WebhookTaskSourceLink | null,
): Task {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.workflowSnapshot)
  } catch {
    snapshot = null
  }
  let inputs: Record<string, string> = {}
  try {
    inputs = JSON.parse(row.inputs) as Record<string, string>
  } catch {
    inputs = {}
  }
  return {
    id: row.id,
    name: row.name, // RFC-037
    ...projectTaskSubject(decodeTaskSubject(row), workflowName),
    workflowSnapshot: snapshot,
    workflowVersion: taskSubjectWorkflowVersion(
      decodeTaskSubject(row),
      row.workflowVersion ?? null,
    ), // RFC-109

    repoPath: repository.repoPath,
    repoUrl: repository.repoUrl,
    cachedRepoId: repository.cachedRepoId,
    worktreePath: repository.worktreePath,
    workspaceState:
      row.workspacePrunedAt !== null
        ? 'pruned'
        : row.workspacePruningAt !== null
          ? 'pruning'
          : 'available',
    baseBranch: repository.baseBranch,
    branch: repository.branch,
    baseCommit: repository.baseCommit,
    status: row.status,
    inputs,
    maxDurationMs: row.maxDurationMs,
    maxTotalTokens: row.maxTotalTokens,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    errorMessage: row.errorMessage,
    failedNodeId: row.failedNodeId,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    schemaVersion: row.schemaVersion,
    // RFC-067: per-task Git commit identity (NULL = no override → daemon default).
    gitUserName: row.gitUserName ?? null,
    gitUserEmail: row.gitUserEmail ?? null,
    // RFC-075: working branch (NULL → isolation branch) + auto commit&push.
    workingBranch: repository.workingBranch,
    autoCommitPush: row.autoCommitPush,
    repoCount: repository.repoCount,
    // RFC-248: 组溯源。名字是快照——组删掉后详情页仍渲染名字（设计门 G5）。
    repoGroupId: repository.repoGroupId,
    repoGroupName: repository.repoGroupName,
    // RFC-159: link back to the scheduled_tasks row that launched this (NULL = manual).
    scheduledTaskId: row.scheduledTaskId ?? null,
    workgroupId: row.workgroupId ?? null,
    // RFC-164/RFC-223: frozen group name from the task's own config (same
    // source as rowToSummary) is display-only; the detail page links by the
    // frozen workgroupId instead of leaking the `__workgroup_host__` anchor.
    // NULL for non-groups.
    workgroupName: taskWorkgroupConfigFromRow(row).launch.workgroupName,
    // RFC-175 (§2): frozen goal from the task's own config (same task-scoped,
    // RFC-099-safe source as workgroupName). NULL for non-groups. Powers relaunch.
    goal: taskWorkgroupConfigFromRow(row).launch.goal,
    // RFC-165: execution-space kind + single-agent soft link.
    spaceKind: row.spaceKind,
    // RFC-243: parent linkage for node-invoked child executions.
    parentTaskId: row.parentTaskId ?? null,
    parentNodeRunId: row.parentNodeRunId ?? null,
    invocationDepth: row.invocationDepth ?? 0,
    sourceAgentName: row.sourceAgentName ?? null,
    // RFC-304: code-capability round link — the subject discriminator, so it
    // must reach both the detail and the list projections.
    codeRoundId: row.codeRoundId ?? null,
    // RFC-310: task-owned soft provenance avoids a live cross-context join and
    // survives a direct/reloaded TaskEngine detail URL.
    digitalEmployeeCaseId: row.digitalEmployeeCaseId ?? null,
    // RFC-175 (§2e): stable agent id (NULL for non-agent + pre-0091 tasks).
    sourceAgentId: row.sourceAgentId ?? null,
    // RFC-298: getTask derives this from the frozen context before entering
    // the generic row mapper. Never expose or parse the frozen source JSON here.
    webhookSourceLink,
    repos: repository.repos,
    spaceNodes: repository.spaceNodes,
  }
}
