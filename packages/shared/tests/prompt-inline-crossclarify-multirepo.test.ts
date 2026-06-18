// LOCKS: RFC-026 (inline clarify session mode) × RFC-056 (cross-clarify update
// mode) × RFC-066 (multi-repo builtin tokens) — the untested INTERSECTIONS of
// these three independent feature flags inside `renderUserPrompt`
// (packages/shared/src/prompt.ts).
//
// Why this file exists (regressions it locks):
//
//   GAP 1 — inline-mode rerun that is ALSO a cross-clarify submit batch.
//     `inlineMode` (cc.mode==='inline', prompt.ts L327) gates input
//     substitution (L377→''), the `## ${port}` auto-append (L387 continue),
//     and trailer selection (L508 → buildClarifyInlineReminder). BUT the xcc
//     block at L479-499 (## Prior Output (to be updated) / ## External
//     Feedback / ## Update Directive) has NO inlineMode guard, so all three
//     STILL emit in inline mode. The self-clarify QUESTIONS section IS inline-
//     gated (L447 !inlineMode) while the ANSWERS section is not (L454-464). A
//     future refactor that (correctly or not) adds an inline guard around the
//     xcc block — or one that lets the bi-modal trailer win over the inline
//     reminder in this combo — would silently change designer rerun prompts.
//     No prior test sets BOTH clarifyContext.mode==='inline' AND
//     crossClarifyContext at once.
//
//   GAP 2 — inline-mode clarify rerun of a MULTI-REPO task.
//     The BUILTIN_VARS switch (L331/L367-372) resolves __repos__ /
//     __repo_names__ / __repo_count__ BEFORE the `if (inlineMode) return ''`
//     guard at L377, so the RFC-066 trio resolves to real per-repo values even
//     in an inline rerun, while ordinary input port tokens drop to ''. A
//     refactor that hoisted the inlineMode check above the builtin switch would
//     silently blank out __repos__ in clarify reruns of multi-repo tasks.
//     prompt-multi-repo-vars.test.ts never sets clarifyContext;
//     clarify-prompt-inline.test.ts only uses {{__repo_path__}}, never the
//     RFC-066 trio.

import { describe, expect, test } from 'bun:test'
import { renderUserPrompt, buildClarifyInlineReminder } from '../src/prompt'

