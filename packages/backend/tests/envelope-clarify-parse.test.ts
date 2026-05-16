// RFC-023 PR-B T8 — locks the contract of detectEnvelopeKind +
// extractClarifyEnvelopeBody inside services/envelope.ts. These two helpers
// are what runner.ts pivots on to decide whether the agent reply ought to be
// parsed as a normal <workflow-output> (write port outputs as today) or as
// the new <workflow-clarify> envelope (hand off to ClarifyService).
//
// The exclusive-or contract between the two envelope kinds is asserted in
// the sibling spec clarify-envelope-exclusive.test.ts as the C1 regression
// guard so the rule survives any future cleanup of this file.

import { describe, expect, test } from 'bun:test'
import { detectEnvelopeKind, extractClarifyEnvelopeBody } from '../src/services/envelope'

describe('detectEnvelopeKind', () => {
  test('returns "none" when stdout has neither envelope', () => {
    expect(detectEnvelopeKind('hello world\nno tags here')).toBe('none')
  })

  test('returns "output" when only <workflow-output> is present', () => {
    const s = `text before
<workflow-output>
  <port name="a">v</port>
</workflow-output>
trailing`
    expect(detectEnvelopeKind(s)).toBe('output')
  })

  test('returns "clarify" when only <workflow-clarify> is present', () => {
    const s = `agent reasoning
<workflow-clarify>
{"questions":[{"id":"q1","title":"Foo?","kind":"single","recommended":false,"options":["A","B"]}]}
</workflow-clarify>
trailing`
    expect(detectEnvelopeKind(s)).toBe('clarify')
  })

  test('returns "both" when stdout contains both envelopes regardless of order', () => {
    const s1 = `<workflow-output><port name="a">v</port></workflow-output>
<workflow-clarify>{"questions":[{"id":"q","title":"?","kind":"single","recommended":false,"options":["A","B"]}]}</workflow-clarify>`
    const s2 = `<workflow-clarify>{"questions":[{"id":"q","title":"?","kind":"single","recommended":false,"options":["A","B"]}]}</workflow-clarify>
<workflow-output><port name="a">v</port></workflow-output>`
    expect(detectEnvelopeKind(s1)).toBe('both')
    expect(detectEnvelopeKind(s2)).toBe('both')
  })

  test('repeated calls on the same regex reset lastIndex (no stale-state false negatives)', () => {
    const s = `<workflow-clarify>{"questions":[]}</workflow-clarify>`
    // Two consecutive checks must yield the same answer — earlier calls must
    // not leave the global RegExp's lastIndex past the match position.
    expect(detectEnvelopeKind(s)).toBe('clarify')
    expect(detectEnvelopeKind(s)).toBe('clarify')
    expect(detectEnvelopeKind(s)).toBe('clarify')
  })
})

describe('extractClarifyEnvelopeBody', () => {
  test('returns null when no clarify envelope is present', () => {
    expect(extractClarifyEnvelopeBody('plain text only')).toBeNull()
    expect(extractClarifyEnvelopeBody('<workflow-output></workflow-output>')).toBeNull()
  })

  test('returns the trimmed body between the open/close tags', () => {
    const s = `prefix
<workflow-clarify>
  {"questions": [{"id":"q","title":"?","kind":"single","recommended":false,"options":["A","B"]}]}
</workflow-clarify>
suffix`
    const body = extractClarifyEnvelopeBody(s) ?? ''
    expect(body.startsWith('{')).toBe(true)
    expect(body.endsWith('}')).toBe(true)
    expect(body).not.toContain('<workflow-clarify>')
    expect(body).not.toContain('</workflow-clarify>')
  })

  test('returns the LAST envelope body when agent emits drafts first', () => {
    const s = `
intermediate
<workflow-clarify>
{"draft":true}
</workflow-clarify>
later
<workflow-clarify>
{"final":true}
</workflow-clarify>
trailing
`
    const body = extractClarifyEnvelopeBody(s) ?? ''
    expect(body).toContain('"final"')
    expect(body).not.toContain('"draft"')
  })

  test('handles whitespace-only body without throwing', () => {
    expect(extractClarifyEnvelopeBody('<workflow-clarify>   </workflow-clarify>')).toBe('')
  })
})
