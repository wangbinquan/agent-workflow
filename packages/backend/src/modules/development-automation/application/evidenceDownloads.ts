export type EvidenceDownloadStream =
  | ReadableStream<Uint8Array>
  | Promise<ReadableStream<Uint8Array>>

/** A selected blob handle. HTTP owns the range and metadata decisions. */
export interface EvidenceDownloadHandle {
  openAll(): EvidenceDownloadStream
  open(start: number, endInclusive: number): EvidenceDownloadStream
}

export interface EvidenceDownloadQueries {
  open(ref: string): EvidenceDownloadHandle | null | Promise<EvidenceDownloadHandle | null>
}
