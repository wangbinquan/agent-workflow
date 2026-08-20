import type { ObserverHealthDocument } from './types'

export interface EventCenterQueryPort {
  catalogJson(): string
  subscriptionsJson(subscriberRef: string | null): string
  observerHealth(): readonly ObserverHealthDocument[]
}
