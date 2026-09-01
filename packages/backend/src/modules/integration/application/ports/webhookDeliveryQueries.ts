import type { CodeHostEventType, WebhookDeliveryStatus } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'

export interface WebhookDeliveryRecord {
  readonly id: string
  readonly endpointId: string
  readonly eventUuid: string | null
  readonly attemptCount: number
  readonly gitlabEventHeader: string | null
  readonly objectKind: string | null
  readonly eventType: string | null
  readonly repoPath: string | null
  readonly streamHint: string | null
  readonly mrFactKey: string | null
  readonly mrStreamKey: string | null
  readonly mrStreamRevision: number | null
  readonly mrStateAfter: 'open' | 'closed' | 'merged' | null
  readonly status: WebhookDeliveryStatus
  readonly statusReason: string | null
  readonly replayedFromDeliveryId: string | null
  readonly receivedAt: number
  readonly bodyJson: string | null
}

export type WebhookDeliveryListRecord = Omit<
  WebhookDeliveryRecord,
  'bodyJson' | 'mrFactKey' | 'mrStreamKey' | 'mrStreamRevision' | 'mrStateAfter'
>

export interface WebhookDeliveryPage {
  readonly items: readonly WebhookDeliveryListRecord[]
  readonly total: number
  readonly page: number
  readonly pageCount: number
}

export interface WebhookTerminalControlProjection {
  readonly kind: string
  readonly observedEventType: string
  readonly status: string
  readonly revision: number
  readonly attemptCount: number
  readonly lastError: string | null
  readonly totalTargetCount: number
  readonly hiddenTargetCount: number
  readonly targets: readonly Readonly<{
    taskId: string
    priorStatus: string
    currentStatus: string
    fenceOutcome: string
    cancelOutcome: string | null
    releaseOutcome: string | null
    error: string | null
    workspace: Readonly<{
      spaceKind: string
      state: 'pruned' | 'pruning' | 'retained'
    }>
  }>[]
}

export interface WebhookDeliveryQueries {
  page(input: {
    readonly page: number
    readonly limit: number
    readonly endpointId?: string
    readonly status?: WebhookDeliveryStatus
    readonly eventType?: CodeHostEventType
    readonly repoPath?: string
  }): Promise<WebhookDeliveryPage>
  listRepoPaths(): Promise<readonly string[]>
  get(id: string): Promise<WebhookDeliveryRecord | null>
  terminalControl(
    deliveryId: string,
    actor: Actor,
  ): Promise<WebhookTerminalControlProjection | null>
  hasTerminalControlEffect(deliveryId: string): Promise<boolean>
}
