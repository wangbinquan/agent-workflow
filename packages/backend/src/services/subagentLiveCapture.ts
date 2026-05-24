// RFC-061 follow-up — subagent live capture retired.
//
// The legacy RFC-048 poller wrote opencode subagent telemetry into the
// node_run_events table. The actor doesn't populate node_run_events
// anymore; the runner-v2 stdout aggregator emits attempt-subagent-*
// events into the projection events table directly. The polling code
// path was only ever invoked by the legacy runner.ts (deleted in
// RFC-061 PR-B), so this module is dead under the actor model.
//
// We keep the export surface (startLiveSubagentCapture +
// LivePollOptions / LivePollerHandle / LivePollerStats) so any
// downstream caller compiles, but the implementation is a no-op.
// When RFC-061 grows a native live subagent stream (likely as an
// extension to attempt-subagent-* events), this file gets retired.

import type { DbClient } from '../db/client'
import type { Logger } from '@/util/log'

export interface LivePollOptions {
  nodeRunId: string
  taskId: string
  nodeId: string
  getRootSessionId: () => string | null
  db: DbClient
  log?: Logger
  opencodeDbPath?: string
  pollMs: number
  consecutiveFailureLimit: number
  signal?: AbortSignal
  onInsert?: (info: { insertedRows: number; sessionIds: string[] }) => void
}

export interface LivePollerStats {
  ticks: number
  insertedRows: number
  failedTicks: number
  disabled: boolean
  insertedPartIdsBySession: Map<string, Set<string>>
}

export interface LivePollerHandle {
  stop(): void
  tickOnce(): Promise<number>
  stats(): LivePollerStats
}

const NOOP_HANDLE: LivePollerHandle = {
  stop: () => {},
  tickOnce: async () => 0,
  stats: () => ({
    ticks: 0,
    insertedRows: 0,
    failedTicks: 0,
    disabled: true,
    insertedPartIdsBySession: new Map(),
  }),
}

export function startLiveSubagentCapture(_opts: LivePollOptions): LivePollerHandle {
  return NOOP_HANDLE
}
