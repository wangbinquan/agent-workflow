import type { EventsArchiveRow } from './eventsArchiveStorePort'

/** Deployment-selected immutable event storage. A successful receipt means
 * the object is retained and its index and source-row removal committed. */
export interface EventsArchiveContent {
  recover(): Promise<{ readonly file: string | null; readonly archived: number }>
  archive(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly rows: readonly EventsArchiveRow[]
  }): Promise<{ readonly file: string; readonly archived: number }>
}

export interface ArchivedEventsReader {
  read(
    taskId: string,
    nodeRunId: string,
    since: number,
    limit: number,
  ): Promise<readonly EventsArchiveRow[]>
}
