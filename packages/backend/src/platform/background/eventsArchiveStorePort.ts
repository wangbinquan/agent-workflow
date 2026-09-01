// RFC-349 — provider-neutral database boundary for the mixed DB/filesystem
// node-event archive. Implementations own dialect queries; the archive
// mechanism owns durable append journals and exact cursor semantics.

export interface EventsArchiveRow {
  readonly id: number
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

export interface EventsArchiveStore {
  readState(key: string): Promise<string | null>
  writeState(key: string, value: string, now?: number): Promise<void>
  averageRecentPayloadBytes(limit: number): Promise<number | null>
  maxEventId(): Promise<number>
  countEventIds(input: {
    readonly afterId: number
    readonly throughId: number
    readonly nodeRunId?: string
  }): Promise<number>
  listDistinctNodeRunIds(input: {
    readonly afterId: number
    readonly throughId: number
  }): Promise<readonly string[]>
  countEventsByNodeRunIds(
    nodeRunIds: readonly string[],
  ): Promise<readonly { readonly nodeRunId: string; readonly count: number }[]>
  countAllEvents(): Promise<number>
  oldestEvent(): Promise<{ readonly id: number; readonly nodeRunId: string } | null>
  countEventsForNodeRun(nodeRunId: string): Promise<number>
  findTaskIdForNodeRun(nodeRunId: string): Promise<string | null>
  listOldestEvents(nodeRunId: string, limit: number): Promise<readonly EventsArchiveRow[]>
  deleteNodeRunEventsThrough(nodeRunId: string, lastId: number): Promise<void>
  deleteNodeRunEventsRange(input: {
    readonly nodeRunId: string
    readonly afterId: number
    readonly throughId: number
  }): Promise<void>
}
