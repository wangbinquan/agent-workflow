import { join } from 'node:path'
import { legacyContentRef, type ContentRef } from './contentRef'

export function decodeLegacyEventArchive(path: string): ContentRef<string> {
  return legacyContentRef(
    'event-archive',
    path.startsWith('aw-event-archive:') ? 'object' : 'local-file',
    path,
    { mediaType: 'application/x-ndjson' },
  )
}
export function legacyEventArchivePath(logsDir: string, taskId: string, nodeRunId: string): string {
  return join(logsDir, taskId, `${nodeRunId}.jsonl`)
}
export function legacyEventArchiveChunkPath(
  nodeRunId: string,
  firstId: number,
  lastId: number,
): string {
  return `${nodeRunId}.events/${firstId}-${lastId}.jsonl`
}
export function legacyHostedEventArchiveReference(id: string): string {
  return `aw-event-archive:${id}`
}
export function legacyEventAppendJournal(path: string): string {
  return `${path}.append-journal.json`
}

export { encodeLegacyContent as encodeLegacyEventArchive } from './contentRef'
