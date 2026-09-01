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
import type { TaskLifecycleWsProjection } from '../application/ports/taskLifecycleWsProjection'

export function createTaskLifecycleWsProjector(
  projection: TaskLifecycleWsProjection,
): CommittedEventConsumerDefinition {
  return {
    id: 'task-ws-projector',
    eventTypes: TASK_LIFECYCLE_COMMITTED_EVENT_TYPES,
    deliveryClass: 'ephemeral',
    settle: 'projection-attempted',
    async handle(value) {
      const event = decodeTaskLifecycleCommittedEvent(value)
      if (event.type === 'task.created.v1') {
        const task = await projection.findCreatedTask(event.payload.taskId)
        if (task === null) return
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'task.created',
          task,
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
