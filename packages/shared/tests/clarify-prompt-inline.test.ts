// RFC-026 — inline-mode clarify reminder.
//
// Locks the `buildClarifyInlineReminder()` wording that replaces the trailing
// protocol block on inline CONTINUE rounds. (RFC-148 deleted the legacy
// round-grouped clarify sections — questionsBlock / answersBlock /
// currentRoundOnly — so the renderUserPrompt cases that exercised those legacy
// headings were deleted with them; the flatBlock + inline render path is
// locked by the RFC-148 golden matrix.)

import { describe, expect, test } from 'bun:test'

import { buildClarifyInlineReminder } from '@agent-workflow/shared'

describe('RFC-026 buildClarifyInlineReminder — inline mode reminder', () => {
  test('inline reminder mentions both envelope choices and "session" continuity', () => {
    const reminder = buildClarifyInlineReminder()
    expect(reminder).toContain('<workflow-output>')
    expect(reminder).toContain('<workflow-clarify>')
    expect(reminder).toContain('"## Clarify Q&A"')
    expect(reminder).toMatch(/session/i)
  })

  // RFC-100: the inline reminder is now mandatory ask-back — it fires only on
  // inline CONTINUE rounds (the stop round routes to the output protocol block,
  // since the inline session never saw the output format). Lock the wording
  // verbatim so a future edit doesn't inadvertently re-touch this string.
  test('RFC-100: inline reminder wording locked verbatim', () => {
    expect(buildClarifyInlineReminder()).toBe(
      '\n\n---\n' +
        'The user has answered your previous `<workflow-clarify>` round (see "## Clarify Q&A" above). ' +
        'This node stays in MANDATORY ask-back mode until the user clicks "Stop clarifying" — your next reply MUST be another `<workflow-clarify>` envelope. ' +
        'Do not emit `<workflow-output>`; it will be rejected. ' +
        'The full clarify format and asking-back rules from earlier in this session still apply and have not been re-emitted.',
    )
  })
})
