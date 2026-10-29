// RFC-083 — per-node scope ref selection (pure). "What did node N change" =
// the diff between N's pre-run snapshot and the NEXT write node's pre-run
// snapshot (or the live worktree if N is the last writer). Readonly nodes have
// no snapshot and contribute nothing.
//
// pre_snapshot is a `git stash create` sha captured before each write node
// (services/runner). Caveats surfaced to the caller: plain stash trees omit
// untracked files; after worktree-GC the snapshot objects may be pruned.

import type { TaskRepositoryCheckpoint } from '@/modules/task-execution/public/types'
import { compareNodeRunsForTimeline } from '../reviewRoundStart'

export interface NodeRunRef {
  id: string
  seq: number
  snapshotRef: string | null
  startedAt: number | null
}

export type NodeScopeResolution =
  | { kind: 'between'; fromRef: string; toRef: string }
  | { kind: 'to-worktree'; fromRef: string }
  | { kind: 'readonly' } // target node has no snapshot (readonly / non-write)
  | { kind: 'not-found' }

/** Resolve the (fromRef, toRef) pair for a node-scoped structural diff. */
export function resolveNodeScope(runs: NodeRunRef[], nodeRunId: string): NodeScopeResolution {
  const target = runs.find((r) => r.id === nodeRunId)
  if (target === undefined) return { kind: 'not-found' }
  if (target.snapshotRef === null || target.snapshotRef === '') return { kind: 'readonly' }

  const writes = runs
    .filter((r) => r.snapshotRef !== null && r.snapshotRef !== '')
    .sort(compareNodeRunsForTimeline)
  const idx = writes.findIndex((r) => r.id === nodeRunId)
  const next = writes[idx + 1]
  if (next !== undefined && next.snapshotRef !== null && next.snapshotRef !== '') {
    return { kind: 'between', fromRef: target.snapshotRef, toRef: next.snapshotRef }
  }
  return { kind: 'to-worktree', fromRef: target.snapshotRef }
}

/** Select one mount from the checkpoint list; missing/clean snapshots are non-writers. */
export function perRepoNodeRuns(
  rows: ReadonlyArray<{
    id: string
    seq: number
    startedAt: number | null
    checkpoints: readonly TaskRepositoryCheckpoint[]
  }>,
  mountPath: string,
): NodeRunRef[] {
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    snapshotRef:
      row.checkpoints.find((checkpoint) => checkpoint.mountPath === mountPath)?.preSnapshot || null,
    startedAt: row.startedAt,
  }))
}
