import type { TriggerContext } from '@agent-workflow/shared'

import type {
  CodeHostEventResponseDefinition,
  CodeHostWebhookRoutingFacts,
} from '../../domain/codeHostWebhookEvent'

export interface CodeHostEventResponseDirectoryPort {
  list(): Promise<readonly CodeHostEventResponseDefinition[]>
  matching(facts: CodeHostWebhookRoutingFacts): Promise<readonly CodeHostEventResponseDefinition[]>
  has(ruleId: string): Promise<boolean>
}

export interface CodeHostEventWorkStartPort {
  dispatch(input: {
    readonly deliveryId: string
    readonly eventDeliveryId: string
    readonly eventSubscriptionId: string
    readonly triggerId: string
    readonly triggerContext: TriggerContext
  }): Promise<void>
}

/** Optional owner adapter for code-host events that resume existing work. */
export interface CodeHostEventContinuationPort {
  match(input: {
    readonly provider: string
    readonly repoPath: string
    readonly mrIid: string
  }): Promise<{
    readonly continuationRef: string
    readonly definitionRevision: string
    readonly displayName: { readonly 'zh-CN': string; readonly 'en-US': string }
  } | null>
  consume(input: {
    readonly continuationRef: string
    readonly eventDeliveryId: string
    readonly occurredAt: number
  }): Promise<void>
}
