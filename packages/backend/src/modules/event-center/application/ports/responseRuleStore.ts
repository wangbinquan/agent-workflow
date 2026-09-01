import type { EventObservation } from '../../domain/model'
import type { EventResponseRuleDraft, EventResponseRuleRecord } from '../../domain/responseRule'

export interface EventResponseRuleStorePort {
  list(): Promise<readonly EventResponseRuleRecord[]>
  get(id: string): Promise<EventResponseRuleRecord | null>
  matching(observation: EventObservation): Promise<readonly EventResponseRuleRecord[]>
  create(input: {
    readonly id: string
    readonly ownerUserId: string
    readonly sourceRef: { readonly id: string; readonly revision: number }
    readonly subjectTypeId: string
    readonly draft: EventResponseRuleDraft
    readonly now: number
  }): Promise<EventResponseRuleRecord>
  update(input: {
    readonly id: string
    readonly sourceRef: { readonly id: string; readonly revision: number }
    readonly subjectTypeId: string
    readonly draft: EventResponseRuleDraft
    readonly now: number
  }): Promise<EventResponseRuleRecord | null>
  remove(id: string): Promise<boolean>
  recordResult(input: {
    readonly id: string
    readonly state: 'launched' | 'failed'
    readonly error: string | null
    readonly now: number
  }): Promise<void>
}
