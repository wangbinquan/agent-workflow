// RFC-304 — the registry of built-in stage contracts.
//
// One entry per capability, defined in platform code. This is where the
// "deterministic scheduling" constitution becomes inspectable: you can read the
// whole of what a capability does, in order, and see at a glance which steps
// involve a model (`kind: 'ai'`) and which are plain program code.
//
// `assertRegistryIsSelfConsistent` runs in tests, not on the hot path. A fixed
// sequence cannot become invalid at runtime — what it catches is a person
// adding or reordering a stage whose inputs nothing upstream produces, or an
// `invoke` range that does not exist in its target. Catching that at author
// time is the point; catching it on someone's MR is the failure.
//
// PR-4a replaces PR-1a's placeholder with the real `mr-review` sequence. The
// remaining capabilities land with their own PRs, and each is checked by the
// same assertion the day it is added.

import { ReviewEnvelopeSchema } from '@/modules/code-capability/domain/reviewEnvelope'
import {
  CommentFixEnvelopeSchema,
  COMMENT_FIX_AGENT_SLOT,
} from '@/modules/code-capability/domain/commentFixEnvelope'
import {
  CiFixEnvelopeSchema,
  CI_FIX_AGENT_SLOT,
} from '@/modules/code-capability/domain/ciFixEnvelope'
import {
  ComprehendEnvelopeSchema,
  ImplementEnvelopeSchema,
  COMPREHEND_AGENT_SLOT,
  IMPLEMENT_AGENT_SLOT,
} from '@/modules/code-capability/domain/requirementEnvelope'
import { REVIEW_AGENT_SLOT } from '@/modules/code-capability/application/reviewStage'
import {
  validateStageContract,
  type CodeCapabilityId,
  type StageContract,
  type StageContractIssue,
} from '@/modules/code-capability/domain/stageContract'

/**
 * `mr-review` v2 — the real sequence (design §6.1), replacing PR-1a's
 * three-stage placeholder.
 *
 * Spelled out stage by stage rather than as one "run a review" step, and that
 * is not bookkeeping: the engine fires hooks at each BOUNDARY, so a sequence
 * collapsed into fewer stages silently removes the injection and blocking
 * points a team is promised. An assembly that ran the whole chain internally
 * would pass its own tests and quietly have no hooks at all.
 *
 * Reading it top to bottom answers the question the constitution exists for:
 * exactly one stage here involves a model. Everything that decides — which MR,
 * which commit, which findings survive the gate, where each one is placed, what
 * gets published — is program code.
 */
