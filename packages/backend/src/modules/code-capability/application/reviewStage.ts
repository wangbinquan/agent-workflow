// RFC-304 §6.1 — the `review` stage: the one place this capability asks a model
// anything, wrapped in the determinism guard so nothing unvalidated escapes it.
//
// The dispatch itself is INJECTED, as a factory that turns a prompt into an
// `AiCaller`. Two reasons, and the second is the load-bearing one:
//
//   - the prompt is built here (it is derived from the diff, which is this
//     stage's input), while running an agent is the scheduler's business;
//   - this module must not import the scheduler. A capability that reaches into
//     the scheduler re-creates the coupling RFC-294 exists to remove, and the
//     negative scan in `rfc304-*-boundary` fails the build if it appears.

import {
  runGuardedAiStage,
  type AiCaller,
  type AttemptRecorder,
  type GuardedAiOutcome,
  type RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import type { DiffHunk } from '@/modules/code-capability/domain/anchorResolve'
import type { DiffOmission } from '@/modules/code-capability/domain/mrDiffNormalize'
import {
  checkReviewSemantics,
  ReviewEnvelopeSchema,
  type ReviewEnvelope,
} from '@/modules/code-capability/domain/reviewEnvelope'
import { buildReviewPrompt } from '@/modules/code-capability/domain/reviewPrompt'

/** The port the findings JSON is carried in. */
export const REVIEW_PORT = 'findings'

/**
 * Which group-layer agent binding runs this stage.
 *
 * Declared once and referenced by the contract, because the slot name is a
 * JOIN key: the contract declares it, `capability_bindings.agent_by_slot_json`
 * is keyed by it, and the resolver looks it up. Two spellings would resolve to
 * "no agent bound" for a slot somebody had, in fact, bound.
 */
export const REVIEW_AGENT_SLOT = 'reviewer'

export interface ReviewStageInput {
  /**
   * Turns the built prompt into a caller. Keeps the scheduler out of here.
   *
   * Takes the PORT it will validate: the caller reads the model's reply out of
   * `outputs[port]` and the protocol block asks for it, so handing it over once
   * is what stops the two from drifting. They did drift — the scheduler built
   * both around this port for every capability, and the other three read an
   * empty port for six attempts and reported "no envelope".
   */
  makeCaller: (prompt: string, port: string) => AiCaller
  nonce: string
  budget: RetryBudget
  unifiedDiff: string
  hunks: readonly DiffHunk[]
  omitted: ReadonlyArray<{ path: string; omission: DiffOmission }>
  mrTitle: string | null
  recorder?: AttemptRecorder
  signal?: AbortSignal
}

export interface ReviewStageResult {
  outcome: GuardedAiOutcome<ReviewEnvelope>
  /** True when the diff did not fit the prompt; the overview must say so. */
  diffClipped: boolean
}

export async function runReviewStage(input: ReviewStageInput): Promise<ReviewStageResult> {
  const { prompt, diffClipped } = buildReviewPrompt({
    unifiedDiff: input.unifiedDiff,
    hunks: input.hunks,
    omitted: input.omitted,
    mrTitle: input.mrTitle,
  })

  const outcome = await runGuardedAiStage<ReviewEnvelope>({
    caller: input.makeCaller(prompt, REVIEW_PORT),
    schema: ReviewEnvelopeSchema,
    nonce: input.nonce,
    portName: REVIEW_PORT,
    budget: input.budget,
    semanticCheck: checkReviewSemantics,
    recorder: input.recorder,
    signal: input.signal,
  })

  return { outcome, diffClipped }
}
