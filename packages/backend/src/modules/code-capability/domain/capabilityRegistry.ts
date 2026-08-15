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
  // every round, so a second round reposted the whole review.
  version: 3,
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
    // The one model step. A team may prepend material to what it is shown.
    {
      kind: 'ai',
      name: 'review',
      requires: ['diff', 'mrMeta'],
      produces: ['findings'],
      injectable: ['extraContext'],
      aiSchema: ReviewEnvelopeSchema,
      // Which group-layer agent binding runs it. Named rather than hardcoded so
      // a team points the reviewer at its own agent without forking the
      // sequence (the two-layer config of §5).
      agentSlot: REVIEW_AGENT_SLOT,
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

const BUILTIN_CONTRACTS: readonly StageContract[] = [MR_REVIEW_CONTRACT]

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
