// RFC-367 T1 — the `port-missing` follow-up reason.
//
// Why this file exists: on 2026-09-21 the memory distiller was found to have
// produced ZERO candidates for over a month. Ten consecutive captured runs had
// emitted a well-formed `<workflow-output nonce=…>` envelope whose payload was
// dropped straight inside the envelope (five of them inside a ```json fence)
// with no `<port name="candidates">` wrapper at all — see
// design/RFC-367-distiller-output-protocol/proposal.md §1.
//
// Before this reason existed, the closest render was 'envelope-missing', whose
// opening line tells the agent it "did not contain a `<workflow-output>`
// envelope". For an agent that DID emit one, that sentence describes a defect
// that is not there and sends it chasing the wrong fix. These assertions lock
// the corrective wording (and the fact that it never claims the envelope was
// absent), so a future reword cannot silently regress it.
//
// Scope note: this is render-domain only. `FollowupFailureCode` /
// FOLLOWUP_POLICY (the worker-node producer domain and its routing oracle) are
// deliberately untouched, so node behavior is unchanged — locked below.

import { describe, expect, test } from 'bun:test'
import { FOLLOWUP_POLICY, renderEnvelopeFollowupPrompt } from '../src/prompt'

const NONCE = 'a1b2c3d4e5f60718'

/** The distiller's mode: a system agent with no clarify channel. */
const distillerRound = (overrides: Record<string, unknown> = {}) =>
  renderEnvelopeFollowupPrompt({
    hasClarifyChannel: false,
    reason: 'port-missing',
    envelopeNonce: NONCE,
    ...overrides,
  })

describe('RFC-367 — port-missing follow-up wording', () => {
  test('names the real defect: envelope present, port element absent', () => {
    const prompt = distillerRound()
    expect(prompt).toContain('emitted a `<workflow-output>` envelope')
    expect(prompt).toContain('no `<port name="...">` element')
    // The two shapes actually observed in production.
    expect(prompt).toContain('directly inside the envelope')
    expect(prompt).toContain('code fence')
  })

  test('never tells an agent that DID emit an envelope that it emitted none', () => {
    const prompt = distillerRound()
    expect(prompt).not.toContain('did not contain a `<workflow-output>` envelope')
  })

  test('carries its own label rather than the legacy "Envelope missing" anchor', () => {
    expect(distillerRound()).toContain('**Envelope port missing — follow-up.**')
    // The legacy anchor still belongs to the genuinely-missing case.
    expect(
      renderEnvelopeFollowupPrompt({ hasClarifyChannel: false, reason: 'envelope-missing' }),
    ).toContain('**Envelope missing — follow-up.**')
  })

  test('survives the hasClarifyChannel=false narrowing (does not degrade to envelope-missing)', () => {
    // The narrowing chain coerces clarify-only reasons to 'envelope-missing'
    // when no clarify channel is wired. port-missing is output-shaped, so it
    // must pass through — otherwise the distiller (always clarify-less) would
    // never see the corrective wording this RFC adds.
    const prompt = distillerRound()
    expect(prompt).toContain('no `<port name="...">` element')
  })

  test('re-emit bullets demand the port shape, and the nonce reminder rides along', () => {
    const prompt = distillerRound()
    expect(prompt).toContain('`<port name="...">...</port>` shape')
    expect(prompt).toContain(`nonce="${NONCE}"`)
  })

  test('an OPTIONAL clarify channel does not open a clarify escape hatch', () => {
    // Offering "ask a question instead" here would let the agent dodge the
    // correction entirely — same reasoning as envelope-port-malformed /
    // branch-marker, which already opt out of the optional-clarify bullets.
    const prompt = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      clarifyOptional: true,
      reason: 'port-missing',
      envelopeNonce: NONCE,
    })
    expect(prompt).not.toContain('This node has an OPTIONAL clarify channel')
    expect(prompt).toContain('`<port name="...">...</port>` shape')
  })

  test('worker-node routing is untouched: no producer code maps to port-missing', () => {
    expect(Object.values(FOLLOWUP_POLICY).map((p) => p.reason)).not.toContain('port-missing')
  })
})
