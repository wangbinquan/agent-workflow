// RFC-304 — running another capability's stages inline (`kind: 'invoke'`).
//
// `requirement`'s `self-review` is the first use: before opening a merge
// request, it runs `mr-review`'s reading stages against the tree it just built.
// The alternative — describing the review again inside `requirement` — is the
// thing this exists to prevent, because the two copies would then drift and the
// self-review would quietly stop matching what a real review does.
//
// ## Three properties, each with a way of being got wrong
//
//   the RANGE runs, nothing else. `[split-diff, validate-findings]` is the
//   reading half of a review. Running past it would reach `publish`, which on a
//   requirement round means posting review comments to a merge request that
//   does not exist yet.
//
//   the sub-sequence's artifacts stay INSIDE. It reads what the parent gives it
//   and hands back one named result. Merging its whole artifact set into the
//   parent's would let `mr-review`'s `worktree` or `target` silently overwrite
//   the parent's — same names, different meanings, and the failure surfaces
//   several stages later as a round working on the wrong tree.
//
//   hooks mount as `<parent>/<sub>`. A team's `pre` hook on `split-diff` fires
//   for a real review AND inside a self-review, and those are different moments
//   — the second has no merge request. The prefixed name is what lets a hook
//   author distinguish them (design §4.3).

import type { DbClient } from '@/db/client'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import type {
  StageArtifacts,
  StageHooks,
  StageResult,
  StageRunContext,
  StageRunners,
} from '@/modules/code-capability/application/stageEngine'
import type {
  CodeCapabilityId,
  StageContract,
} from '@/modules/code-capability/domain/stageContract'

export interface InvokeSubSequenceArgs {
  db: DbClient
  /** The parent round; sub-stages record against it, prefixed. */
  roundId: string
  /** The `kind: 'invoke'` stage being executed. */
  parentStage: string
  invokes: { capability: CodeCapabilityId; from: string; to: string }
  /** What the parent hands in. The sub-sequence starts from exactly this. */
  seedArtifacts: StageArtifacts
  /** Stage implementations for the INVOKED capability, keyed by its stage names. */
  runners: StageRunners
  hooks?: StageHooks
  lookupContract?: (capability: CodeCapabilityId) => StageContract | undefined
  signal?: AbortSignal
}

export type InvokeOutcome =
  /** `artifacts` is the sub-sequence's own set; the caller picks what to keep. */
  | { outcome: 'done'; artifacts: StageArtifacts }
  | { outcome: 'failed'; failedStage: string; error: string }
  | { outcome: 'blocked'; blockedStage: string; reason: string }
  | { outcome: 'canceled'; canceledStage: string }

/**
 * Run `[from, to]` of another capability, inline.
 *
 * Deliberately NOT implemented by calling `runStageSequence` with a sliced
 * contract. Two reasons, and the second is the one that matters: a sliced
 * contract would fail its own `requires` validation (the range's inputs come
 * from stages outside it), and the sub-sequence's stage rows would collide with
 * the parent's on `(roundId, stageSeq)` — the state view would then show one
 * round whose stages overwrite each other.
 *
 * An `awaiting` result from a sub-stage is a FAILURE here rather than a pause.
 * Suspending a sub-sequence would mean resuming into the middle of a parent
 * stage, which the resume model (a single stage name) cannot express — and the
 * reading stages this exists to run have no reason to wait for a human.
 */
export async function invokeSubSequence(args: InvokeSubSequenceArgs): Promise<InvokeOutcome> {
  const lookup = args.lookupContract ?? lookupStageContract
  const target = lookup(args.invokes.capability)
  if (target === undefined) {
    return {
      outcome: 'failed',
      failedStage: args.parentStage,
      error: `stage '${args.parentStage}' invokes '${args.invokes.capability}', which has no registered contract`,
    }
  }

  const names = target.stages.map((s) => s.name)
  const fromIdx = names.indexOf(args.invokes.from)
  const toIdx = names.indexOf(args.invokes.to)
  if (fromIdx === -1 || toIdx === -1 || toIdx < fromIdx) {
    // Also caught at author time by `checkBuiltinContracts`; repeated here
    // because a runtime-supplied contract (a group's binding selecting a
    // version) does not go through that check.
    return {
      outcome: 'failed',
      failedStage: args.parentStage,
      error: `stage '${args.parentStage}' invokes an invalid range [${args.invokes.from}, ${args.invokes.to}] of '${args.invokes.capability}'`,
    }
  }

  // The sub-sequence's own artifact space, seeded with what the parent gave it.
  // A copy, so nothing the sub-stages produce reaches the parent except through
  // the value this function returns.
  const artifacts: Record<string, unknown> = { ...args.seedArtifacts }

  for (const stage of target.stages.slice(fromIdx, toIdx + 1)) {
    if (args.signal?.aborted === true) {
      return { outcome: 'canceled', canceledStage: stage.name }
    }

    const ctx: StageRunContext = {
      roundId: args.roundId,
      // The stage is presented under its PREFIXED name, so a hook mounting on
      // `self-review/split-diff` sees the name it mounted on and one mounting
      // on the bare `split-diff` does not fire here.
      stage: { ...stage, name: `${args.parentStage}/${stage.name}` },
      artifacts: { ...artifacts },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    }

    const gate = await args.hooks?.pre?.(ctx)
    if (gate != null && typeof gate.block === 'string') {
      return { outcome: 'blocked', blockedStage: ctx.stage.name, reason: gate.block }
    }

    const runCtx: StageRunContext =
      gate != null && gate.inject !== undefined
        ? { ...ctx, artifacts: { ...ctx.artifacts, ...gate.inject } }
        : ctx

    let result: StageResult
    try {
      // Dispatched by the stage's OWN kind, and looked up by its bare name:
      // the prefix is a hook-mounting concern, not an implementation key.
      result = await args.runners[stage.kind]({ ...runCtx, stage: { ...stage } })
    } catch (err) {
      result = { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }

    await args.hooks?.post?.(runCtx, result)

    if (result.status === 'failed') {
      return { outcome: 'failed', failedStage: ctx.stage.name, error: result.error }
    }
    if (result.status === 'awaiting') {
      return {
        outcome: 'failed',
        failedStage: ctx.stage.name,
        error: `stage '${ctx.stage.name}' asked to wait for a human inside an invoked sub-sequence, which cannot be resumed into`,
      }
    }

    Object.assign(artifacts, result.produced ?? {})
    if (result.status === 'settled') break
  }

  return { outcome: 'done', artifacts }
}
