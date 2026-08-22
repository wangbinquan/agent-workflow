import type { MeResponse } from '@/hooks/useActor'

export type EventAutomationRuleWritePermission =
  | 'event-automation-rules:create'
  | 'event-automation-rules:update'
  | 'event-automation-rules:delete'

export function canCreateEventAutomationRule(actor: MeResponse | null | undefined): boolean {
  return actor?.permissions.includes('event-automation-rules:create') === true
}

export function canWriteEventAutomationRule(
  actor: MeResponse | null | undefined,
  ownerUserId: string,
  permission: Exclude<EventAutomationRuleWritePermission, 'event-automation-rules:create'>,
): boolean {
  return (
    actor?.permissions.includes(permission) === true &&
    (actor.user.id === ownerUserId ||
      actor.permissions.includes('event-automation-rules:override-owner'))
  )
}
