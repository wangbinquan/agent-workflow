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
  }): CustomEventSourceAuthoringRecord
  get(id: string): CustomEventSourceAuthoringRecord | null
  list(): CustomEventSourceAuthoringRecord[]
  update(input: {
    readonly id: string
    readonly draft: CustomEventSourceDraft
    readonly now: number
  }): CustomEventSourceAuthoringRecord | null
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
  }): PublishedCustomEventSource
  retire(id: string, now: number): boolean
  getPublished(ref: {
    readonly id: string
    readonly revision: number
  }): PublishedCustomEventSource | null
  acceptsNewSubscriptions(ref: { readonly id: string; readonly revision: number }): boolean
}
