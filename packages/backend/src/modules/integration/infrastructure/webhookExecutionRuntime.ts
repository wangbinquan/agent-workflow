import type {
  ExecutionInvoker,
  TaskExecutionResourceAuthority,
} from '@/modules/task-execution/public/commands'
import type { WebhookDispatchDeps } from '@/services/webhook/webhookDispatch'
import type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'
import type { DigitalEmployeeWorkStartPort } from '../public/participants'

export interface WebhookExecutionRuntimeDependencies {
  readonly taskExecutions: WebhookTaskExecutionParticipant<
    TaskExecutionResourceAuthority,
    ExecutionInvoker
  >
  readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort | null
}

/** Provider-neutral dispatch runtime shared by the explicit SQLite and PostgreSQL compositions. */
export function createWebhookExecutionRuntime(
  dependencies: WebhookExecutionRuntimeDependencies,
): Pick<WebhookDispatchDeps, 'launch' | 'cancel'> {
  return Object.freeze({
    cancel: (taskId: string) => dependencies.taskExecutions.cancel(taskId),
    async launch(actor, rendered, invoker, resources, guard) {
      if (rendered.kind === 'digital-employee') {
        if (dependencies.digitalEmployeeWorkStart === null || invoker.type !== 'event') {
          throw new Error('digital employee webhook work-start requires Event Center delivery')
        }
        return {
          kind: 'digital-employee' as const,
          ...(await dependencies.digitalEmployeeWorkStart.launch({
            employeeId: rendered.refId,
            intake: {
              ...rendered.intake,
              idempotencyKey: `event-delivery:${invoker.eventDeliveryId}`,
            },
            actorUserId: actor.user.id,
            origin: {
              eventSubscriptionId: invoker.eventSubscriptionId,
              eventDeliveryId: invoker.eventDeliveryId,
            },
          })),
        }
      }

      await guard?.verifyCanCommit()
      const receipt = await dependencies.taskExecutions.launch({
        actor,
        target: rendered,
        invoker,
        resources,
        ...(guard === undefined ? {} : { guard }),
      })
      return { kind: 'orchestration' as const, taskId: receipt.taskId }
    },
  })
}
