import type { Actor } from '@/auth/actor'
import type {
  EmployeeAutomationWorkStartV1,
  EmployeeAutomationWorkStartPort,
  EventAutomationDelegatedContext,
  EventAutomationOriginBindingPort,
} from '@/modules/event-center/composition/required-ports'

/** DigitalEmployee-owned adapter over the existing Case queue/admission writer. */
export function createEmployeeAutomationWorkStartProvider(input: {
  readonly receiptFor: (eventDeliveryId: string) => Promise<string | null>
  readonly origins: EventAutomationOriginBindingPort
  readonly contexts: Readonly<{
    resolve(
      context: EventAutomationDelegatedContext<'employee-automation-work-start.v1'>,
    ): Readonly<{ actor: Actor }>
  }>
  readonly launchWork: (request: {
    readonly employeeId: string
    readonly intake: {
      readonly kind: 'body' | 'external-id'
      readonly target: Readonly<Record<string, string>>
      readonly body: string | null
      readonly externalId: string | null
      readonly uploads: readonly []
      readonly idempotencyKey: string
    }
    readonly actorUserId: string
    readonly origin: {
      readonly eventSubscriptionId: string
      readonly eventDeliveryId: string
    }
  }) => Promise<{ readonly caseId: string }>
}): EmployeeAutomationWorkStartPort {
  return Object.freeze({
    async start(
      context: EventAutomationDelegatedContext<'employee-automation-work-start.v1'>,
      request: EmployeeAutomationWorkStartV1,
    ) {
      if (context.portId !== 'employee-automation-work-start.v1' || request.version !== 1) {
        throw new Error('employee-automation-work-start-contract-mismatch')
      }
      const origin = await input.origins.resolve(context.origin, context.portId)
      if (origin === null) throw new Error('employee-automation-origin-not-found')
      const existing = await input.receiptFor(origin.eventDeliveryId)
      if (existing !== null) return { caseId: existing }

      const admitted = input.contexts.resolve(context)
      try {
        return await input.launchWork({
          employeeId: request.employeeId,
          intake: {
            ...request.intake,
            idempotencyKey: `event-delivery:${origin.eventDeliveryId}`,
          },
          actorUserId: admitted.actor.user.id,
          origin,
        })
      } catch (error) {
        const adopted = await input.receiptFor(origin.eventDeliveryId)
        if (adopted !== null) return { caseId: adopted }
        throw error
      }
    },
  })
}