describe('renderUserPrompt — RFC-026 inline mode × RFC-056 cross-clarify (GAP 1)', () => {
  // Shared base for the GAP 1 designer rerun: both inline-session AND triggered
  // by a cross-clarify submit (xcc.block + xcc.priorOutputBlock set).
  const baseInput = {
    promptTemplate: 'Body {{port_a}}',
    inputs: { port_a: 'PAYLOAD' },
    meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
    agentOutputs: ['design'],
    clarifyContext: {
      mode: 'inline' as const,
      currentRoundOnly: true,
      answersBlock: '### Q1\n- User chose: "X"',
    },
    crossClarifyContext: {
      block: '### From q1\nstuff',
      priorOutputBlock: '### design\n\nold draft',
    },
    hasClarifyChannel: true,
  }

  test('inline + cross-clarify still emits xcc sections but uses the inline reminder trailer', () => {
    const out = renderUserPrompt(baseInput)

    // The cross-clarify (xcc) sections all still emit — no inlineMode guard.
    expect(out).toContain('## External Feedback')
    expect(out).toContain('## Prior Output (to be updated)')
    expect(out).toContain('## Update Directive')

    // Inline trailer wins over the bi-modal protocol block.
    expect(out).toContain(buildClarifyInlineReminder().trim())

    // Inline mode drops input port substitution.
    expect(out).not.toContain('PAYLOAD')

    // Bi-modal preamble must NOT appear (inline reminder replaced it).
    expect(out).not.toContain('This node has a clarify channel.')
  })

  test('section ordering: Prior Output < External Feedback < Update Directive < inline reminder', () => {
    const out = renderUserPrompt(baseInput)

    const priorIdx = out.indexOf('## Prior Output (to be updated)')
    const feedbackIdx = out.indexOf('## External Feedback')
    const directiveIdx = out.indexOf('## Update Directive')
    const reminderIdx = out.indexOf(buildClarifyInlineReminder().trim())

    expect(priorIdx).toBeGreaterThanOrEqual(0)
    expect(feedbackIdx).toBeGreaterThanOrEqual(0)
    expect(directiveIdx).toBeGreaterThanOrEqual(0)
    expect(reminderIdx).toBeGreaterThanOrEqual(0)

    expect(priorIdx).toBeLessThan(feedbackIdx)
    expect(feedbackIdx).toBeLessThan(directiveIdx)
    expect(directiveIdx).toBeLessThan(reminderIdx)
  })

  test('the self-clarify current-round answers section also emits in this combo (no !inlineMode guard on answers)', () => {
    const out = renderUserPrompt(baseInput)
    // L454-464: the answers section has no !inlineMode guard; in inline mode it
    // renders under the "Current Round" heading. (Strengthens the lock — the
    // verifier confirmed this section emits at runtime.)
    expect(out).toContain('## Clarify Q&A — User Answers (Current Round)')
    const answersIdx = out.indexOf('## Clarify Q&A — User Answers (Current Round)')
    const priorIdx = out.indexOf('## Prior Output (to be updated)')
    // Self-clarify answers render before the xcc Prior Output block.
    expect(answersIdx).toBeGreaterThanOrEqual(0)
    expect(answersIdx).toBeLessThan(priorIdx)
  })

  test('control: clarifyContext.mode=isolated flips to mandatory ask-back preamble + keeps PAYLOAD, drops inline reminder', () => {
    const out = renderUserPrompt({
      ...baseInput,
      clarifyContext: {
        ...baseInput.clarifyContext,
        mode: 'isolated' as const,
      },
    })

    // Isolated mode re-includes input port values...
    expect(out).toContain('PAYLOAD')
    // ...and emits the RFC-100 mandatory ask-back preamble (hasClarifyChannel: true)...
    expect(out).toContain('MANDATORY ASK-BACK')
    // ...and does NOT use the inline reminder. Confirms the divergence is
    // driven solely by cc.mode.
    expect(out).not.toContain(buildClarifyInlineReminder().trim())

    // The xcc sections emit in both modes (they are mode-agnostic).
    expect(out).toContain('## External Feedback')
    expect(out).toContain('## Prior Output (to be updated)')
    expect(out).toContain('## Update Directive')
  })
})

describe('renderUserPrompt — RFC-026 inline mode × RFC-066 multi-repo tokens (GAP 2)', () => {
  const multiRepoInput = {
    promptTemplate:
      'P={{port_a}}|RP={{__repo_path__}}|R={{__repos__}}|N={{__repo_names__}}|C={{__repo_count__}}',
    inputs: { port_a: 'BODY' },
    meta: {
      repoPath: '/legacy',
      baseBranch: 'main',
      taskId: '01',
      repos: [
        { repoPath: '/p/a', worktreePath: '/w/01/a', worktreeDirName: 'a', baseBranch: 'main' },
        { repoPath: '/p/b', worktreePath: '/w/01/b', worktreeDirName: 'b', baseBranch: 'main' },
      ],
    },
    agentOutputs: ['result'],
    // RFC-100: an inline rerun only happens for a clarify channel; mark it
    // active (continue round) so the trailer is the inline reminder, not the
    // stop-round output block (hasClarifyChannel-first routing in renderUserPrompt).
    hasClarifyChannel: true,
    clarifyContext: { mode: 'inline' as const, answersBlock: 'ans' },
  }

  test('inline-mode rerun drops port value but resolves all RFC-066 multi-repo builtins', () => {
    const out = renderUserPrompt(multiRepoInput)
    // port_a dropped to '' by inline mode; __repo_path__/__repos__/
    // __repo_names__/__repo_count__ all resolved to real per-repo values
    // because the builtin switch runs BEFORE the inlineMode `return ''` guard.
    expect(out.startsWith('P=|RP=/legacy|R=/w/01/a\n/w/01/b|N=a\nb|C=2')).toBe(true)
  })

  test('inline-mode rerun skips the ## port_a auto-append and uses the inline reminder trailer', () => {
    const out = renderUserPrompt(multiRepoInput)
    // Auto-append for input ports is skipped in inline mode.
    expect(out).not.toContain('## port_a')
    // Trailing block is the inline reminder, not the legacy output protocol.
    expect(out).toContain('The user has answered your previous')
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })
})
