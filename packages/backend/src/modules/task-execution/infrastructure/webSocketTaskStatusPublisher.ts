import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import type { TaskStatusPublisher } from '../application/ports/taskExecutionTopology'

export function createWebSocketTaskStatusPublisher(): TaskStatusPublisher {
  return {
    publish(event) {
      tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
        type: 'task.status',
        taskId: event.taskId,
        status: event.status,
      })
      taskBroadcaster.broadcast(TASK_CHANNEL(event.taskId), {
        id: -1,
        type: 'task.status',
        status: event.status,
        ...(event.errorSummary !== null ? { errorSummary: event.errorSummary } : {}),
      })
      if (
        event.status === 'done' ||
        event.status === 'failed' ||
        event.status === 'canceled' ||
        event.status === 'interrupted'
      ) {
        taskBroadcaster.broadcast(TASK_CHANNEL(event.taskId), {
          id: -1,
          type: 'task.done',
          status: event.status,
        })
      }
      for (const run of event.canceledNodeRuns) {
        taskBroadcaster.broadcast(TASK_CHANNEL(event.taskId), {
          id: -1,
          type: 'node.status',
          nodeRunId: run.id,
          nodeId: run.nodeId,
          status: 'canceled',
        })
      }
    },
  }
}
