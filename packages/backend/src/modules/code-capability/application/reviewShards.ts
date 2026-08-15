// RFC-304 §6.1 (T24) — running the review shards, each in its own tree.
//
// ## Why a tree per shard
//
// B6 wants the shards parallel; B8 lets a reviewing agent run tests and even
// try edits to check a hypothesis. Together those two make a SHARED tree
// unusable: shard A's scratch edit is visible to shard B, and B's review of
// identical input differs depending on what A happened to be doing at the time.
// That is a direct violation of the constitution's determinism requirement, and
// it would show up as a review that is subtly different on every re-run with no
// change in the code. So each shard gets its own throwaway tree at the same
// baseline sha, and none of them is ever merged back.
//
// The cost is real — one `git worktree add` and one directory per shard — which
// is exactly why `split-diff` caps the shard count rather than splitting freely.
//
// ## Why a failed shard does not fail the round
//
// The design does not say (2026-08-16: `design.md §6.1` covers the tree
// isolation but is silent on a shard whose model never conforms), so this
// follows the invariant the publish path already holds: never lose a finding
// silently, degrade visibly instead. A round of eight shards where one is
// exhausted still carries seven shards' worth of real findings, and throwing
// them away helps nobody. What is NOT acceptable is publishing those seven as
// if they were the whole review — so the failure is returned, and the overview
// names the part of the change that went unreviewed.
//
// This is consistent with R5 rather than an exception to it: nothing
// unvalidated escapes. The exhausted shard contributes no findings at all.

