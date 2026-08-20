export interface EventCenterProjectionInvalidated {
  readonly projection: 'catalog' | 'subscriptions' | 'deliveries' | 'observers'
  readonly subscriberRef: string | null
  readonly revision: number
}
