import type {
  CustomEventSourceAuthoringRecord,
  CustomEventSourceDraft,
  CustomEventSourceValidationReceipt,
  PublishedCustomEventSource,
} from '../../domain/customEventSource'
import type { EventSourceDescriptor, EventTypeDescriptor } from '../../domain/model'

export interface CustomEventSourceStorePort {
  create(input: {
    readonly id: string
    readonly draft: CustomEventSourceDraft
    readonly ownerUserId: string | null
    readonly now: number
  }): Promise<CustomEventSourceAuthoringRecord>
  get(id: string): Promise<CustomEventSourceAuthoringRecord | null>
  list(): Promise<CustomEventSourceAuthoringRecord[]>
  update(input: {
    readonly id: string
    readonly draft: CustomEventSourceDraft
    readonly now: number
  }): Promise<CustomEventSourceAuthoringRecord | null>
  publish(input: {
    readonly id: string
    readonly revision: number
    readonly draft: CustomEventSourceDraft
    readonly digest: string
    readonly validationReceipt: CustomEventSourceValidationReceipt
    readonly source: EventSourceDescriptor
    readonly eventTypes: readonly EventTypeDescriptor[]
    readonly actorUserId: string | null
    readonly now: number
  }): Promise<PublishedCustomEventSource>
  retire(id: string, now: number): Promise<boolean>
  getPublished(ref: {
    readonly id: string
    readonly revision: number
  }): Promise<PublishedCustomEventSource | null>
  acceptsNewSubscriptions(ref: { readonly id: string; readonly revision: number }): Promise<boolean>
}
