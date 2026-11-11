import type {
  TaskDriveReceipt,
  TaskDriveSubmission,
} from '@/modules/task-execution/application/drive/taskDriveTypes'
import type { TaskDriveCoordinator } from '@/modules/task-execution/application/drive/taskDriveTypes'

export interface RecordingTaskDriveCoordinator {
  readonly coordinator: TaskDriveCoordinator
  readonly submissions: TaskDriveSubmission[]
}

export function createRecordingTaskDriveCoordinator(
  receipt: (input: TaskDriveSubmission) => TaskDriveReceipt = (input) => ({
    kind: 'accepted',
    taskId: input.taskId,
  }),
): RecordingTaskDriveCoordinator {
  const submissions: TaskDriveSubmission[] = []
  return {
    submissions,
    coordinator: {
      async submit(input) {
        submissions.push(input)
        return receipt(input)
      },
    },
  }
}

export function createNoopTaskDriveCoordinator(): TaskDriveCoordinator {
  return {
    async submit(input) {
      return { kind: 'not-attached', taskId: input.taskId }
    },
  }
}

export function createPoisonTaskDriveCoordinator(
  label = 'unexpected task drive coordinator call',
): TaskDriveCoordinator {
  return {
    async submit() {
      throw new TypeError(label)
    },
  }
}
