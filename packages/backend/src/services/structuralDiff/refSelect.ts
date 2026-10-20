// RFC-083 — per-node scope ref selection (pure). "What did node N change" =
// the diff between N's pre-run snapshot and the NEXT write node's pre-run
// snapshot (or the live worktree if N is the last writer). Readonly nodes have
// no snapshot and contribute nothing.
//
// pre_snapshot is a `git stash create` sha captured before each write node
// (services/runner). Caveats surfaced to the caller: plain stash trees omit
// untracked files; after worktree-GC the snapshot objects may be pruned.

import { compareNodeRunMintOrder } from '@agent-workflow/shared'

export interface NodeRunRef {
  id: string
  seq: number | null
  preSnapshot: string | null
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
  if (target.preSnapshot === null || target.preSnapshot === '') return { kind: 'readonly' }

  const writes = runs
    .filter((r) => r.preSnapshot !== null && r.preSnapshot !== '')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || compareNodeRunMintOrder(a, b))
  const idx = writes.findIndex((r) => r.id === nodeRunId)
  const next = writes[idx + 1]
  if (next !== undefined && next.preSnapshot !== null && next.preSnapshot !== '') {
    return { kind: 'between', fromRef: target.preSnapshot, toRef: next.preSnapshot }
  }
  return { kind: 'to-worktree', fromRef: target.preSnapshot }
}

/**
 * RFC-089 P3 — project the multi-repo per-node snapshot maps
 * (`pre_snapshot_repos_json` = `{<worktreeDirName>: <stashSha>}`) onto a SINGLE
 * repo, yielding the same `NodeRunRef` shape `resolveNodeScope` already consumes.
 * So multi-repo node scope is just "run the same resolution once per repo".
 *
 * A run with no entry for `repoDir` (the node didn't write that repo) gets a
 * null `preSnapshot` → `resolveNodeScope` treats it as a non-write, exactly like
 * the single-repo readonly case. Malformed JSON → that run contributes null
 * (warn-and-continue parity with the resume rollback path in task.ts).
 */
export function perRepoNodeRuns(
  rows: Array<{
    id: string
    seq: number | null
    startedAt: number | null
    preSnapshotReposJson: string | null
  }>,
  repoDir: string,
): NodeRunRef[] {
  return rows.map((r) => {
    let sha: string | null = null
    if (r.preSnapshotReposJson !== null) {
      try {
        const map = JSON.parse(r.preSnapshotReposJson) as Record<string, string>
        const v = map[repoDir]
        sha = typeof v === 'string' && v !== '' ? v : null
      } catch {
        sha = null
      }
    }
    return { id: r.id, seq: r.seq, preSnapshot: sha, startedAt: r.startedAt }
  })
}
