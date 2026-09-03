// RFC-354 T4 — plan the one-shot frame backfill for rows minted before frames
// existed (PURE). Migration 0223 adds `container_run_id` / `scope_path` but
// cannot fill them: which generation row a body row belongs to needs the
// task's containment tree (the frozen workflow snapshot), which SQL cannot
// parse. This planner reconstructs the frame of every legacy row from the
// only order the old data still carries — mint order (ULID ids):
//
//   • a row of a node whose container is wrapper W belongs to the LATEST row
//     of W minted before it (pre-354 wrappers re-used one row across their
//     rounds, so that row IS the generation; a nested inner loop minted one
//     row per outer round, so its body rows map to the right one too);
//   • a child row (`parentNodeRunId` set) hangs off its parent: a wrapper
//     parent (fan-out shards / aggregator) is the generation row itself, any
//     other parent (merge-resolve / commit-push session sub-rows) shares its
//     parent's frame;
//   • a row of a root node is a top-scope row and needs nothing;
//   • rows that already carry a container (minted after the cutover, or
//     backfilled earlier) are taken as-is — the walk is idempotent.
//
// `scopePath` follows the adapter's mint-time rule exactly
// (`childScopePath(container.scopePath, container.nodeId, row.iteration)`), so
// backfilled rows are indistinguishable from freshly minted ones.
//
// Locks: tests/rfc354-frame-backfill.test.ts.

import { childScopePath } from './environmentChain'

export interface FrameBackfillRunRow {
  readonly id: string
  readonly nodeId: string
  readonly iteration: number
  readonly parentNodeRunId: string | null
  readonly containerRunId: string | null
  readonly scopePath: string
}

export interface FrameBackfillUpdate {
  readonly id: string
  readonly containerRunId: string
  readonly scopePath: string
}

export interface FrameBackfillPlan {
  readonly updates: readonly FrameBackfillUpdate[]
  /** Nested-node rows with no generation row minted before them (data anomaly): left untouched. */
  readonly unresolved: readonly string[]
}

interface SettledRow {
  readonly id: string
  readonly nodeId: string
  readonly containerRunId: string | null
  readonly scopePath: string
}

export function planFrameBackfill(input: {
  /** Direct child node id → containing wrapper node id (the scope index's `parentOf`). */
  readonly parentOf: ReadonlyMap<string, string>
  readonly rows: readonly FrameBackfillRunRow[]
}): FrameBackfillPlan {
  const wrapperIds = new Set(input.parentOf.values())
  const rows = [...input.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const settledById = new Map<string, SettledRow>()
  const latestRowOfNode = new Map<string, SettledRow>()
  const updates: FrameBackfillUpdate[] = []
  const unresolved: string[] = []

  const settle = (row: FrameBackfillRunRow, containerRunId: string | null, scopePath: string) => {
    const settled: SettledRow = { id: row.id, nodeId: row.nodeId, containerRunId, scopePath }
    settledById.set(row.id, settled)
    latestRowOfNode.set(row.nodeId, settled)
  }
  const backfill = (row: FrameBackfillRunRow, containerRunId: string, scopePath: string) => {
    updates.push({ id: row.id, containerRunId, scopePath })
    settle(row, containerRunId, scopePath)
  }

  for (const row of rows) {
    if (row.containerRunId !== null) {
      settle(row, row.containerRunId, row.scopePath)
      continue
    }
    const parent = row.parentNodeRunId === null ? undefined : settledById.get(row.parentNodeRunId)
    if (parent !== undefined) {
      if (wrapperIds.has(parent.nodeId)) {
        // Fan-out shard / aggregator child: the wrapper row IS the generation.
        backfill(row, parent.id, childScopePath(parent.scopePath, parent.nodeId, row.iteration))
      } else if (parent.containerRunId !== null) {
        // Session sub-row of an ordinary nested run: same frame as its parent.
        backfill(row, parent.containerRunId, parent.scopePath)
      } else {
        settle(row, null, '')
      }
      continue
    }
    const wrapperId = input.parentOf.get(row.nodeId)
    if (wrapperId === undefined) {
      settle(row, null, '')
      continue
    }
    const generation = latestRowOfNode.get(wrapperId)
    if (generation === undefined) {
      unresolved.push(row.id)
      settle(row, null, '')
      continue
    }
    backfill(row, generation.id, childScopePath(generation.scopePath, wrapperId, row.iteration))
  }
  return { updates, unresolved }
}
