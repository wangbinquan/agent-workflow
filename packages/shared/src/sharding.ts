// RFC-055 — agent-multi (fanout) node sharding strategy.
//
// Three sharding kinds match `packages/backend/src/services/scheduler.ts:1673`
// and `packages/backend/src/util/diffSplit.ts`:
//   - per-file        — one shard per file diff (default)
//   - per-n-files     — group files in chunks of N (N >= 1)
//   - per-directory   — group by the first `depth` path components (depth >= 1; default 1)
//
// The scheduler treats `node.shardingStrategy === undefined` as per-file
// (fallback for old workflows and yaml-edited fixtures). UI writes are
// always explicit — the GET path runs `applyShardingBackfill` to surface
// "what's actually running" so the inspector form never starts empty.

import { type WorkflowDefinition, type WorkflowNode } from './schemas/workflow'

export const SHARDING_KINDS = ['per-file', 'per-n-files', 'per-directory'] as const
export type ShardingKind = (typeof SHARDING_KINDS)[number]

export type ShardingStrategy =
  | { kind: 'per-file' }
  | { kind: 'per-n-files'; n: number }
  | { kind: 'per-directory'; depth?: number }

export const DEFAULT_SHARDING_STRATEGY: ShardingStrategy = { kind: 'per-file' }

export type ShardingValidationOk = { ok: true; value: ShardingStrategy }
export type ShardingValidationError =
  | { ok: false; code: 'kind-invalid' }
  | { ok: false; code: 'n-missing' }
  | { ok: false; code: 'n-out-of-range' }
  | { ok: false; code: 'depth-out-of-range' }
export type ShardingValidationResult = ShardingValidationOk | ShardingValidationError

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1
}

export function validateShardingStrategy(v: unknown): ShardingValidationResult {
  if (v === null || typeof v !== 'object') return { ok: false, code: 'kind-invalid' }
  const rec = v as Record<string, unknown>
  const kind = rec.kind
  if (kind === 'per-file') {
    return { ok: true, value: { kind: 'per-file' } }
  }
  if (kind === 'per-n-files') {
    if (rec.n === undefined) return { ok: false, code: 'n-missing' }
    if (!isPosInt(rec.n)) return { ok: false, code: 'n-out-of-range' }
    return { ok: true, value: { kind: 'per-n-files', n: rec.n } }
  }
  if (kind === 'per-directory') {
    if (rec.depth === undefined) {
      return { ok: true, value: { kind: 'per-directory' } }
    }
    if (!isPosInt(rec.depth)) return { ok: false, code: 'depth-out-of-range' }
    return { ok: true, value: { kind: 'per-directory', depth: rec.depth } }
  }
  return { ok: false, code: 'kind-invalid' }
}

/**
 * Pure transformation for when the user flips the Select kind. Preserves a
 * previously-typed `n` / `depth` when flipping back to the same kind so a
 * misclick doesn't silently reset the user's number.
 */
export function normalizeShardingStrategy(
  prev: ShardingStrategy | undefined,
  nextKind: ShardingKind,
): ShardingStrategy {
  if (nextKind === 'per-file') return { kind: 'per-file' }
  if (nextKind === 'per-n-files') {
    if (prev && prev.kind === 'per-n-files' && isPosInt(prev.n)) {
      return { kind: 'per-n-files', n: prev.n }
    }
    return { kind: 'per-n-files', n: 5 }
  }
  // per-directory
  if (prev && prev.kind === 'per-directory' && prev.depth !== undefined && isPosInt(prev.depth)) {
    return { kind: 'per-directory', depth: prev.depth }
  }
  return { kind: 'per-directory' }
}

/**
 * Backfill `agent-multi` nodes missing or holding an invalid `shardingStrategy`
 * with DEFAULT_SHARDING_STRATEGY. Idempotent: if every agent-multi node
 * already has a valid strategy, returns the input definition by reference.
 *
 * Non-agent-multi nodes are never touched.
 */
export function applyShardingBackfill(def: WorkflowDefinition): WorkflowDefinition {
  let nextNodes: WorkflowNode[] | null = null
  for (let i = 0; i < def.nodes.length; i++) {
    const node = def.nodes[i]
    if (!node || node.kind !== 'agent-multi') continue
    const current = (node as Record<string, unknown>).shardingStrategy
    if (validateShardingStrategy(current).ok) continue
    if (nextNodes === null) nextNodes = def.nodes.slice()
    nextNodes[i] = { ...node, shardingStrategy: { ...DEFAULT_SHARDING_STRATEGY } } as WorkflowNode
  }
  if (nextNodes === null) return def
  return { ...def, nodes: nextNodes }
}