import { runReviewStage } from '@/modules/code-capability/application/reviewStage'
import type {
  AiCaller,
  AttemptRecorder,
  RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import { parseDiffHunks } from '@/modules/code-capability/domain/diffHunks'
import { toUnifiedDiff } from '@/modules/code-capability/domain/mrDiffNormalize'
import type { ReviewFinding } from '@/modules/code-capability/domain/reviewEnvelope'
import { filePathOf, type DiffShard } from '@/modules/code-capability/domain/splitDiff'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'

export interface ShardOutcome {
  shardKey: string
  directory: string
  status: 'done' | 'exhausted' | 'worktree-failed' | 'canceled'
  findings: readonly ReviewFinding[]
  /** Populated for anything other than `done`; goes into the overview. */
  reason: string | null
  /** True when this shard's own diff had to be clipped to fit the prompt. */
  diffClipped: boolean
}

export interface RunReviewShardsInput {
  shards: readonly DiffShard[]
  /** Every shard tree starts here — the same commit `fetch-diff` measured. */
  baselineSha: string
  repoPath: string
  /** Directory the per-shard trees are created under. */
  shardRoot: string
  git: GitPort
  makeCaller: (prompt: string) => AiCaller
  protocolBlock: string
  nonce: string
  budget: RetryBudget
  mrTitle: string | null
  /** One recorder per shard, so attempts are attributable to it. */
  recorderFor?: (shardKey: string) => AttemptRecorder
  /**
   * How many shards run at once.
   *
   * Bounded because each running shard holds a worktree and a model call: an
   * unbounded fan-out on a large MR would open every tree simultaneously and
   * hit whatever the model's concurrency limit is, all at once.
   */
  concurrency?: number
  signal?: AbortSignal
}

export interface RunReviewShardsResult {
  /** Every shard's findings, concatenated in shard order. */
  findings: readonly ReviewFinding[]
  outcomes: readonly ShardOutcome[]
  /** True when any shard could not be reviewed — the overview must say so. */
  degraded: boolean
}

export const DEFAULT_SHARD_CONCURRENCY = 3

/** A shard tree's path. Keyed by index so one directory cannot collide. */
export function shardWorktreePath(shardRoot: string, index: number): string {
  return `${shardRoot}/shard-${index}`
}

async function runOneShard(
  input: RunReviewShardsInput,
  shard: DiffShard,
  index: number,
): Promise<ShardOutcome> {
  const base = {
    shardKey: shard.key,
    directory: shard.directory,
    findings: [] as readonly ReviewFinding[],
    diffClipped: false,
  }

  if (input.signal?.aborted === true) {
    return { ...base, status: 'canceled', reason: 'the round was canceled before this shard ran' }
  }

  const worktreePath = shardWorktreePath(input.shardRoot, index)
  const created = await input.git.addDisposableWorktree({
    repoPath: input.repoPath,
    worktreePath,
    sha: input.baselineSha,
  })
  if (!created.ok) {
    // Named rather than collapsed into "review failed": a full disk and a model
    // that will not conform need very different responses.
    return {
      ...base,
      status: 'worktree-failed',
      reason: `could not create a working tree for this shard: ${created.error}`,
    }
  }

  try {
    const unifiedDiff = toUnifiedDiff(shard.files)
    const result = await runReviewStage({
      makeCaller: input.makeCaller,
      nonce: input.nonce,
      budget: input.budget,
      unifiedDiff,
      // Parsed from THIS shard's diff, so the prompt's line references match
      // what the shard was actually shown.
      hunks: parseDiffHunks(unifiedDiff),
      // Omitted files are reported once for the whole round by `fetch-diff`;
      // repeating them per shard would put the same warning on every shard's
      // prompt and make a single binary file look like many.
      omitted: [],
      mrTitle: input.mrTitle,
      protocolBlock: input.protocolBlock,
      ...(input.recorderFor !== undefined ? { recorder: input.recorderFor(shard.key) } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })

    if (result.outcome.status !== 'ok') {
      return {
        ...base,
        diffClipped: result.diffClipped,
        status: result.outcome.status === 'canceled' ? 'canceled' : 'exhausted',
        reason:
          result.outcome.status === 'canceled'
            ? 'the round was canceled while this shard was being reviewed'
            : `the reviewer never returned a valid result for this part of the change after ${result.outcome.totalCalls} call${result.outcome.totalCalls === 1 ? '' : 's'}`,
      }
    }

    return {
      ...base,
      status: 'done',
      diffClipped: result.diffClipped,
      findings: result.outcome.value.findings,
      reason: null,
    }
  } finally {
    // Always — including on an exhausted shard or a thrown error. A leaked tree
    // is permanent: nothing later in the round knows it existed, so it survives
    // until someone notices the disk.
    await input.git.removeDisposableWorktree({ repoPath: input.repoPath, worktreePath })
  }
}

/**
 * Review every shard, bounded, and collect what came back.
 *
 * Order is by shard, not by completion: findings must be assembled the same way
 * every run, or the gate's deterministic sort has different input each time and
 * the per-round cap would truncate a different set.
 */
export async function runReviewShards(input: RunReviewShardsInput): Promise<RunReviewShardsResult> {
  const outcomes: ShardOutcome[] = new Array<ShardOutcome>(input.shards.length)
  const limit = Math.max(1, input.concurrency ?? DEFAULT_SHARD_CONCURRENCY)

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= input.shards.length) return
      outcomes[index] = await runOneShard(input, input.shards[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, input.shards.length) }, worker))

  const findings = outcomes.flatMap((o) => [...o.findings])
  return {
    findings,
    outcomes,
    degraded: outcomes.some((o) => o.status !== 'done'),
  }
}

/**
 * What the overview says about the parts that could not be reviewed.
 *
 * Returns null when everything succeeded, so the caller adds nothing rather
 * than an empty "0 shards failed" line.
 */
export function describeShardFailures(outcomes: readonly ShardOutcome[]): string | null {
  const failed = outcomes.filter((o) => o.status !== 'done')
  if (failed.length === 0) return null
  const parts = failed.map((o) => `\`${o.directory === '' ? '(repository root)' : o.directory}\``)
  return `${failed.length} of ${outcomes.length} parts of this change could not be reviewed (${parts.join(', ')}), so this review is incomplete`
}

/** Files in a shard, for a caller that needs to name them. */
export function shardFilePaths(shard: DiffShard): string[] {
  return shard.files.map(filePathOf)
}
