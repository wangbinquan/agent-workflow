import type {
  CodeHostEventType,
  WebhookDeliveryReason,
  WebhookDeliveryStatus,
} from '@agent-workflow/shared'

export type WebhookDeliveryInsertInput = Readonly<{
  endpointId: string
  eventUuid: string | null
  gitlabEventHeader?: string | null
  objectKind?: string | null
  eventType?: CodeHostEventType | null
  repoPath?: string | null
  streamHint?: string | null
  status: WebhookDeliveryStatus
  statusReason?: WebhookDeliveryReason | null
  bodyJson?: string | null
  replayedFromDeliveryId?: string | null
}>

export type WebhookDeliveryInsertReceipt =
  | Readonly<{ kind: 'inserted'; deliveryId: string }>
  | Readonly<{ kind: 'duplicate'; deliveryId: string; attemptCount: number }>

export type WebhookDeliveryRetention = Readonly<{
  bodyRetentionMs: number
  rowRetentionMs: number
}>

export interface WebhookDeliveryGcCursorV1 {
  readonly version: 1
  readonly phase: 'bodies' | 'rows'
  readonly bodyCutoff: number
  readonly rowCutoff: number
}

export interface WebhookDeliveryGcSliceReceipt {
  readonly done: boolean
  readonly cursor: WebhookDeliveryGcCursorV1
  readonly counters: { readonly bodiesCleared: number; readonly rowsDeleted: number }
}

export interface WebhookDeliveryPersistencePort {
  insert(input: WebhookDeliveryInsertInput): Promise<WebhookDeliveryInsertReceipt>
  mark(input: {
    readonly deliveryId: string
    readonly status: WebhookDeliveryStatus
    readonly reason?: WebhookDeliveryReason | null
  }): Promise<void>
  recoverInterrupted(): Promise<number>
  gcSlice(input: {
    readonly now: number
    readonly retention: WebhookDeliveryRetention
    readonly cursor: WebhookDeliveryGcCursorV1 | null
    readonly batchSize: number
  }): Promise<WebhookDeliveryGcSliceReceipt>
  touchEndpointLastDelivery(endpointId: string, now: number): Promise<void>
}
