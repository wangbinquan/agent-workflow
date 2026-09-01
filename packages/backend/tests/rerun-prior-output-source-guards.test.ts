// RFC-119 / RFC-141 — source-text regression guards for the scheduler wiring.
//
// The scheduler injection point lives inside a multi-thousand-line function that
// is impractical to drive end-to-end here, so these textual locks back-stop the
// behavioral tests:
//   - the generalized prior-output computation keeps the inline-resume skip gate,
//     and (RFC-141, user ruling) must NOT re-grow the two gates that were removed:
//     the RFC-119 D6 mandatory ask-back suppression (disproved premise — a node
//     with a done draft re-enters ask-back on every new answer batch; evidence
//     QMGP5 agent_m7p3n1 retry 17) and the RFC-120 §18 override-handoff
//     suppression. The ask-back round now renders the draft with the ask-back
//     directive variant (see shared/tests/rerun-prior-output.test.ts).
//   - priorDoneGenerationsForRun stays `done`-only. RFC-119 deliberately did NOT
//     relax it (that would let review-supersede canceled rows inflate the clarify
//     generation count); the broad lookup is the SEPARATE freshestPriorRunWithOutput.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NODE_MECHANICS_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf8',
)

describe('RFC-119 — node mechanics source guards', () => {
  test('the broad selector exists and is exported', () => {
    expect(NODE_MECHANICS_SRC).toContain('export async function freshestPriorRunWithOutput')
    expect(NODE_MECHANICS_SRC).toContain('export async function composePriorOutputBlock')
  })

  test('generalized priorOutputUpdate computation: inline gate stays, RFC-141-removed gates stay gone', () => {
    // RFC-132 (PR-C): the cross-clarify-specific prior-output block (crossClarifyContext.
    // priorOutputBlock) was removed — a designer responding to feedback now surfaces its working
    // draft through THIS single generalized path. RFC-141 (user ruling) then removed two of the
    // three skip gates: the RFC-120 §18 override-handoff suppression and the RFC-119 D6 mandatory
    // ask-back suppression. Only the inline-session-resume gate remains (the resumed session
    // already holds the prior output). Isolate the block from the priorOutputUpdate declaration
    // to the dispatch site.
    const start = NODE_MECHANICS_SRC.indexOf('let priorOutputUpdate:')
    expect(start).toBeGreaterThan(-1)
    const region = NODE_MECHANICS_SRC.slice(start, start + 900)
    expect(region).toContain('!resumeDecision.inlineMode')
    expect(region).toContain('freshestPriorRunWithOutput')
    // RFC-141 negative locks — a revert that re-adds either removed gate goes red here.
    expect(region).not.toContain('!suppressPriorOutput')
    expect(region).not.toContain('!effectiveHasClarifyChannel')
    // The generation-only isCrossClarifyTriggeredRerun proxy stays GONE (Codex impl gate P2), and
    // the removed cross-clarify ownership signal must not linger either.
    expect(region).not.toContain('!isCrossClarifyTriggeredRerun')
    expect(region).not.toContain('crossClarifyOwnsPriorOutput')
  })

  test('priorDoneGenerationsForRun stays done-only (must NOT be widened)', () => {
    const start = NODE_MECHANICS_SRC.indexOf('async function priorDoneGenerationsForRun')
    expect(start).toBeGreaterThan(-1)
    const region = NODE_MECHANICS_SRC.slice(start, start + 700)
    expect(region).toContain("status: 'done'")
    expect(region).toContain('persistence.list({')
  })
})
