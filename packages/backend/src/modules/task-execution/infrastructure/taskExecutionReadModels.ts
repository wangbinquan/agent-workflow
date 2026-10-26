import { projectTaskMountReadRow } from './taskRepositorySql'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import { readDatabaseContent } from '@/platform/content/infrastructure/contentStore'
import { createNodeRunQueries } from './nodeRunQueries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskMountReadColumns, taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B1 —— task-execution 读模型：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份只差客户端类型与同步 / 异步形态）。

import { portFallbackMount } from '@/platform/content/locations/portArchive'

import { and, asc, desc, eq } from 'drizzle-orm'
import { taskReadSubjectFromDefinition } from '../domain/taskSubject'
import { projectStoredTaskRepositorySurface } from './taskRepositorySurface'
import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type {
  ReviewGateSubjectReadModel,
  TaskCallGraphWorkspaceReadModel,
  TaskExecutionReadModels,
  TaskReviewNodeCatalogReadModel,
  TaskSessionEventSource,
  TaskStatusProjectionReadModel,
} from '@/modules/task-execution/public/types'

export function createTaskExecutionReadModels(
  db: PersistenceDb,
  content: Pick<ContentStore, 'read'> = { read: (ref) => readDatabaseContent(db, ref) },
): TaskExecutionReadModels {
  async function contentText(row: {
    contentRefJson: string
    contentInlineBytes: Uint8Array | null
  }): Promise<string> {
    const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
    if (!ref) throw new Error('node-output-content-missing')
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await content.read(ref))
  }
  const statusProjection: TaskStatusProjectionReadModel = {
    async find(taskId) {
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          taskId: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      return rows[0] ?? null
    },
  }

  const callGraphWorkspace: TaskCallGraphWorkspaceReadModel = {
    async find(taskId) {
      const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
      const taskRows = await db
        .select({ taskId: tasks.id, worktreePath: taskReadColumns(db).worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return null

      const repoRows = await db
        .select({
          mountPath: taskRepos.mountPath,
          workspaceRootRef: taskMountReadColumns(db).workspaceRootRef,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.ordinal))
        .then((rows) => rows.map(projectTaskMountReadRow))

      return {
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        repos:
          repoRows.length > 0
            ? repoRows
            : projectStoredTaskRepositorySurface(task).repos.map(({ mountPath, worktreePath }) => ({
                mountPath,
                worktreePath,
              })),
      }
    },
  }

  const taskReviewNodes: TaskReviewNodeCatalogReadModel = {
    async find(taskId) {
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          taskId: tasks.id,
          taskOwnerUserId: tasks.ownerUserId,
          workflowSnapshot: taskReadColumns(db).workflowSnapshot,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return null
      try {
        const parsed = JSON.parse(row.workflowSnapshot) as {
          nodes?: Array<Record<string, unknown>>
        }
        return {
          taskId: row.taskId,
          taskOwnerUserId: row.taskOwnerUserId,
          nodes: (parsed.nodes ?? [])
            .filter(
              (node): node is Record<string, unknown> & { id: string } =>
                node.kind === 'review' && typeof node.id === 'string' && node.id.length > 0,
            )
            .map((node) => ({
              reviewNodeId: node.id,
              title: typeof node.title === 'string' ? node.title : '',
              description: typeof node.description === 'string' ? node.description : '',
            })),
        }
      } catch {
        return { taskId: row.taskId, taskOwnerUserId: row.taskOwnerUserId, nodes: [] }
      }
    },
  }

  const reviewGateSubjects: ReviewGateSubjectReadModel = {
    async find(nodeRunId) {
      const { docVersions } = tablesOf(db)
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          nodeRunId: docVersions.reviewNodeRunId,
          taskId: docVersions.taskId,
          reviewNodeId: docVersions.reviewNodeId,
          taskOwnerUserId: tasks.ownerUserId,
        })
        .from(docVersions)
        .innerJoin(tasks, eq(tasks.id, docVersions.taskId))
        .where(eq(docVersions.reviewNodeRunId, nodeRunId))
        .limit(1)
      return rows[0] ?? null
    },
  }

  const startupVerification = {
    async find(taskId: string, nodeRunId: string) {
      const { tasks } = tablesOf(db)
      const task = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (task[0] === undefined) return { taskExists: false, nodeRun: null }
      const runs = await createNodeRunQueries(db, content).listHistoryFields(
        { runIds: [nodeRunId], limit: 1 },
        ['taskId', 'startupVerificationJson'],
      )
      return { taskExists: true, nodeRun: runs[0] ?? null }
    },
  }

  const executionOutcome = {
    async find(taskId: string) {
      const { workgroupMessages } = tablesOf(db)
      const { nodeRuns, nodeRunOutputs } = tablesOf(db)

      const { tasks, workgroupTaskState } = tablesOf(db)
      const taskRows = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
          errorMessage: tasks.errorMessage,
          failedNodeId: tasks.failedNodeId,
          workflowSnapshot: taskReadColumns(db).workflowSnapshot,
          workflowId: taskReadColumns(db).workflowId,
          subjectKind: taskReadColumns(db).subjectKind,
          sourceId: taskReadColumns(db).sourceId,
          sourceName: taskReadColumns(db).sourceName,
          workgroupId: taskReadColumns(db).workgroupId,
          workgroupConfig: taskWorkgroupConfigSelection(db),
          sourceAgentName: taskReadColumns(db).sourceAgentName,
          codeRoundId: taskReadColumns(db).codeRoundId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return null

      let workgroup: {
        gateSummary: string | null
        dwPhase: string | null
        resultMessageBody: string | null
      } | null = null
      if (taskReadSubjectFromDefinition(task).kind === 'workgroup') {
        const states = await db
          .select({
            gateSummary: workgroupTaskState.gateSummary,
            dwStateJson: workgroupTaskState.dwStateJson,
            resultMessageId: workgroupTaskState.resultMessageId,
          })
          .from(workgroupTaskState)
          .where(eq(workgroupTaskState.taskId, taskId))
          .limit(1)
        const state = states[0]
        let resultMessageBody: string | null = null
        if (state?.resultMessageId != null) {
          const messages = await db
            .select({ bodyMd: workgroupMessages.bodyMd })
            .from(workgroupMessages)
            .where(eq(workgroupMessages.id, state.resultMessageId))
            .limit(1)
          resultMessageBody = messages[0]?.bodyMd ?? null
        }
        let dwPhase: string | null = null
        if (state?.dwStateJson != null) {
          try {
            const value = JSON.parse(state.dwStateJson) as { phase?: unknown }
            dwPhase = typeof value.phase === 'string' ? value.phase : null
          } catch {
            dwPhase = null
          }
        }
        workgroup = {
          gateSummary: state?.gateSummary ?? null,
          dwPhase,
          resultMessageBody,
        }
      }

      const runs =
        task.status === 'done'
          ? await createNodeRunQueries(db, content).listHistoryFields({ taskId }, [
              'id',
              'seq',
              'nodeId',
              'iteration',
              'parentNodeRunId',
              'status',
            ])
          : []
      const outputRows =
        task.status === 'done'
          ? await db
              .select({
                nodeRunId: nodeRunOutputs.nodeRunId,
                portName: nodeRunOutputs.portName,
                contentRefJson: nodeRunOutputs.contentRefJson,
                contentInlineBytes: nodeRunOutputs.contentInlineBytes,
                kind: nodeRunOutputs.kind,
                archiveJson: nodeRunOutputs.archiveJson,
                active: nodeRunOutputs.active,
              })
              .from(nodeRunOutputs)
              .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
              .where(eq(nodeRuns.taskId, taskId))
          : []
      const outputs = await Promise.all(
        outputRows.map(async ({ contentRefJson, contentInlineBytes, ...row }) => ({
          ...row,
          content: await contentText({ contentRefJson, contentInlineBytes }),
        })),
      )
      return { task, runs, outputs, workgroup }
    },
  }

  const runtimeInventory = {
    async find(taskId: string, nodeRunId: string) {
      const { tasks } = tablesOf(db)
      const taskRows = await db
        .select({ workflowSnapshot: taskReadColumns(db).workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) {
        return { taskExists: false, workflowSnapshot: null, nodeRun: null }
      }
      const runRows = await createNodeRunQueries(db, content).listHistoryFields(
        { runIds: [nodeRunId], limit: 1 },
        [
          'taskId',
          'nodeId',
          'status',
          'runtime',
          'runtimeInventoryJson',
          'startupVerificationJson',
          'inventorySnapshotJson',
        ],
      )
      return {
        taskExists: true,
        workflowSnapshot: task.workflowSnapshot,
        nodeRun: runRows[0] ?? null,
      }
    },
  }

  const portArtifacts = {
    async find(input: {
      actor: { userId: string; canReadAllTasks: boolean }
      taskId: string
      nodeRunId: string
      portName: string
    }) {
      const { taskCollaborators } = tablesOf(db)
      const { nodeRuns, nodeRunOutputs } = tablesOf(db)

      const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
      const taskRows = await db
        .select({
          taskId: tasks.id,
          ownerUserId: tasks.ownerUserId,
          worktreePath: taskReadColumns(db).worktreePath,
        })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return { status: 'task-not-found' as const }

      if (!input.actor.canReadAllTasks && task.ownerUserId !== input.actor.userId) {
        const memberships = await db
          .select({ taskId: taskCollaborators.taskId })
          .from(taskCollaborators)
          .where(
            and(
              eq(taskCollaborators.taskId, input.taskId),
              eq(taskCollaborators.userId, input.actor.userId),
            ),
          )
          .limit(1)
        if (memberships[0] === undefined) return { status: 'task-not-found' as const }
      }

      const runRows = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.taskId)))
        .limit(1)
      if (runRows[0] === undefined) return { status: 'node-run-not-found' as const }

      const outputRows = await db
        .select({
          archiveJson: nodeRunOutputs.archiveJson,
          contentRefJson: nodeRunOutputs.contentRefJson,
          contentInlineBytes: nodeRunOutputs.contentInlineBytes,
          kind: nodeRunOutputs.kind,
        })
        .from(nodeRunOutputs)
        .where(
          and(
            eq(nodeRunOutputs.nodeRunId, input.nodeRunId),
            eq(nodeRunOutputs.portName, input.portName),
          ),
        )
        .limit(1)
      const output = outputRows[0]
      if (output === undefined) return { status: 'port-not-found' as const }

      const repoRows = await db
        .select({ mountPath: taskRepos.mountPath })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, input.taskId))
        .orderBy(asc(taskRepos.ordinal))
      const legacyRepoDirName = portFallbackMount(repoRows.map((repo) => repo.mountPath))
      return {
        status: 'found' as const,
        artifact: {
          taskId: task.taskId,
          worktreePath: task.worktreePath,
          archiveJson: output.archiveJson,
          content: await contentText(output),
          kind: output.kind,
          legacyRepoDirName,
        },
      }
    },
  }

  const sessions = {
    async find(input: {
      taskId: string
      nodeRunId: string
      rootPrefixCap: number
      tailCap: number
    }) {
      const { nodeRunEvents } = tablesOf(db)
      const { tasks } = tablesOf(db)
      const taskRows = await db
        .select({ workflowSnapshot: taskReadColumns(db).workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return { status: 'task-not-found' as const }

      const fields = [
        'id',
        'taskId',
        'nodeId',
        'promptText',
        'promptPath',
        'startedAt',
        'opencodeSessionId',
        'retryIndex',
      ] as const
      const queries = createNodeRunQueries(db, content)
      const run =
        (await queries.listHistoryFields({ runIds: [input.nodeRunId], limit: 1 }, fields))[0] ??
        null
      if (run === null || run.taskId !== input.taskId)
        return { status: 'node-run-not-found' as const }
      let siblings: readonly (typeof run)[] = [run]
      if (run.opencodeSessionId !== null) {
        // Restore NULL session ids from evidence without loading every prompt.
        const sessions = await queries.listHistoryFields({ taskId: input.taskId }, [
          'id',
          'opencodeSessionId',
        ])
        const siblingIds = sessions
          .filter((sibling) => sibling.opencodeSessionId === run.opencodeSessionId)
          .map((sibling) => sibling.id)
        siblings = await queries.listHistoryFields({ runIds: siblingIds, order: 'seq-asc' }, fields)
      }
      const lineage = siblings.length === 0 ? [run] : siblings
      const eventColumns = {
        id: nodeRunEvents.id,
        ts: nodeRunEvents.ts,
        kind: nodeRunEvents.kind,
        sessionId: nodeRunEvents.sessionId,
        parentSessionId: nodeRunEvents.parentSessionId,
        payload: nodeRunEvents.payload,
      }
      const byId = new Map<number, TaskSessionEventSource>()
      for (const sibling of lineage) {
        const [prefix, tail] = await Promise.all([
          db
            .select(eventColumns)
            .from(nodeRunEvents)
            .where(eq(nodeRunEvents.nodeRunId, sibling.id))
            .orderBy(asc(nodeRunEvents.id))
            .limit(input.rootPrefixCap),
          db
            .select(eventColumns)
            .from(nodeRunEvents)
            .where(eq(nodeRunEvents.nodeRunId, sibling.id))
            .orderBy(desc(nodeRunEvents.id))
            .limit(input.tailCap),
        ])
        for (const event of prefix) byId.set(event.id, event)
        for (const event of tail) byId.set(event.id, event)
      }
      const events = [...byId.values()].sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts - b.ts))
      return {
        status: 'found' as const,
        workflowSnapshot: task.workflowSnapshot,
        run,
        siblings: lineage,
        events,
      }
    },
  }

  return Object.freeze({
    statusProjection,
    callGraphWorkspace,
    taskReviewNodes,
    reviewGateSubjects,
    startupVerification,
    executionOutcome,
    runtimeInventory,
    portArtifacts,
    sessions,
  })
}
