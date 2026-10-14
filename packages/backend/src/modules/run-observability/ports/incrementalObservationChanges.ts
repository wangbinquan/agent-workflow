import type { OriginalObservationChangeRouter } from '@/platform/persistence/observationChangeContract'
import type { IncrementalObservationWork } from './incrementalObservationProjection'
export type {
  OriginalObservationChange,
  OriginalObservationChangeRouter,
} from '@/platform/persistence/observationChangeContract'

export interface IncrementalObservationChangeQueue {
  dispatch(router: OriginalObservationChangeRouter, packetSize: number): Promise<number>
  bootstrap(): Promise<void>
  prepare(work: IncrementalObservationWork, signal: AbortSignal): Promise<void>
}
