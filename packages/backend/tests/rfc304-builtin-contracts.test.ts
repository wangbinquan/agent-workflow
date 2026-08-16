// RFC-304 — the registry's self-consistency check, actually run.
//
// `checkBuiltinContracts()` was written in PR-1a with a header saying it "runs
// in tests, not on the hot path". It had no caller anywhere. That is the same
// shape this RFC has hit repeatedly — a mechanism complete, tested in isolation
// and never joined to anything — and it is invisible precisely because an
// unrun check never reports a problem.
//
// What it catches is an authoring mistake: a stage whose input nothing upstream
// produces, two stages sharing a name (hooks mount by name, so one hook would
// fire twice or against the wrong stage), or an `invoke` range that does not
// exist in its target. Those are cheap to catch here and expensive to catch on
// someone's merge request, where the round fails halfway through with a missing
// artifact.
//
// The reverse half matters as much as the forward one: a checker that silently
// matches nothing would keep this file green forever.

import { describe, expect, test } from 'bun:test'
import {
  MR_COMMENT_FIX_CONTRACT,
  MR_REVIEW_CONTRACT,
  checkBuiltinContracts,
  lookupStageContract,
  registeredCapabilities,
} from '../src/modules/code-capability/domain/capabilityRegistry'
import {
  validateStageContract,
  type StageContract,
} from '../src/modules/code-capability/domain/stageContract'

describe('RFC-304 — every shipped contract is self-consistent', () => {
  test('the registry has no issues', () => {
    expect(checkBuiltinContracts()).toEqual([])
  })

  test('the registry is not empty — the check has something to check', () => {
    // The precondition. An empty registry would make the assertion above pass
    // for the wrong reason, forever.
    expect(registeredCapabilities().length).toBeGreaterThan(0)
    expect(lookupStageContract('mr-review')).toBeDefined()
    expect(lookupStageContract('mr-comment-fix')).toBeDefined()
  })

  test('reverse: an unsatisfied input IS reported', () => {
    const broken: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [{ kind: 'program', name: 'push', requires: ['verified'], produces: [] }],
    }
    const issues = validateStageContract(broken)
    expect(issues.map((i) => i.code)).toContain('stage-requires-unsatisfied')
  })

  test('reverse: a duplicate stage name IS reported', () => {
    const broken: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        { kind: 'program', name: 'fix', requires: [], produces: ['a'] },
        { kind: 'program', name: 'fix', requires: [], produces: ['b'] },
      ],
    }
    expect(validateStageContract(broken).map((i) => i.code)).toContain('stage-name-duplicate')
  })
})

describe('RFC-304 §6.2 — the mr-comment-fix sequence', () => {
  const stages = MR_COMMENT_FIX_CONTRACT.stages
  const names = stages.map((s) => s.name)

  test('the design’s stage list is the implemented one, in order', () => {
    expect(names).toEqual([
      'resolve-target',
      'collect-thread',
      'prepare-worktree',
      'apply-change',
      'validate-change',
      'decide-form',
      'publish-suggestion',
      'post-patch',
      'verify-baseline',
      'push',
    ])
  })

  test('exactly ONE stage involves a model, and it is the one that writes code', () => {
    // Constitution R1, read straight off the contract. Reading the thread,
    // judging the edit, choosing the form, checking the base and pushing are
    // all decisions a program makes.
    const ai = stages.filter((s) => s.kind === 'ai')
    expect(ai.map((s) => s.name)).toEqual(['apply-change'])
  })

  test('the model stage is sealed by a schema and bound to a named slot', () => {
    // R3: a schema-less AI stage is a hole through the determinism guarantee.
    const apply = stages.find((s) => s.name === 'apply-change')
    expect(apply?.kind).toBe('ai')
    expect(apply?.kind === 'ai' && apply.aiSchema).toBeDefined()
    expect(apply?.kind === 'ai' && apply.agentSlot).toBe('fixer')
  })

  test('the fixer slot is distinct from the reviewer slot', () => {
    // Reviewing and editing are different jobs with different prompts. A team
    // that wants one agent for both points both slots at it; merging the slots
    // would take that choice away.
    const reviewer = MR_REVIEW_CONTRACT.stages.find((s) => s.kind === 'ai')
    const fixer = stages.find((s) => s.kind === 'ai')
    expect(reviewer?.kind === 'ai' && reviewer.agentSlot).not.toBe(
      fixer?.kind === 'ai' && fixer.agentSlot,
    )
  })

  test('both terminal forms are declared stages, not a branch hidden in one', () => {
    // A hook mounts on a stage NAME. Deciding the form inside a single
    // "publish" stage would silently give teams half the mount points the
    // contract promises them.
    expect(names).toContain('publish-suggestion')
    expect(names).toContain('post-patch')
  })

  test('the push path can only be reached through a baseline check', () => {
    // The C7 guard, expressed structurally: `push` requires what
    // `verify-baseline` produces, so a sequence that skipped the check could
    // not satisfy the contract.
    const push = stages.find((s) => s.name === 'push')
    expect(push?.requires).toContain('verified')
    const verify = stages.find((s) => s.name === 'verify-baseline')
    expect(verify?.produces).toContain('verified')
    // …and the verification is about the frozen artifact, not a fresh change.
    expect(verify?.requires).toContain('pendingArtifact')
  })

  test('the fixer may be given extra context by a hook, but not the whole change', () => {
    // The injectable allowlist is what keeps "program stages are deterministic"
    // true in the presence of a creative hook.
    const apply = stages.find((s) => s.name === 'apply-change')
    expect(apply?.injectable).toEqual(['promptSuffix', 'extraContext'])
    for (const stage of stages) {
      if (stage.name === 'apply-change') continue
      expect(stage.injectable ?? []).toEqual([])
    }
  })
})
