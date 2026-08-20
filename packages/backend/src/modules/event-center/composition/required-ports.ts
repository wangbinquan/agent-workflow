import type { EventSourceDescriptor, EventSubject, ObserverBatch } from '../domain/model'

export interface EventObserverProgramPort {
  run(input: {
    readonly source: EventSourceDescriptor
    readonly subjects: readonly EventSubject[]
    readonly cursorJson: string | null
  }): Promise<ObserverBatch>
}
