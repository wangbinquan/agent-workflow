// RFC-061 follow-up — events archival retired.
//
// The legacy P-5-01 archival ran hourly to move oldest node_run_events
// rows from DB to JSONL files when row counts exceeded a threshold. The
// actor doesn't populate node_run_events anymore, so the threshold is
// never reached and the archiver has nothing to do. Behaviour preserved
// as a no-op so cli/start.ts and any callers that haven't been
// rewritten compile and run cleanly; the hourly tick keeps firing but
// each pass returns immediately.
//
// `readArchivedEvents` is preserved as a no-op too — it returns [] so
// callers that still grep through the old archive directory degrade
// gracefully without a 5xx. The archive directory + any historical
// JSONL files left over from pre-RFC-061 days are not migrated; that's
// acceptable under the "未上生产、自由断代" rule in the RFC.

import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'

const HOUR_MS = 60 * 60 * 1000

export interface ArchiveRunResult {
  perGroupArchived: number
  globalArchived: number
  files: string[]
}

export async function archiveEvents(
  _db: DbClient,
  _config: Pick<Config, 'eventsArchiveThresholds'>,
  _logsDir: string,
): Promise<ArchiveRunResult> {
  return { perGroupArchived: 0, globalArchived: 0, files: [] }
}

export async function readArchivedEvents(
  _logsDir: string,
  _taskId: string,
  _nodeRunId: string,
  _since: number,
  _limit: number,
): Promise<Array<{ id: number; ts: number; kind: string; payload: string }>> {
  return []
}

export function startEventsArchiver(
  _db: DbClient,
  _loadConfig: () => Pick<Config, 'eventsArchiveThresholds'>,
  _logsDir: string,
  _intervalMs: number = HOUR_MS,
): { stop: () => void } {
  // No-op ticker — the legacy archiver had nothing to do under the
  // actor model. We still hand back a stop() so cli/start.ts can
  // shutdown cleanly without changing its public contract.
  return { stop: () => {} }
}
