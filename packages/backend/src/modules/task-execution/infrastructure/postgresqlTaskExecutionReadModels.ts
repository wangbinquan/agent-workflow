// RFC-349 — PostgreSQL implementation of the provider-neutral task-execution
// read models. Consumers keep the same Promise contracts and never receive a
// provider client; bootstrap selects this adapter for a PostgreSQL generation.

import { isWorkgroupTask } from '@agent-workflow/shared'
import { and, asc, desc, eq } from 'drizzle-orm'

import {
  docVersions,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskRepos,
  tasks,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import type {
  ReviewGateSubjectReadModel,
  TaskCallGraphWorkspaceReadModel,
  TaskExecutionReadModels,
  TaskReviewNodeCatalogReadModel,
  TaskSessionEventSource,
  TaskStatusProjectionReadModel,
} from '@/modules/task-execution/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function createPostgresqlTaskExecutionReadModels(
  db: PostgresqlDatabaseClient,
): TaskExecutionReadModels {
  const statusProjection: TaskStatusProjectionReadModel = {
    async find(taskId) {
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
      const taskRows = await db
        .select({ taskId: tasks.id, worktreePath: tasks.worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return null

      const repoRows = await db
        .select({
          worktreeDirName: taskRepos.worktreeDirName,
          worktreePath: taskRepos.worktreePath,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.repoIndex))

      return {
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        repos:
          repoRows.length > 0
            ? repoRows
            : [{ worktreeDirName: '', worktreePath: task.worktreePath }],
      }
    },
  }

  const taskReviewNodes: TaskReviewNodeCatalogReadModel = {
    async find(taskId) {
      const rows = await db
        .select({
          taskId: tasks.id,
          taskOwnerUserId: tasks.ownerUserId,
          workflowSnapshot: tasks.workflowSnapshot,
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
      const task = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      if (task[0] === undefined) return { taskExists: false, nodeRun: null }
      const runs = await db
        .select({
          taskId: nodeRuns.taskId,
          startupVerificationJson: nodeRuns.startupVerificationJson,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return { taskExists: true, nodeRun: runs[0] ?? null }
    },
  }

  const executionOutcome = {
    async find(taskId: string) {
      const taskRows = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
          errorMessage: tasks.errorMessage,
          failedNodeId: tasks.failedNodeId,
          workflowSnapshot: tasks.workflowSnapshot,
          workgroupId: tasks.workgroupId,
          workgroupConfigJson: tasks.workgroupConfigJson,
          sourceAgentName: tasks.sourceAgentName,
          codeRoundId: tasks.codeRoundId,
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
      if (isWorkgroupTask(task)) {
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
          ? await db
              .select({
                id: nodeRuns.id,
                nodeId: nodeRuns.nodeId,
                iteration: nodeRuns.iteration,
                parentNodeRunId: nodeRuns.parentNodeRunId,
                status: nodeRuns.status,
              })
              .from(nodeRuns)
              .where(eq(nodeRuns.taskId, taskId))
          : []
      const outputs =
        task.status === 'done'
          ? await db
              .select({
                nodeRunId: nodeRunOutputs.nodeRunId,
                portName: nodeRunOutputs.portName,
                content: nodeRunOutputs.content,
                kind: nodeRunOutputs.kind,
                archiveJson: nodeRunOutputs.archiveJson,
                active: nodeRunOutputs.active,
              })
              .from(nodeRunOutputs)
              .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
              .where(eq(nodeRuns.taskId, taskId))
          : []
      return { task, runs, outputs, workgroup }
    },
  }

  const runtimeInventory = {
    async find(taskId: string, nodeRunId: string) {
      const taskRows = await db
        .select({ workflowSnapshot: tasks.workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) {
        return { taskExists: false, workflowSnapshot: null, nodeRun: null }
      }
      const runRows = await db
        .select({
          taskId: nodeRuns.taskId,
          nodeId: nodeRuns.nodeId,
          status: nodeRuns.status,
          runtime: nodeRuns.runtime,
          runtimeInventoryJson: nodeRuns.runtimeInventoryJson,
          startupVerificationJson: nodeRuns.startupVerificationJson,
          inventorySnapshotJson: nodeRuns.inventorySnapshotJson,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
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
      const taskRows = await db
        .select({
          taskId: tasks.id,
          ownerUserId: tasks.ownerUserId,
          worktreePath: tasks.worktreePath,
          repoCount: tasks.repoCount,
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
          content: nodeRunOutputs.content,
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

      let legacyRepoDirName = ''
      if (task.repoCount > 1) {
        const repoRows = await db
          .select({ worktreeDirName: taskRepos.worktreeDirName })
          .from(taskRepos)
          .where(eq(taskRepos.taskId, input.taskId))
          .orderBy(asc(taskRepos.repoIndex))
          .limit(1)
        legacyRepoDirName = repoRows[0]?.worktreeDirName ?? ''
      }
      return {
        status: 'found' as const,
        artifact: {
          taskId: task.taskId,
          worktreePath: task.worktreePath,
          archiveJson: output.archiveJson,
          content: output.content,
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
      const taskRows = await db
        .select({ workflowSnapshot: tasks.workflowSnapshot })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return { status: 'task-not-found' as const }

      const runColumns = {
        id: nodeRuns.id,
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        promptText: nodeRuns.promptText,
        promptPath: nodeRuns.promptPath,
        startedAt: nodeRuns.startedAt,
        opencodeSessionId: nodeRuns.opencodeSessionId,
        retryIndex: nodeRuns.retryIndex,
      }
      const runRows = await db
        .select(runColumns)
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const run = runRows[0]
      if (run === undefined || run.taskId !== input.taskId) {
        return { status: 'node-run-not-found' as const }
      }

      const siblings =
        run.opencodeSessionId === null
          ? [run]
          : await db
              .select(runColumns)
              .from(nodeRuns)
              .where(
                and(
                  eq(nodeRuns.taskId, input.taskId),
                  eq(nodeRuns.opencodeSessionId, run.opencodeSessionId),
                ),
              )
              .orderBy(asc(nodeRuns.id))
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
