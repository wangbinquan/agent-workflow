// RFC-367 T3 — the distiller prompts must SHOW the reply format, not describe it.
//
// Why this file exists (2026-09-21 production forensics, proposal §1): the
// distiller produced zero candidates for over a month. Every captured run had
// emitted an envelope carrying good candidates, and every one of them was
// discarded because the payload was not inside a `<port name="candidates">`
// element. Three observed shapes:
//   1. `<workflow-output nonce="…">` + ```json fence + raw JSON, no port tag;
//   2. `<wflow-output nonce="…">` — tag name mangled;
//   3. `<wf-output nonce="…">` — mangled differently.
// Root cause: neither prompt ever contained the characters `<port`. The system
// prompt said "workflow-output envelope … a single port \"candidates\"" with no
// angle brackets at all, and the user prompt showed only the OPENING tag. A
// mid-tier model (this deployment runs alibaba-cn/glm-5.1) cannot reconstruct
// the rest from prose.
//
// These assertions pin the literal syntax into both prompts. They are cheap and
// they are the difference between "the feature works" and "the feature silently
// produces nothing", so keep them even if the wording around them changes.

import { describe, expect, test } from 'bun:test'
import { buildDistillerUserPrompt } from '../src/modules/memory/application/distill/memoryDistiller'
import { DISTILLER_SYSTEM_PROMPT } from '../src/modules/memory/domain/distillPrompt'

const NONCE = 'c0ffee1234567890'

const userPrompt = () =>
  buildDistillerUserPrompt({
    // RFC-366：LoadedSourceEvents 增到五路源；本用例只看 envelope 语法，全空即可。
    events: { clarify: [], review: [], feedback: [], agentRun: [], taskRun: [] },
    scopeContexts: [],
    taskId: null,
    envelopeNonce: NONCE,
  })

describe('RFC-367 — system prompt shows the literal envelope/port nesting', () => {
  test('all three levels appear literally', () => {
    expect(DISTILLER_SYSTEM_PROMPT).toContain('<workflow-output nonce=')
    expect(DISTILLER_SYSTEM_PROMPT).toContain('<port name="candidates">')
    expect(DISTILLER_SYSTEM_PROMPT).toContain('</port>')
    expect(DISTILLER_SYSTEM_PROMPT).toContain('</workflow-output>')
  })

  test('forbids the code fence that five of the ten failed runs used', () => {
    expect(DISTILLER_SYSTEM_PROMPT).toContain('```')
    expect(DISTILLER_SYSTEM_PROMPT).toMatch(/Do NOT wrap it in a ``` code fence/)
  })

  test('tells the model to copy the tag verbatim (two runs mangled the tag name)', () => {
    expect(DISTILLER_SYSTEM_PROMPT).toMatch(/byte-for-byte/i)
    expect(DISTILLER_SYSTEM_PROMPT).toMatch(/do not abbreviate or re-spell the tag name/i)
  })

  test('states the consequence of getting it wrong', () => {
    expect(DISTILLER_SYSTEM_PROMPT).toMatch(/discarded in full/i)
  })

  test('the empty answer still requires the wrapper', () => {
    expect(DISTILLER_SYSTEM_PROMPT).toContain('{"candidates": []}')
    expect(DISTILLER_SYSTEM_PROMPT).toMatch(/inside the "candidates" port/i)
  })
})

describe('RFC-367 — user prompt carries the shared protocol block', () => {
  test('renders the Format: example with the port element and closing tag', () => {
    const prompt = userPrompt()
    expect(prompt).toContain('Format:')
    expect(prompt).toContain(`<workflow-output nonce="${NONCE}">`)
    expect(prompt).toContain('<port name="candidates">')
    expect(prompt).toContain('</workflow-output>')
  })

  test('keeps the nonce-is-required warning from the shared block', () => {
    expect(userPrompt()).toContain(`The \`nonce="${NONCE}"\` attribute is REQUIRED`)
  })

  test('the empty-result instruction points INSIDE the port', () => {
    expect(userPrompt()).toMatch(/INSIDE that port/)
  })

  test('the output-language directive still comes last (RFC-050)', () => {
    const prompt = userPrompt()
    const directiveIdx = prompt.indexOf('Emit each candidate')
    expect(directiveIdx).toBeGreaterThan(prompt.indexOf('Format:'))
    expect(prompt.slice(directiveIdx).trim().split('\n')).toHaveLength(1)
  })
})