export const MR_REVIEW_CONTRACT: StageContract = {
  capability: 'mr-review',
  // 3: PR-4b added `reconcile` and `settle-stale`. PR-4a published every finding
  //    every round, so a second round reposted the whole review.
  // 4: PR-4b replaced the single `review` stage with the design's
  //    `split-diff → review-shard → review-global → validate-findings`. One
  //    reviewer reading a 40-file MR silently reviews whatever fits its context.
  version: 4,
  stages: [
    // Which MR, at which commit. Refuses rather than defaulting (§6).
    { kind: 'program', name: 'resolve-target', requires: [], produces: ['target'] },
    // Also the staleness guard: a head that moved aborts the round HERE, before
    // a model call is spent on an already-obsolete revision.
    { kind: 'program', name: 'prepare-worktree', requires: ['target'], produces: ['worktree'] },
    // The host's own diff — the anchoring baseline every later stage judges
    // against, and the reason `mr.get` runs with it (GitLab positions need
    // diff_refs, which the diff endpoint does not return).
    {
      kind: 'program',
      name: 'fetch-diff',
      requires: ['target', 'worktree'],
      produces: ['diff', 'mrMeta'],
    },
    // Deterministic, by directory, under a line cap. A program stage because
    // nothing here needs judgement — and a model asked to "split this sensibly"
    // would split it differently on a re-run of the same MR.
    { kind: 'program', name: 'split-diff', requires: ['diff'], produces: ['shards'] },
    // The parallel model segment, one shard at a time up to the concurrency
    // bound, each in its own disposable tree. `parallel` so hooks fire once
    // around the WHOLE segment: per-shard firing would multiply a hook's side
    // effects by the shard count.
    {
      kind: 'ai',
      name: 'review-shard',
      parallel: true,
      requires: ['shards', 'mrMeta', 'worktree'],
      produces: ['shardFindings'],
      injectable: ['extraContext'],
      aiSchema: ReviewEnvelopeSchema,
      // Which group-layer agent binding runs it. Named rather than hardcoded so
      // a team points the reviewer at its own agent without forking the
      // sequence (the two-layer config of §5).
      agentSlot: REVIEW_AGENT_SLOT,
    },
    // The pass sharding structurally cannot do: a caller changed in one shard
    // and its callee in another looks correct to both (proposal B6 / AC-2).
    // Same slot as the shards — one reviewer agent does both passes; a separate
    // slot would make a team bind two agents to do one job.
    {
      kind: 'ai',
      name: 'review-global',
      requires: ['shardFindings', 'diff', 'mrMeta'],
      produces: ['globalFindings'],
      injectable: ['extraContext'],
      aiSchema: ReviewEnvelopeSchema,
      agentSlot: REVIEW_AGENT_SLOT,
    },
    // Merges the two model passes into the one set everything downstream reads.
    // Structure and closed-set only (T25) — whether a line is inside the diff
    // is anchoring, and it is judged at `resolve-positions`.
    {
      kind: 'program',
      name: 'validate-findings',
      requires: ['shardFindings', 'globalFindings'],
      produces: ['findings'],
    },
    // Deterministic sort → threshold → cap. Before positions on purpose:
    // positioning findings that are then discarded reports anchoring failures
    // for remarks nobody was going to see.
    { kind: 'program', name: 'gate', requires: ['findings'], produces: ['gated'] },
    {
      kind: 'program',
      name: 'resolve-positions',
      requires: ['gated', 'diff'],
      produces: ['placements'],
    },
    // Three sets, not "dedupe": a finding the author has NOT fixed is present
    // in both this round and the ledger, and the first draft's dedupe-plus-
    // cleanup pair would suppress the new comment AND resolve the old thread —
    // leaving the MR with no live remark about a problem that is still there,
    // which is the case that most needs to be visible (§6.1).
    {
      kind: 'program',
      name: 'reconcile',
      requires: ['placements', 'target'],
      produces: ['reconciled'],
    },
    {
      kind: 'program',
      name: 'publish',
      requires: ['reconciled', 'target', 'mrMeta'],
      produces: ['published'],
    },
    // After publishing, never before: a finding that stopped appearing gets its
    // thread settled once, on the active→disappeared EDGE. Firing it every
    // round is what produced 78 identical "no longer present" replies on one
    // long-lived MR.
    {
      kind: 'program',
      name: 'settle-stale',
      requires: ['reconciled', 'published', 'target'],
      produces: ['settled'],
    },
    {
      kind: 'program',
      name: 'ledger',
      requires: ['published', 'settled', 'reconciled'],
      produces: ['ledgerEntry'],
    },
  ],
}

/**
 * `mr-comment-fix` v1 — answering a reviewer's comment with code (design §6.2).
 *
 * ```
 * resolve-target → collect-thread → prepare-worktree → apply-change(ai)
 *   → validate-change → decide-form → publish-suggestion
 *                                   ↘ post-patch → [awaiting] → verify-baseline → push
 * ```
 *
 * The branch at `decide-form` is the shape of the whole capability, and it is a
 * PROGRAM decision (T41): a small single-file edit becomes a native suggestion
 * the reviewer applies with one click and no repository write access, and
 * anything else becomes a posted diff that waits for an explicit confirmation.
 * Both terminal stages are declared here rather than resolved at runtime,
 * because a hook mounts on a stage NAME — a branch hidden inside one stage
 * would silently offer teams half the mount points they were promised.
 *
 * Exactly one stage involves a model, and it is the one that writes code.
 * Reading the thread, judging the edit, choosing the form, checking the base and
 * pushing are all decisions a program can make.
 */
