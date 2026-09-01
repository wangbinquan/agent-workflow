import type { SecretBox } from '../../src/auth/secretBox'
import type { DbClient } from '../../src/db/client'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import { composeSqliteAgentLaunchResourceOperations } from '../../src/modules/task-execution/composition/agentLaunchResources'
import { composeSqliteAgentResourceIntegrity } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeSqliteResourceCatalog } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import type { WebhookTaskExecutionParticipant } from '../../src/modules/integration/composition/webhookDispatch'
import type { TaskExecutionResourceAuthority } from '../../src/services/execution/taskExecutionResources'
import type { ExecutionInvoker } from '../../src/services/execution/types'
import { cancelExecution, startExecution } from '../../src/services/execution/executor'
import { buildStartTaskDeps } from '../../src/services/startTaskDeps'
import type { StartTaskDeps } from '../../src/services/task'

/** SQLite test composition for Integration's closed TaskExecution participant. */
export function createSqliteWebhookTaskExecutionParticipant(input: {
  readonly db: DbClient
  readonly configPath: string
  readonly secretBox: SecretBox
  readonly schedulerDriver: SchedulerDriverPort
  readonly identityAccess: NonNullable<StartTaskDeps['identityAccess']>
}): WebhookTaskExecutionParticipant<TaskExecutionResourceAuthority, ExecutionInvoker> {
  const resourceCatalog = composeSqliteResourceCatalog({ db: input.db })
  const agentLaunchResources = Object.freeze({
    resources: composeSqliteAgentLaunchResourceOperations(input.db),
    integrity: composeSqliteAgentResourceIntegrity({
      db: input.db,
      authorization: resourceCatalog.authorization,
    }).launch,
  })

  const participant: WebhookTaskExecutionParticipant<
    TaskExecutionResourceAuthority,
    ExecutionInvoker
  > = {
    async launch(request) {
      const { actor, target, invoker, resources, guard } = request
      const dependencies = {
        ...buildStartTaskDeps(
          input.db,
          input.schedulerDriver,
          input.configPath,
          actor.user.id,
          input.secretBox,
          input.identityAccess,
        ),
        launchResources: resources,
        agentLaunchResources,
        deferRepoPreparation: true,
        ...(guard === undefined
          ? {}
          : {
              sourceTerminationLaunchSignal: guard.signal,
              sourceTerminationAdmission: guard.assertCanCommit,
            }),
      }
      const task = await startExecution(
        input.db,
        actor,
        target.kind === 'agent'
          ? { kind: 'agent', refId: target.refId, invoker, payload: target.payload }
          : target.kind === 'workgroup'
            ? { kind: 'workgroup', refId: target.refId, invoker, payload: target.payload }
            : { kind: 'workflow', refId: target.refId, invoker, payload: target.payload },
        dependencies,
      )
      return { taskId: task.id }
    },
    cancel: (taskId: string) => cancelExecution(input.db, taskId),
  }
  return Object.freeze(participant)
}
