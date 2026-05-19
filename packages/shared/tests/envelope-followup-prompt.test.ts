// RFC-042 — renderEnvelopeFollowupPrompt unit coverage.
//
// Locks in the follow-up prompt's content matrix across the three reason
// branches and two clarifyDirective sub-branches. If these go red, the
// follow-up message sent into a resumed opencode session is shifting under us
// — investigate before relaxing assertions. Test cases are numbered to match
// design.md §5.1.

import { describe, expect, test } from 'bun:test'

import { renderEnvelopeFollowupPrompt } from '@agent-workflow/shared'

describe('RFC-042 renderEnvelopeFollowupPrompt', () => {
  // §5.1 case 1
  test('hasClarifyChannel=false + reason=envelope-missing', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'envelope-missing',
    })
    expect(out).toContain('Envelope missing — follow-up.')
    expect(out).toContain('did not contain a `<workflow-output>` envelope')
    expect(out).toContain('`<workflow-output>` block using the EXACT format previously specified')
    // No clarify framing leaks into the non-clarify branch.
    expect(out).not.toContain('(B) `<workflow-clarify>`')
    expect(out).not.toContain('RFC-039 bias still applies')
    // No "Keep clarifying" continue trailer.
    expect(out).not.toContain('Keep clarifying')
  })

  // §5.1 case 2
  test('hasClarifyChannel=true + reason=envelope-missing', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'envelope-missing',
    })
    expect(out).toContain('Envelope missing — follow-up.')
    expect(out).toContain(
      'did not contain either a `<workflow-output>` or a `<workflow-clarify>` envelope',
    )
    expect(out).toContain('(B) `<workflow-clarify>`')
    expect(out).toContain('RFC-039 bias still applies')
    expect(out).toContain(
      'EITHER one `<workflow-output>` block OR one `<workflow-clarify>` block — NEVER both, NEVER neither',
    )
    expect(out).not.toContain('Keep clarifying')
  })

  // §5.1 case 3
  test('hasClarifyChannel=true + reason=both-present', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'both-present',
    })
    expect(out).toContain('contained BOTH `<workflow-output>` AND `<workflow-clarify>`')
    expect(out).toContain('Pick one and re-emit')
    expect(out).toContain('(B) `<workflow-clarify>`')
  })

  // §5.1 case 4
  test('hasClarifyChannel=true + reason=clarify-malformed', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'clarify-malformed',
    })
    expect(out).toContain('its JSON body could not be parsed')
    expect(out).toContain(
      'Re-emit a valid `<workflow-clarify>` body following the format previously specified',
    )
  })

  // §5.1 case 5
  test('hasClarifyChannel=true + clarifyDirective=continue appends RFC-039 strong bias', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      clarifyDirective: 'continue',
      reason: 'envelope-missing',
    })
    expect(out).toContain('The user has explicitly clicked "Keep clarifying"')
    expect(out).toContain('REQUIRED to be another `<workflow-clarify>`')
    expect(out).toContain('Skipping to `<workflow-output>` for the sake of brevity is not allowed')
  })

  // §5.1 case 6
  test('hasClarifyChannel=true + clarifyDirective=stop does NOT append the continue trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      clarifyDirective: 'stop',
      reason: 'envelope-missing',
    })
    expect(out).not.toContain('Keep clarifying')
    expect(out).not.toContain('REQUIRED to be another')
    // sanity: the base hasClarifyChannel=true body is still emitted
    expect(out).toContain('(B) `<workflow-clarify>`')
  })

  // Defensive: hasClarifyChannel=false + reason='both-present' is not a
  // reachable combination in production (only clarify channels produce that
  // failure), but renderer must still degrade gracefully.
  test('hasClarifyChannel=false ignores non-envelope-missing reasons (falls back to single-envelope wording)', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'clarify-malformed',
    })
    expect(out).toContain('did not contain a `<workflow-output>` envelope')
    expect(out).not.toContain('(B) `<workflow-clarify>`')
  })
})