export const MR_COMMENT_FIX_CONTRACT: StageContract = {
  capability: 'mr-comment-fix',
  version: 1,
  stages: [
    { kind: 'program', name: 'resolve-target', requires: [], produces: ['target'] },
    // The whole thread, not just the comment that woke us: a reviewer's point
    // is routinely spread over a reply chain ("see above", "same as the other
    // one"), and answering only the last message answers the wrong question.
    {
      kind: 'program',
      name: 'collect-thread',
      requires: ['target'],
      produces: ['thread', 'threadAnchor'],
    },
    {
      kind: 'program',
      name: 'prepare-worktree',
      requires: ['target'],
      produces: ['worktree'],
    },
    {
      kind: 'ai',
      name: 'apply-change',
      requires: ['thread', 'threadAnchor', 'worktree'],
      produces: ['change'],
      injectable: ['promptSuffix', 'extraContext'],
      aiSchema: CommentFixEnvelopeSchema,
      agentSlot: COMMENT_FIX_AGENT_SLOT,
    },
    // Structural checks on what the model actually did to the tree — that it
    // changed something, and that it stayed inside the repository. Not a review
    // of whether the fix is right; that judgement belongs to the human whose
    // comment started this.
    {
      kind: 'program',
      name: 'validate-change',
      requires: ['change', 'worktree'],
      produces: ['validated'],
    },
    // Suggestion or patch (T41). Deterministic: one file and a contiguous span
    // inside the threshold, or not.
    {
      kind: 'program',
      name: 'decide-form',
      requires: ['validated'],
      produces: ['form'],
    },
    // Terminal for the suggestion path. Posting it SETTLES the round — whether
    // the reviewer clicks apply is theirs to decide and the host's to record,
    // and watching for it would mean polling (N7).
    {
      kind: 'program',
      name: 'publish-suggestion',
      requires: ['form', 'threadAnchor', 'target'],
      produces: ['published'],
    },
    // The patch path: freeze the change as an artifact, post the diff carrying
    // its digest, and wait. Freezing here rather than at confirmation time is
    // what makes the eventual push the change the human actually read (T2c).
    {
      kind: 'program',
      name: 'post-patch',
      requires: ['form', 'validated', 'threadAnchor', 'target'],
      produces: ['pendingArtifact'],
    },
    // Resumed by the confirmation, not reached in the first pass. Re-checks the
    // remote head against the artifact's base: the branch can move while a
    // person is deciding, and applying a change built on what it used to be
    // would clobber whatever arrived in between (C7).
    {
      kind: 'program',
      name: 'verify-baseline',
      requires: ['pendingArtifact', 'target'],
      produces: ['verified'],
    },
    {
      kind: 'program',
      name: 'push',
      requires: ['verified', 'pendingArtifact'],
      produces: ['pushed'],
    },
  ],
}

/**
 * `requirement` v1 — building from an issue or a design set (design §6.3).
 *
 * ```
 * resolve-input → materialize-attachments → prepare-worktree
 *   → comprehend(ai) → [needs-clarification → clarify → awaiting]
 *   → implement(ai) → run-target-gate → self-review(invoke) → open-mr → ledger
 * ```
 *
 * Two stages involve a model and they are deliberately separate. `comprehend`
 * decides whether the requirement says enough to build; `implement` builds it.
 * Merged into one, there would be nowhere to stop and ask — and an agent that
 * cannot ask will not ask: it fills the gap with the most plausible reading and
 * produces a merge request implementing a requirement nobody wrote.
 *
 * `self-review` is an `invoke`, the first in the registry. It runs `mr-review`'s
 * core reading stages against the tree this round just built, WITHOUT the
 * publishing half — there is no merge request yet to publish to, and the point
 * is to catch the problem before a human is asked to look. Reusing the review's
 * own stages rather than re-describing them is what keeps the two from drifting.
 */
