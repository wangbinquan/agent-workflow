import type { Actor } from '@/auth/actor'
import type {
  EventAutomationDelegatedContext,
  EventAutomationOriginBindingPort,
  TaskAutomationTargetV1,
  TaskAutomationWorkStartV1,
  TaskAutomationWorkStartPort,
} from '@/modules/event-center/composition/required-ports'
import type {
  TaskExecutionResourceAuthority,
  TaskExecutionResourceBinding,
} from '../ports/taskExecutionResourceSnapshots'
import type { ExecutionInvoker } from '../../public/commands'

/** TaskExecution-owned adapter over the selected provider's one launch participant. */
export function createTaskAutomationWorkStartProvider(input: {
  readonly receiptFor: (eventDeliveryId: string) => Promise<string | null>
  readonly origins: EventAutomationOriginBindingPort
  readonly contexts: Readonly<{
    resolve(context: EventAutomationDelegatedContext<'task-automation-work-start.v1'>): Readonly<{
      actor: Actor
      authority: TaskExecutionResourceAuthority['authority']
    }>
  }>
  readonly resources: TaskExecutionResourceBinding
  readonly launch: (request: {
    readonly actor: Actor
    readonly target: TaskAutomationTargetV1
    readonly invoker: ExecutionInvoker
    readonly resources: TaskExecutionResourceAuthority
  }) => Promise<{ readonly taskId: string }>
}): TaskAutomationWorkStartPort {
  return Object.freeze({
    async start(
      context: EventAutomationDelegatedContext<'task-automation-work-start.v1'>,
      request: TaskAutomationWorkStartV1,
    ) {
      if (context.portId !== 'task-automation-work-start.v1' || request.version !== 1) {
        throw new Error('task-automation-work-start-contract-mismatch')
      }
      const origin = await input.origins.resolve(context.origin, context.portId)
      if (origin === null) throw new Error('task-automation-origin-not-found')
      const existing = await input.receiptFor(origin.eventDeliveryId)
      if (existing !== null) return { taskId: existing }

      const admitted = input.contexts.resolve(context)
      const resources = Object.freeze({
        authority: admitted.authority,
        actor: admitted.actor,
        resources: input.resources,
      })
      try {
        return await input.launch({
          actor: admitted.actor,
          target: request.target,
          invoker: {
            type: 'event',
            eventSubscriptionId: origin.eventSubscriptionId,
            eventDeliveryId: origin.eventDeliveryId,
            triggerContext: request.trigger,
          },
          resources,
        })
      } catch (error) {
        // The domain uniqueness constraint is the concurrency linearization
        // point. Adopt the winner after any failed insert/commit attempt.
        const adopted = await input.receiptFor(origin.eventDeliveryId)
        if (adopted !== null) return { taskId: adopted }
        throw error
      }
    },
  })
}
