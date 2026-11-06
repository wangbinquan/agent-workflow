// RFC-122 — pure / oracle coverage for the per-(task, asking-node) clarify
// directive override ("继续反问 / 停止反问" canvas toggle).
//
// Locks the three pure seams the scheduler stitches at dispatch:
//   1. resolveEffectiveClarifyChannel — the STOP override forces mandatory
//      ask-back OFF for BOTH self-clarify AND cross-questioner (both are
//      hasClarifyChannel=true), and golden-locks the no-override boolean.
//   2. renderUserPrompt — clarifyChannel.injectStopNotice (RFC-148 ADT; the
//      historical clarifyStopNotice boolean) injects the `### User directive:
//      STOP CLARIFYING` trailer on a first-run STOP (no answersBlock), keeps the
//      output protocol, and is suppressed when ask-back is still active.
//   3. buildPromptContext directiveOverride — the toggle rebuilds the LAST
//      round's trailer to STOP CLARIFYING even when the user's last answer
//      clicked "keep clarifying" (the Case-B conflict), for self + cross.
//
// Plus isClarifyAskingNode (the API + canvas display predicate).

import { describe, expect, test } from 'bun:test'
import {
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '../src/modules/task-execution/domain/clarifyRules'
import {
  isClarifyAskingNode,
  renderUserPrompt,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

const MANDATORY = 'MANDATORY ASK-BACK (clarify) mode'
const STOP_TRAILER = '### User directive: STOP CLARIFYING'
const OUTPUT_PROTO = 'You MUST end your reply with a'

function renderMinimal(extra: Partial<Parameters<typeof renderUserPrompt>[0]>): string {
  return renderUserPrompt({
    inputs: {},
    meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
    agentOutputs: ['result'],
    ...extra,
  })
}

// ---------------------------------------------------------------------------
// 1. resolveEffectiveClarifyChannel
// ---------------------------------------------------------------------------
describe('RFC-122 resolveEffectiveClarifyChannel', () => {
  test('golden-lock: nodeStopOverride=false reproduces the pre-RFC-122 boolean', () => {
    // The exact expression it replaced:
    //   hasClarifyChannel && contextDirective !== 'stop' && (!reviewActive || isClarifyRerun)
    for (const hasClarifyChannel of [true, false]) {
      for (const contextDirective of ['continue', 'stop', undefined] as const) {
        for (const reviewActive of [true, false]) {
          for (const isClarifyRerun of [true, false]) {
            const expected =
              hasClarifyChannel && contextDirective !== 'stop' && (!reviewActive || isClarifyRerun)
            expect(
              resolveEffectiveClarifyChannel({
                hasClarifyChannel,
                contextDirective,
                nodeStopOverride: false,
                reviewActive,
                isClarifyRerun,
              }),
            ).toBe(expected)
          }
        }
      }
    }
  })

  test('STOP override forces ask-back OFF for self AND cross (hasClarifyChannel covers both)', () => {
    // A self-clarify agent and a cross-questioner are indistinguishable here:
    // both wire the same `__clarify__` source port ⇒ hasClarifyChannel=true.
    for (const contextDirective of ['continue', 'stop', undefined] as const) {
      for (const reviewActive of [true, false]) {
        for (const isClarifyRerun of [true, false]) {
          expect(
            resolveEffectiveClarifyChannel({
              hasClarifyChannel: true,
              contextDirective,
              nodeStopOverride: true,
              reviewActive,
              isClarifyRerun,
            }),
          ).toBe(false)
        }
      }
    }
  })

  test('override is moot on a non-asking node (hasClarifyChannel=false stays false)', () => {
    expect(
      resolveEffectiveClarifyChannel({
        hasClarifyChannel: false,
        nodeStopOverride: true,
        reviewActive: false,
        isClarifyRerun: false,
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. renderUserPrompt — injectStopNotice (first-run STOP injection)
// ---------------------------------------------------------------------------
describe('RFC-122 renderUserPrompt clarifyChannel.injectStopNotice', () => {
  test('first-run STOP: injects STOP CLARIFYING + output protocol, no mandatory ask-back', () => {
    const out = renderMinimal({
      clarifyChannel: { kind: 'self', directive: 'stopped', injectStopNotice: true },
    })
    expect(out).toContain(STOP_TRAILER)
    expect(out).toContain(OUTPUT_PROTO)
    expect(out).not.toContain(MANDATORY)
  })

  test('golden-lock: no notice + mandatory clarify channel ⇒ mandatory ask-back appended (today)', () => {
    const out = renderMinimal({
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    })
    expect(out).toContain(MANDATORY)
    expect(out).not.toContain(STOP_TRAILER)
  })

  test('golden-lock: a plain output node is byte-identical with clarifyChannel omitted vs kind:none vs stopped-without-notice', () => {
    const base = renderMinimal({})
    const explicitNone = renderMinimal({ clarifyChannel: { kind: 'none' } })
    // The nearest new-shape spelling of the historical `clarifyStopNotice: false`.
    const stoppedNoNotice = renderMinimal({
      clarifyChannel: { kind: 'self', directive: 'stopped', injectStopNotice: false },
    })
    expect(explicitNone).toBe(base)
    expect(stoppedNoNotice).toBe(base)
    expect(base).not.toContain(STOP_TRAILER)
  })

  test('guard: injectStopNotice is ignored while ask-back is still active (mandatory wins)', () => {
    // Defensive — the scheduler never sets both, but the renderer must not double-talk.
    const out = renderMinimal({
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: true },
    })
    expect(out).toContain(MANDATORY)
    expect(out).not.toContain(STOP_TRAILER)
  })
})

// ---------------------------------------------------------------------------
// 4. isClarifyAskingNode — API + canvas display predicate
// ---------------------------------------------------------------------------
describe('RFC-122 isClarifyAskingNode', () => {
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'selfAgent', kind: 'agent-single', agentName: 'a' },
      { id: 'clar', kind: 'clarify' },
      { id: 'questioner', kind: 'agent-single', agentName: 'q' },
      { id: 'cc1', kind: 'clarify-cross-agent' },
      { id: 'plain', kind: 'agent-single', agentName: 'p' },
    ] as WorkflowDefinition['nodes'],
    edges: [
      // self-clarify channel
      {
        id: 'e1',
        source: { nodeId: 'selfAgent', portName: '__clarify__' },
        target: { nodeId: 'clar', portName: 'questions' },
      },
      // cross-clarify channel (questioner → cross node)
      {
        id: 'e2',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
    ],
  }

  test('true for a self-clarify agent and a cross-questioner', () => {
    expect(isClarifyAskingNode(def, 'selfAgent')).toBe(true)
    expect(isClarifyAskingNode(def, 'questioner')).toBe(true)
  })

  test('false for the clarify / cross channel nodes and a plain agent', () => {
    // The toggle must NOT appear on the channel nodes (they are edge targets).
    expect(isClarifyAskingNode(def, 'clar')).toBe(false)
    expect(isClarifyAskingNode(def, 'cc1')).toBe(false)
    expect(isClarifyAskingNode(def, 'plain')).toBe(false)
  })
})

describe('RFC-122 H2 shouldInjectStopNotice', () => {
  test('truth table', () => {
    // Inject ⟺ override is stop AND the context does not already carry the trailer.
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: undefined })).toBe(
      true,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'continue' })).toBe(
      true,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: true, contextDirective: 'stop' })).toBe(false)
    // No override ⇒ never inject (golden-lock — the trailer source is unchanged).
    expect(shouldInjectStopNotice({ nodeStopOverride: false, contextDirective: undefined })).toBe(
      false,
    )
    expect(shouldInjectStopNotice({ nodeStopOverride: false, contextDirective: 'continue' })).toBe(
      false,
    )
  })
})