export const REQUIREMENT_CONTRACT: StageContract = {
  capability: 'requirement',
  version: 1,
  stages: [
    // Parameters when they were given, an entry script when only a reference
    // was (design D5). Either way the round starts from a document SET.
    { kind: 'program', name: 'resolve-input', requires: [], produces: ['requirement'] },
    {
      kind: 'program',
      name: 'materialize-attachments',
      requires: ['requirement'],
      produces: ['attachments'],
    },
    {
      kind: 'program',
      name: 'prepare-worktree',
      requires: ['requirement'],
      produces: ['worktree'],
    },
    {
      kind: 'ai',
      name: 'comprehend',
      requires: ['requirement', 'attachments', 'worktree'],
      produces: ['understanding'],
      injectable: ['promptSuffix', 'extraContext'],
      aiSchema: ComprehendEnvelopeSchema,
      agentSlot: COMPREHEND_AGENT_SLOT,
    },
    // Reached only when `comprehend` asked. Posts the questions where the
    // requirement came from (D2) and settles the round `awaiting`; the answer
    // resumes at `comprehend`, which is why the recovery for this wait kind
    // DOES re-run the model — the answer changes the reading (T4b).
    {
      kind: 'program',
      name: 'clarify',
      requires: ['understanding', 'requirement'],
      produces: ['clarification'],
    },
    {
      kind: 'ai',
      name: 'implement',
      requires: ['understanding', 'worktree'],
      produces: ['implementation'],
      injectable: ['promptSuffix', 'extraContext'],
      aiSchema: ImplementEnvelopeSchema,
      agentSlot: IMPLEMENT_AGENT_SLOT,
    },
    // The TARGET repository's own gate, read from its CLAUDE.md / CONTRIBUTING
    // rather than configured here: a platform that hardcoded `npm test` would
    // be wrong in most repositories and confidently so.
    {
      kind: 'program',
      name: 'run-target-gate',
      requires: ['implementation', 'worktree'],
      produces: ['gateResult'],
    },
    {
      kind: 'invoke',
      name: 'self-review',
      requires: ['gateResult', 'worktree'],
      produces: ['selfFindings'],
      invokes: {
        capability: 'mr-review',
        from: 'split-diff',
        to: 'validate-findings',
        // The tree this round built, and the commit it started from. The right
        // side of the diff is a snapshot of that tree taken here — see
        // `StageDef`'s `invokes`.
        worktreeFrom: 'worktree',
        diffLeftFrom: 'worktree',
      },
      // `mr-review` calls it `findings`; here it is findings about our OWN
      // work, which is a different thing to the next stage and to a reader.
      collect: { selfFindings: 'findings' },
    },
    {
      kind: 'program',
      name: 'open-mr',
      requires: ['implementation', 'selfFindings', 'worktree'],
      produces: ['producedMr'],
    },
    { kind: 'program', name: 'ledger', requires: ['producedMr'], produces: ['ledgerEntry'] },
  ],
}

/**
 * `ci-fix` v1 — making a red pipeline green (design §6.4).
 *
 * ```
 * collect(script) → classify(script) → arbitrate(script) → select(script)
 *   → prepare-worktree → fix(ai) → validate-fix(program) → self-review(invoke)
 *   → anti-cheat-check(program) → push(program) → ledger
 * ```
 *
 * The four scripts at the front are the department's, not the platform's: which
 * pipeline, which logs, what counts as an issue and which agent handles it are
 * all things the platform cannot know about somebody else's CI system. They are
 * the same four the monitor runs, and they run here because a `ci-fix` round
 * may be entered directly rather than through the monitor.
 *
 * ## Why `anti-cheat-check` is a stage rather than a check inside `push`
 *
 * The cheapest way to make CI green is to delete the test. This stage exists to
 * notice that, and it is separate because its verdict is not binary: it can
 * ALLOW (the evidence shows the test was really failing), REJECT (the evidence
 * shows the test was passing, so this change broke it), or ESCALATE (no
 * evidence either way — nothing is pushed and a person looks). Only the middle
 * one is a failure. Folded into `push`, the third outcome would have nowhere to
 * live and would collapse into one of the other two.
 *
 * `self-review` runs BEFORE it, in a separate session, looking at this round's
 * diff — a deleted assertion is a conspicuous finding to a reader that is not
 * the author. It is not a guarantee, but it is not self-assessment either.
 */
