/** RFC-371: batches bound transport and memory, never the statistical population. */
export interface CompleteSourcePage<T> {
  readonly items: readonly T[]
  readonly snapshotId: string
  /** Null is an affirmative source-owner EOF, including an empty population. */
  readonly nextCursor: string | null
}

export interface CompleteSourceReader<T> {
  next(after: string | null): Promise<CompleteSourcePage<T>>
}

/** Connection-private working tables enforce uniqueness without an all-row JS Set. */
export interface CompletePageWorkspace<T> {
  /** A repeated non-null cursor must fail, even if the cycle spans many pages. */
  claimCursor(source: string, cursor: string): Promise<void>
  /** Persist the complete page; duplicate source identities must fail atomically. */
  append(source: string, items: readonly T[]): Promise<void>
}

export interface CompleteSourceReceipt {
  readonly source: string
  readonly snapshotId: string
  readonly rows: string
  readonly pages: string
  readonly eof: true
}

export interface ReportSourceGap {
  readonly source: string
  readonly reason: string
  readonly recoverable: boolean
}

/** Non-ready states deliberately have no totals, even as optional fields. */
export type CompleteReportState<T> =
  | { readonly state: 'building'; readonly reportId: string; readonly phase: string }
  | {
      readonly state: 'not-ready'
      readonly reportId: string
      readonly gaps: readonly ReportSourceGap[]
    }
  | {
      readonly state: 'failed'
      readonly reportId: string
      readonly error: string
      readonly retryable: boolean
    }
  | {
      readonly state: 'ready'
      readonly reportId: string
      readonly coverage: 'complete'
      readonly asOf: number
      readonly snapshotId: string
      readonly value: T
    }

export interface CompleteReportSnapshotSession<Workspace> {
  /** The original database snapshot and its private TEMP workspace share one connection. */
  run<T>(work: (workspace: Workspace) => Promise<T>, signal?: AbortSignal): Promise<T>
}
