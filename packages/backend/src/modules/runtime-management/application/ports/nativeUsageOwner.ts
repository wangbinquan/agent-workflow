import type {
  ObservationNativePassAck,
  ObservationNativePassAdmission,
} from '@agent-workflow/shared'
import type { NativeUsagePassIdentity, NativeUsagePassPage } from './nativeUsagePass'

/** Bound to the original accepted invocation and its existing Task owner context. */
export interface NativeUsagePassOwner {
  admit(
    identity: NativeUsagePassIdentity,
    initialCursor: string,
    rootCreatedAt: number | null,
  ): Promise<ObservationNativePassAdmission>
  /** Validates original binding/progress/digests; atomically saves exact page bytes,
   * membership/parents and original source rows before returning the durable ACK. */
  persist(page: NativeUsagePassPage): Promise<ObservationNativePassAck>
  /** A lost snapshot never becomes a completed pass on a later reader restart. */
  interrupt(identity: NativeUsagePassIdentity, reason: string): Promise<void>
}
export interface AsyncNativeUsagePassReader {
  readonly identity: NativeUsagePassIdentity
  readonly initialCursor: string
  readonly rootCreatedAt: number | null
  next(cursor: string): Promise<NativeUsagePassPage>
  acknowledge(ordinal: string, payloadDigest: string): Promise<void>
  close(): Promise<void>
}
