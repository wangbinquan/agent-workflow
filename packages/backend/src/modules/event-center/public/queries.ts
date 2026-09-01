import type {
  EventDeliveryStatusDocument,
  EventDeliveryStatusPageDocument,
  EventRecordAuditPageDocument,
  ObserverHealthDocument,
} from './types'

export interface EventCenterCatalogQueryPort {
  catalogJson(): Promise<string>
  subscriptionsJson(subscriberRef: string | null): Promise<string>
  subscriptionPageJson(input: {
    readonly page: number
    readonly limit: number
    readonly subscriberRef: string | null
  }): Promise<string>
}

export interface EventCenterOperationsQueryPort {
  deliveryStatuses(): Promise<readonly EventDeliveryStatusDocument[]>
  deliveryStatusPage(input: {
    readonly page: number
    readonly limit: number
    readonly state: EventDeliveryStatusDocument['state'] | null
    readonly subscriberRef: string | null
  }): Promise<EventDeliveryStatusPageDocument>
  eventRecordPage(input: {
    readonly page: number
    readonly limit: number
    readonly sourceId: string | null
  }): Promise<EventRecordAuditPageDocument>
  observerHealth(): Promise<readonly ObserverHealthDocument[]>
}