export const CI_FIX_CONTRACT: StageContract = {
  capability: 'ci-fix',
  version: 1,
  stages: [
    {
      kind: 'script',
      name: 'collect',
      scriptSlot: 'collect',
      requires: [],
      produces: ['gateState'],
    },
    {
      kind: 'script',
      name: 'classify',
      scriptSlot: 'classify',
      requires: ['gateState'],
      produces: ['issues'],
    },
    {
      kind: 'script',
      name: 'arbitrate',
      scriptSlot: 'arbitrate',
      requires: ['gateState', 'issues'],
      produces: ['workPackage'],
    },
    {
      kind: 'script',
      name: 'select',
      scriptSlot: 'select',
      requires: ['workPackage'],
      produces: ['agentPlan'],
    },
    {
      kind: 'program',
      name: 'prepare-worktree',
      requires: ['gateState'],
      produces: ['worktree', 'baseline'],
    },
    {
      kind: 'ai',
      name: 'fix',
      requires: ['issues', 'workPackage', 'worktree'],
      produces: ['attempt'],
      injectable: ['promptSuffix', 'extraContext'],
      aiSchema: CiFixEnvelopeSchema,
      agentSlot: CI_FIX_AGENT_SLOT,
    },
    // Runs the repository's own gate against the change. This is the stage that
    // decides whether the fix worked — not the agent's report of it.
    {
      kind: 'program',
      name: 'validate-fix',
      requires: ['attempt', 'worktree'],
      produces: ['fixResult'],
    },
    {
      kind: 'invoke',
      name: 'self-review',
      requires: ['fixResult', 'worktree'],
      produces: ['selfFindings'],
      invokes: {
        capability: 'mr-review',
        from: 'split-diff',
        to: 'validate-findings',
        // The tree the fix was made in, and the commit the round started from.
        // The right side is a snapshot of that tree, frozen here: reviewing
        // from the baseline instead would read the code as it was BEFORE the
        // fix, which is a self-review of nothing (design §invoke).
        worktreeFrom: 'worktree',
        diffLeftFrom: 'worktree',
      },
      collect: { selfFindings: 'findings' },
    },
    {
      kind: 'program',
      name: 'anti-cheat-check',
      requires: ['fixResult', 'baseline', 'selfFindings'],
      produces: ['integrity'],
    },
    { kind: 'program', name: 'push', requires: ['integrity', 'fixResult'], produces: ['pushed'] },
    {
      kind: 'program',
      name: 'ledger',
      requires: ['pushed', 'issues'],
      produces: ['ledgerEntry'],
    },
  ],
}

const BUILTIN_CONTRACTS: readonly StageContract[] = [
  MR_REVIEW_CONTRACT,
  MR_COMMENT_FIX_CONTRACT,
  REQUIREMENT_CONTRACT,
  CI_FIX_CONTRACT,
]

const BY_CAPABILITY = new Map<CodeCapabilityId, StageContract>(
  BUILTIN_CONTRACTS.map((c) => [c.capability, c]),
)

export function lookupStageContract(capability: CodeCapabilityId): StageContract | undefined {
  return BY_CAPABILITY.get(capability)
}

export function registeredCapabilities(): readonly CodeCapabilityId[] {
  return [...BY_CAPABILITY.keys()]
}

export type RegistryIssue = StageContractIssue & { capability: CodeCapabilityId }

/**
 * Validate every registered contract against the registry itself, so `invoke`
 * ranges resolve against the real targets rather than a test fixture.
 */
export function checkBuiltinContracts(): RegistryIssue[] {
  const issues: RegistryIssue[] = []
  for (const contract of BUILTIN_CONTRACTS) {
    for (const issue of validateStageContract(contract, lookupStageContract)) {
      issues.push({ ...issue, capability: contract.capability })
    }
  }
  return issues
}
