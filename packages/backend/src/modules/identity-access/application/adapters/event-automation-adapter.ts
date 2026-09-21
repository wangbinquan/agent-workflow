import type { Actor } from '@/auth/actor'
import type {
  EventAutomationDelegatedContext,
  EventAutomationDelegatedContextFactory,
  EventAutomationPortId,
} from '@/modules/event-center/composition/required-ports'
import type { DelegatedRequestAuthorityFactory, RequestAuthority } from '../../public/participants'

/** IA-owned mint/resolve pair; EC sees only the factory half. */
export function createEventAutomationDelegatedContextBinding(
  delegatedRequests: DelegatedRequestAuthorityFactory,
): Readonly<{
  factory: EventAutomationDelegatedContextFactory
  resolve(
    context: EventAutomationDelegatedContext<EventAutomationPortId>,
  ): Readonly<{ actor: Actor; authority: RequestAuthority }>
}> {
  const admissions = new WeakMap<object, Readonly<{ actor: Actor; authority: RequestAuthority }>>()
  const factory: EventAutomationDelegatedContextFactory = Object.freeze({
    async create<TPort extends EventAutomationPortId>(input: {
      readonly ownerUserId: string
      readonly origin: Parameters<EventAutomationDelegatedContextFactory['create']>[0]['origin']
      readonly portId: TPort
    }): Promise<EventAutomationDelegatedContext<TPort> | null> {
      const admitted = await delegatedRequests.forEventAutomation(input)
      if (admitted === null) return null
      const context = Object.freeze({
        ...admitted.context,
        portId: input.portId,
        origin: input.origin,
      }) as EventAutomationDelegatedContext<TPort>
      admissions.set(
        context,
        Object.freeze({ actor: admitted.actor as Actor, authority: admitted.authority }),
      )
      return context
    },
  })
  return Object.freeze({
    factory,
    resolve(context: EventAutomationDelegatedContext<EventAutomationPortId>) {
      const admitted = admissions.get(context)
      if (admitted === undefined) throw new Error('foreign-event-automation-context')
      return admitted
    },
  })
}
