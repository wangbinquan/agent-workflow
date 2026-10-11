import type {
  HistoricalNativeObservationIdentity,
  HistoricalNativeObservationPage,
} from '@agent-workflow/shared'
import type { HistoricalNativeSourceProof } from '@/modules/runtime-management/public/participants'

/** Private async page source; the Runtime's original synchronous public reader is unchanged. */
export interface HistoricalNativeFactReader {
  readonly identity: HistoricalNativeObservationIdentity
  readonly initialCursor: string
  readonly rootCreatedAt: number | null
  next(cursor: string): Promise<HistoricalNativeObservationPage>
  acknowledge(ordinal: string, payloadDigest: string): Promise<void>
  close(): Promise<void>
}
export interface HistoricalNativeFacts {
  open(input: {
    readonly referenceId: string
    readonly rootSessionId: string
  }): Promise<HistoricalNativeFactReader | null>
}
export interface HistoricalNativeFactRoot {
  readonly cacheKey: string
  readonly proof: HistoricalNativeSourceProof
  readonly identity: HistoricalNativeObservationIdentity
  readonly initialCursor: string
  readonly rootCreatedAt: number | null
  readonly pages: string
  readonly finalDigest: string
  readonly eof: NonNullable<HistoricalNativeObservationPage['eof']>
  readonly issues: readonly string[]
}
export type HistoricalNativeFactTransferItem =
  | { readonly kind: 'root'; readonly root: HistoricalNativeFactRoot }
  | {
      readonly kind: 'page'
      readonly cacheKey: string
      readonly page: HistoricalNativeObservationPage
    }
export interface HistoricalNativeFactTransferPage {
  readonly reportId: string
  readonly ordinal: string
  readonly previousDigest: string
  readonly digest: string
  readonly items: readonly HistoricalNativeFactTransferItem[]
}
export interface HistoricalNativeFactManifest {
  readonly reportId: string
  readonly owner: string
  readonly proof: HistoricalNativeSourceProof
  readonly packets: string
  readonly roots: string
  readonly pages: string
  readonly digest: string
}
export interface HistoricalNativeFactSpool {
  seal(input: {
    readonly reportId: string
    readonly owner: string
    readonly proof: HistoricalNativeSourceProof
    readonly items: AsyncIterable<HistoricalNativeFactTransferItem>
    readonly signal?: AbortSignal
  }): Promise<HistoricalNativeFactManifest>
  pages(
    manifest: HistoricalNativeFactManifest,
    signal?: AbortSignal,
  ): Iterable<HistoricalNativeFactTransferPage>
}
