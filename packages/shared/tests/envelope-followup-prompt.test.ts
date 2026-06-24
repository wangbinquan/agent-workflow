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
    // RFC-100: clarify-channel followups are now single-envelope (clarify-only)
    // — no more "(B) / RFC-039 bias / EITHER output OR clarify" bi-modal wording.
    expect(out).toContain('MANDATORY ask-back mode')
    expect(out).toContain('exactly one `<workflow-clarify>` block')
    expect(out).toContain('Do NOT emit `<workflow-output>`')
    expect(out).not.toContain('(B) `<workflow-clarify>`')
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
    // RFC-100: bullets steer to clarify-only (no bi-modal "(B)" wording).
    expect(out).toContain('exactly one `<workflow-clarify>` block')
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
    expect(out).toContain('The user clicked "Keep clarifying"')
    expect(out).toContain('MUST be another `<workflow-clarify>` envelope')
    expect(out).toContain(
      '`<workflow-output>` is not an option until the user clicks "Stop clarifying"',
    )
  })

  // §5.1 case 6
  test('hasClarifyChannel=true + clarifyDirective=stop does NOT append the continue trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      clarifyDirective: 'stop',
      reason: 'envelope-missing',
    })
    expect(out).not.toContain('Keep clarifying')
    expect(out).not.toContain('MUST be another `<workflow-clarify>` envelope')
    // sanity: the base hasClarifyChannel=true (mandatory ask-back) body is still emitted
    expect(out).toContain('MANDATORY ask-back mode')
  })

  // 损坏端口急修（2026-06-24）: reason='envelope-port-malformed' (a <port> was
  // opened but its </port> close was missing/corrupted). The agent DID emit an
  // envelope, so the opening must NOT say "did not contain an envelope" — it
  // must point at the unclosed port. Bullets stay output-oriented.
  test('hasClarifyChannel=false + reason=envelope-port-malformed → targeted close-tag wording', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: false,
      reason: 'envelope-port-malformed',
    })
    expect(out).toContain('were never properly closed')
    expect(out).toContain('closed with a literal `</port>` tag')
    // Output-oriented bullets, not clarify-only.
    expect(out).toContain('`<workflow-output>` block using the EXACT format previously specified')
    expect(out).not.toContain('MANDATORY ask-back mode')
    // Must NOT degrade to the generic envelope-missing wording.
    expect(out).not.toContain('did not contain a `<workflow-output>` envelope')
  })

  // Defensive: malformed-port only fires with the clarify channel inactive, but
  // if hasClarifyChannel=true ever reaches the renderer the reason must be
  // PRESERVED (not narrowed) so the tailored close-tag wording survives.
  test('hasClarifyChannel=true + reason=envelope-port-malformed preserves wording (no clarify narrowing)', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'envelope-port-malformed',
    })
    expect(out).toContain('were never properly closed')
    expect(out).toContain('closed with a literal `</port>` tag')
    // Even with the channel on, malformed-port wants output-format bullets, not
    // the mandatory-ask-back clarify bullets.
    expect(out).toContain('`<workflow-output>` block using the EXACT format previously specified')
    expect(out).not.toContain('MANDATORY ask-back mode')
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
