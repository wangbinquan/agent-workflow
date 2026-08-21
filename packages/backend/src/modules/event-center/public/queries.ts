import type {
  EventDeliveryStatusDocument,
  EventDeliveryStatusPageDocument,
  EventRecordAuditPageDocument,
  ObserverHealthDocument,
} from './types'

export interface EventCenterCatalogQueryPort {
  catalogJson(): string
  subscriptionsJson(subscriberRef: string | null): string
  subscriptionPageJson(input: {
    readonly page: number
    readonly limit: number
    readonly subscriberRef: string | null
  }): string
}

export interface EventCenterOperationsQueryPort {
  deliveryStatuses(): readonly EventDeliveryStatusDocument[]
  deliveryStatusPage(input: {
    readonly page: number
    readonly limit: number
    readonly state: EventDeliveryStatusDocument['state'] | null
    readonly subscriberRef: string | null
  }): EventDeliveryStatusPageDocument
  eventRecordPage(input: {
    readonly page: number
    readonly limit: number
    readonly sourceId: string | null
  }): EventRecordAuditPageDocument
  observerHealth(): readonly ObserverHealthDocument[]
}
