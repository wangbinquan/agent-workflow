// RFC-306 — the branch contract as the AGENT sees it.
//
// Why this file exists: the feature is only usable if the model is told the rule.
// Declaring a branch port changes nothing about the ports the agent must emit —
// it changes what ONE of them means — so an agent that never reads the rule will
// either never close a branch, or invent syntax and get rejected.
//
// Three paths render an output format, and each was checked by hand and found
// wanting at least once:
//   1. the ordinary protocol block (no clarify channel);
//   2. the OPTIONAL clarify dual block ("Option B — finalize"), which is the
//      only output format such a round shows — it was missing the paragraph
//      entirely until this suite went red;
//   3. the follow-up prompt after a rejected marker, whose `branchMarkerDetail`
//      was declared and consumed but never produced by any caller.
// The MANDATORY clarify round deliberately renders NO output format at all, so
// it must NOT gain a branch paragraph — that case is locked here too.

import { describe, expect, test } from 'bun:test'
import {
  buildOptionalDualProtocolBlock,
  buildProtocolBlock,
  renderEnvelopeFollowupPrompt,
  renderUserPrompt,
} from '../src/prompt'

const OUTPUTS = ['report', 'need_fix', 'all_clear']
const BRANCH = ['need_fix', 'all_clear']

/** The one sentence that makes the mechanism discoverable. */
const MARKER_SYNTAX = 'active="false"'

describe('RFC-306 — branch guidance in the output protocol block', () => {
  test('declared branch ports produce an explicit paragraph naming them', () => {
    const block = buildProtocolBlock(OUTPUTS, undefined, 'N0NCE', BRANCH)
    expect(block).toContain('Branch ports')
    expect(block).toContain('`need_fix`')
    expect(block).toContain('`all_clear`')
    expect(block).toContain(MARKER_SYNTAX)
    // The two rules an agent gets wrong without being told:
    expect(block).toContain('still emit the port')
    expect(block).toContain('never passed to any downstream node')
  })

  test('NO declared branch ports ⇒ not one byte about branches', () => {
    // This is the compatibility half: an agent that has no branch ports must see
    // exactly the prompt it saw before RFC-306.
    const before = buildProtocolBlock(OUTPUTS, undefined, 'N0NCE')
    const withEmpty = buildProtocolBlock(OUTPUTS, undefined, 'N0NCE', [])
    expect(withEmpty).toBe(before)
    expect(before).not.toContain('Branch ports')
    expect(before).not.toContain(MARKER_SYNTAX)
  })

  test('a branchPorts entry that is not a declared output is ignored', () => {
    // Defence in depth against a stale sidecar: the paragraph must never name a
    // port the agent is not being asked to emit (the backend also rejects the
    // mismatch at save time).
    const block = buildProtocolBlock(OUTPUTS, undefined, 'N0NCE', ['ghost'])
    expect(block).not.toContain('Branch ports')
  })
})

describe('RFC-306 — the OPTIONAL clarify round shows it too', () => {
  test('Option B (finalize) carries the branch paragraph', () => {
    // Regression: this path renders the ONLY output format an optional-clarify
    // round ever sees. Without the paragraph, such a node could not close a
    // branch at all.
    const block = buildOptionalDualProtocolBlock(OUTPUTS, undefined, 'N0NCE', BRANCH)
    expect(block).toContain('Option B')
    expect(block).toContain('Branch ports')
    expect(block).toContain(MARKER_SYNTAX)
  })

  test('renderUserPrompt threads it end to end on the optional-clarify arm', () => {
    // The arm is selected by the CHANNEL DIRECTIVE ('optional' → invite-optional),
    // not by a context flag. Getting this wrong is how an assertion ends up with
    // zero oracle power: the ordinary arm also contains the paragraph, so a
    // mis-shaped input passes while proving nothing. Mutation-verified — with
    // the forwarding removed from buildOptionalDualProtocolBlock this test goes
    // red, and it did NOT before the shape was corrected.
    const prompt = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/w', baseBranch: 'main', taskId: 't1' },
      agentOutputs: OUTPUTS,
      agentBranchPorts: BRANCH,
      envelopeNonce: 'N0NCE',
      clarifyChannel: { kind: 'self', directive: 'optional' },
    } as Parameters<typeof renderUserPrompt>[0])
    // Proof we are really on the optional arm and not the ordinary one:
    expect(prompt).toContain('Option B')
    expect(prompt).toContain('Branch ports')
    expect(prompt).toContain(MARKER_SYNTAX)
  })

  test('the MANDATORY ask-back round shows NO output format, hence no branch paragraph', () => {
    // That round may not finalize at all, so telling it how to close a branch
    // would invite exactly the reply the runner then rejects.
    const prompt = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/w', baseBranch: 'main', taskId: 't1' },
      agentOutputs: OUTPUTS,
      agentBranchPorts: BRANCH,
      envelopeNonce: 'N0NCE',
      clarifyChannel: { kind: 'self', directive: 'mandatory' },
    } as Parameters<typeof renderUserPrompt>[0])
    expect(prompt).not.toContain('Branch ports')
  })

  test('renderUserPrompt threads it on the ordinary arm', () => {
    const prompt = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/w', baseBranch: 'main', taskId: 't1' },
      agentOutputs: OUTPUTS,
      agentBranchPorts: BRANCH,
      envelopeNonce: 'N0NCE',
    })
    expect(prompt).toContain('Branch ports')
  })
})

describe('RFC-306 — the follow-up after a rejected marker', () => {
  test('names the legal branch ports when the backend supplies them', () => {
    const prompt = renderEnvelopeFollowupPrompt({
      envelopeNonce: 'N0NCE',
      hasClarifyChannel: false,
      reason: 'branch-marker',
      branchMarkerDetail: 'Declared branch ports on this agent: `need_fix`.',
    })
    // The correction must say what was wrong AND what is allowed — an agent
    // told only "that was rejected" has no way to pick a different port.
    expect(prompt).toContain('branch marking was rejected')
    expect(prompt).toContain('`need_fix`')
    expect(prompt).toContain('drop the marker')
  })

  test('still renders (degraded but coherent) without the detail', () => {
    const prompt = renderEnvelopeFollowupPrompt({
      envelopeNonce: 'N0NCE',
      hasClarifyChannel: false,
      reason: 'branch-marker',
    })
    expect(prompt).toContain('branch marking was rejected')
  })

  test('survives the clarify-off narrowing instead of degrading to envelope-missing', () => {
    // The narrowing coerces clarify-only reasons to 'envelope-missing'. A branch
    // marker slip happens on a perfectly well-formed envelope, so coercing it
    // would tell the agent to re-emit an envelope it already emitted.
    const prompt = renderEnvelopeFollowupPrompt({
      envelopeNonce: 'N0NCE',
      hasClarifyChannel: false,
      reason: 'branch-marker',
    })
    expect(prompt).not.toContain('did not contain a `<workflow-output>` envelope')
  })
})
