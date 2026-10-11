export const HISTORICAL_NATIVE_NUMERIC_PAGE_VERSION = 'opencode-numeric-pages-v1'

/** A revision belongs to one continuously open original native SQLite connection. */
export interface HistoricalNativeSourceProof {
  readonly nativeSource: string
  readonly sourceGeneration: string
  readonly connectionEpoch: string
  readonly revisionToken: string
  readonly parserVersion: string
}

export interface HistoricalNativeVersionObserver {
  sample(): Promise<HistoricalNativeSourceProof | null>
  /** Call after the original report jobs/imports drain; reopening starts a different epoch. */
  close(): Promise<void>
}
