import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import type { CommittedEventConsumerDefinition } from '@/platform/events/committed/types'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import {
  decodeTaskLifecycleCommittedEvent,
  TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
} from '../domain/taskLifecycleCommittedEvent'

export function createTaskLifecycleWsProjector(db: DbClient): CommittedEventConsumerDefinition {
  return {
    id: 'task-ws-projector',
    eventTypes: TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
    deliveryClass: 'ephemeral',
    settle: 'projection-attempted',
    handle(value) {
      const event = decodeTaskLifecycleCommittedEvent(value)
      if (event.type === 'task.created.v1') {
        const row = db
          .select({ task: tasks, workflowName: workflows.name })
          .from(tasks)
          .innerJoin(workflows, eq(workflows.id, tasks.workflowId))
          .where(eq(tasks.id, event.payload.taskId))
          .get()
        if (row === undefined) return
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'task.created',
          task: {
            id: row.task.id,
            name: row.task.name,
            workflowId: row.task.workflowId,
            workflowName: row.workflowName,
            repoPath: row.task.repoPath,
            repoUrl: row.task.repoUrl,
            cachedRepoId: row.task.cachedRepoId,
            status: row.task.status,
            startedAt: row.task.startedAt,
            finishedAt: row.task.finishedAt,
            errorSummary: row.task.errorSummary,
            repoCount: row.task.repoCount,
            spaceKind: row.task.spaceKind,
            sourceAgentName: row.task.sourceAgentName,
          },
        })
        return
      }
      if (event.type === 'task.lifecycle-transitioned.v1') {
        const payload = event.payload
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'task.status',
          taskId: payload.taskId,
          status: payload.status,
        })
        taskBroadcaster.broadcast(TASK_CHANNEL(payload.taskId), {
          id: -1,
          type: 'task.status',
          status: payload.status,
          ...(payload.errorSummary === null ? {} : { errorSummary: payload.errorSummary }),
        })
        if (
          payload.status === 'done' ||
          payload.status === 'failed' ||
          payload.status === 'canceled' ||
          payload.status === 'interrupted'
        ) {
          taskBroadcaster.broadcast(TASK_CHANNEL(payload.taskId), {
            id: -1,
            type: 'task.done',
            status: payload.status,
          })
        }
        for (const node of payload.nodeChanges) {
          taskBroadcaster.broadcast(TASK_CHANNEL(payload.taskId), {
            id: -1,
            type: 'node.status',
            nodeRunId: node.nodeRunId,
            nodeId: node.nodeId,
            status: node.status,
          })
        }
        return
      }
      for (const node of event.payload.nodeChanges) {
        taskBroadcaster.broadcast(TASK_CHANNEL(event.payload.taskId), {
          id: -1,
          type: 'node.status',
          nodeRunId: node.nodeRunId,
          nodeId: node.nodeId,
          status: node.status,
        })
      }
    },
  }
}
