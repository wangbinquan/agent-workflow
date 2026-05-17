// RFC-026 — inline-mode prompt rendering.
//
// Locks in:
//   1. `mode === 'inline'` suppresses the prior-rounds questions section, emits
//      a "User Answers (Current Round)" section with just the latest answers,
//      and replaces the trailing protocol block with the short inline reminder.
//   2. Default (no `mode` / `mode === 'isolated'`) output is BYTE-FOR-BYTE
//      identical to what RFC-023 produced before this RFC — proposal §4 A1
//      (regression hard contract).
//
// If these go red, RFC-026's "default isolated preserves RFC-023 verbatim"
// claim is broken — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import { buildClarifyInlineReminder, renderUserPrompt } from '@agent-workflow/shared'

const META = { repoPath: '/r', baseBranch: 'main', taskId: 'tk_1' }

describe('RFC-026 renderUserPrompt — inline mode', () => {
  test('inline mode skips prior-rounds questions section', () => {
    const out = renderUserPrompt({
      promptTemplate: 'go',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        questionsBlock: 'Q-PRIOR-CONTENT', // would have been emitted under isolated
        answersBlock: 'A-LATEST-CONTENT',
        iteration: '1',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).not.toContain('Prior Rounds (Questions)')
    expect(out).not.toContain('Q-PRIOR-CONTENT')
  })

  test('inline mode emits "User Answers (Current Round)" with the latest answers', () => {
    const out = renderUserPrompt({
      promptTemplate: 'go',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        answersBlock: 'A-LATEST-CONTENT',
        iteration: '1',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).toContain('Clarify Q&A — User Answers (Current Round)')
    expect(out).toContain('A-LATEST-CONTENT')
    expect(out).not.toContain('Prior Rounds (Answers)')
  })

  test('inline mode replaces the trailing block with the inline reminder, no full bi-modal preamble', () => {
    const out = renderUserPrompt({
      promptTemplate: 'go',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        answersBlock: 'A-LATEST-CONTENT',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).toContain(buildClarifyInlineReminder().trim())
    // Full bi-modal preamble / clarify format block must NOT be re-emitted
    expect(out).not.toContain('This node has a clarify channel.')
    expect(out).not.toContain('Both envelopes are equally first-class')
    expect(out).not.toContain('Clarify mode is enabled for this node')
    // Legacy single-envelope wording must also not appear
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })

  test('inline reminder mentions both envelope choices and "session" continuity', () => {
    const reminder = buildClarifyInlineReminder()
    expect(reminder).toContain('<workflow-output>')
    expect(reminder).toContain('<workflow-clarify>')
    expect(reminder).toContain('User Answers (Current Round)')
    expect(reminder).toMatch(/session/i)
  })

  // ---------------------------------------------------------------------------
  // RFC-026 regression hard contract — isolated path stays byte-for-byte.
  // ---------------------------------------------------------------------------

  test('default (no mode) preserves RFC-023 bi-modal output byte-for-byte', () => {
    const baseInput = {
      promptTemplate: 'go',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        questionsBlock: 'Q-PRIOR',
        answersBlock: 'A-PRIOR',
        iteration: '1',
      },
    }
    const out = renderUserPrompt(baseInput)
    // Both prior-round sections present, legacy headings unchanged
    expect(out).toContain('Clarify Q&A — Prior Rounds (Questions)')
    expect(out).toContain('Clarify Q&A — Prior Rounds (Answers)')
    expect(out).toContain('Q-PRIOR')
    expect(out).toContain('A-PRIOR')
    // RFC-023 bi-modal preamble + clarify format both fired
    expect(out).toContain('This node has a clarify channel.')
    expect(out).toContain('Clarify mode is enabled for this node')
    // Inline reminder must NOT leak into isolated path
    expect(out).not.toContain('User Answers (Current Round)')
    expect(out).not.toContain(
      'Earlier rounds, the full envelope formats, and the asking-back rules are still in this session',
    )
  })

  test('explicit mode === "isolated" matches undefined mode byte-for-byte', () => {
    const ctxA = { answersBlock: 'X', questionsBlock: 'Y', iteration: '2' }
    const ctxB = { ...ctxA, mode: 'isolated' as const }
    const a = renderUserPrompt({
      promptTemplate: 'p',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: ctxA,
    })
    const b = renderUserPrompt({
      promptTemplate: 'p',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: ctxB,
    })
    expect(b).toBe(a)
  })
})
