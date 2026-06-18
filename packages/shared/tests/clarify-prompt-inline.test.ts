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
    expect(out).not.toContain('By default, your next reply should be (B)')
    expect(out).not.toContain('The user has wired it because they expect you to ask back')
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

  // RFC-100: the inline reminder is now mandatory ask-back — it fires only on
  // inline CONTINUE rounds (the stop round routes to the output protocol block,
  // since the inline session never saw the output format). Lock the wording
  // verbatim so a future edit doesn't inadvertently re-touch this string.
  test('RFC-100: inline reminder wording locked verbatim', () => {
    expect(buildClarifyInlineReminder()).toBe(
      '\n\n---\n' +
        'The user has answered your previous `<workflow-clarify>` round (see "Clarify Q&A — User Answers (Current Round)" above). ' +
        'This node stays in MANDATORY ask-back mode until the user clicks "Stop clarifying" — your next reply MUST be another `<workflow-clarify>` envelope. ' +
        'Do not emit `<workflow-output>`; it will be rejected. ' +
        'The full clarify format and asking-back rules from earlier in this session still apply and have not been re-emitted.',
    )
  })

  // ---------------------------------------------------------------------------
  // RFC-026 regression hard contract — isolated path stays byte-for-byte.
  // ---------------------------------------------------------------------------

  test('default (no mode) isolated path renders the RFC-100 mandatory preamble + clarify format', () => {
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
    // RFC-100 mandatory ask-back preamble + clarify format both fired (no output format)
    expect(out).toContain('MANDATORY ASK-BACK')
    expect(out).toContain('Clarify format.')
    expect(out).not.toContain('MUST end your reply with a `<workflow-output>` block')
    // Inline reminder must NOT leak into isolated path
    expect(out).not.toContain('User Answers (Current Round)')
    expect(out).not.toContain(
      'The full clarify format and asking-back rules from earlier in this session still apply',
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

  // -------------------------------------------------------------------------
  // RFC-026 second pass — inline-mode reruns must NOT re-emit input port
  // values. The first-round prompt already shipped them into opencode's
  // session memory; re-substituting + auto-appending burns tokens and risks
  // re-anchoring the agent on stale large payloads.
  // -------------------------------------------------------------------------

  test('inline mode replaces input substitutions with empty (template structural words survive)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Update the design for {{topic}} now.',
      inputs: { topic: 'ORIGINAL-TOPIC-PAYLOAD' },
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        answersBlock: 'A-LATEST',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).not.toContain('ORIGINAL-TOPIC-PAYLOAD')
    // Template structural words still present so the agent sees the
    // instruction wrapper, just not the port body.
    expect(out).toContain('Update the design for  now.')
  })

  test('inline mode skips the `## ${port_name}` auto-append for unreferenced inputs', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {
        spec: 'GIANT-SPEC-BODY-FROM-PRIOR-ROUND',
        notes: 'AUX-NOTES',
      },
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        answersBlock: 'A-LATEST',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).not.toContain('GIANT-SPEC-BODY-FROM-PRIOR-ROUND')
    expect(out).not.toContain('AUX-NOTES')
    expect(out).not.toMatch(/##\s+spec\b/)
    expect(out).not.toMatch(/##\s+notes\b/)
    // But the answers section and inline reminder still ride along.
    expect(out).toContain('User Answers (Current Round)')
    expect(out).toContain('A-LATEST')
  })

  test('isolated mode is unchanged — input substitutions and auto-append still fire', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Update the design for {{topic}} now.',
      inputs: { topic: 'ORIGINAL-TOPIC-PAYLOAD', notes: 'AUX-NOTES' },
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: { answersBlock: 'A-PRIOR' /* mode undefined → isolated */ },
    })
    expect(out).toContain('Update the design for ORIGINAL-TOPIC-PAYLOAD now.')
    expect(out).toMatch(/##\s+notes\b/)
    expect(out).toContain('AUX-NOTES')
  })

  test('built-in tokens (repo_path, clarify_iteration, etc.) STILL substitute in inline mode', () => {
    // RFC-026: only input port substitutions get nulled. Built-in tokens are
    // context this round needs (e.g. iteration counter, repo path for tool
    // invocations) and stay populated.
    const out = renderUserPrompt({
      promptTemplate: 'repo {{__repo_path__}} iter {{__clarify_iteration__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      clarifyContext: {
        answersBlock: 'A',
        iteration: '2',
        mode: 'inline',
        currentRoundOnly: true,
      },
    })
    expect(out).toContain('repo /r iter 2')
  })
})
