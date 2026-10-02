/** Immutable evidence facts; storage adapters own their byte and staging mechanisms. */
export interface EvidenceBudget {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export interface EvidenceEntry {
  readonly relativePath: string
  readonly bytes: number
  readonly sha256: string
}

export interface EvidenceBundleRecord {
  readonly bundleId: string
  readonly entries: readonly EvidenceEntry[]
  readonly totalBytes: number
}
