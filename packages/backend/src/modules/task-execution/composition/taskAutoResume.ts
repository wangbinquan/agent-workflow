import { autoResumeInterruptedTasks } from '@/services/autoResume'
import type {
  RepositoryPreparationRetryCommand,
  TaskAutoResumeCommand,
} from '../application/ports/taskAutoResumeCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'

export function composeTaskAutoResumeCommand(input: {
  readonly recovery: TaskRecoveryOperations
  readonly resume: Readonly<{ resume(taskId: string): Promise<void> }>
  readonly repositoryPreparation: RepositoryPreparationRetryCommand
}): TaskAutoResumeCommand {
  return Object.freeze({
    async run(command: Parameters<TaskAutoResumeCommand['run']>[0]) {
      return await autoResumeInterruptedTasks({
        operations: input.recovery,
        breaker: command.breaker,
        resume: (taskId) => input.resume.resume(taskId),
        retryRepoPrep: (taskId) => input.repositoryPreparation.retry(taskId),
      })
    },
  })
}
