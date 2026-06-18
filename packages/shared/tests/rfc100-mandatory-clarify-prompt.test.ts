// RFC-100 — mandatory ask-back (clarify) prompt injection.
//
// Locks the RFC-100 contract on the PROMPT side. self-clarify (RFC-023) and the
// cross-clarify questioner (RFC-056) share this exact render path — both reach
// renderUserPrompt with hasClarifyChannel = effectiveHasClarifyChannel — so a
// single set of render-side assertions covers both.
//
//   1. clarify ACTIVE (hasClarifyChannel=true): mandatory ask-back preamble +
//      clarify format, and NO <workflow-output> format — the agent is never told
//      how to finalize, so it must ask back.
//   2. stop round (hasClarifyChannel=false): the output format returns.
//   3. the mandatory preamble carries the full ask-back discipline (investigate
//      first, prioritized/deep questions, never guess terms, no assumptions, ask
//      in the user's language, asking back is success).
//   4. the clarify-required follow-up re-demands a <workflow-clarify> envelope.
//
// See design/RFC-100-mandatory-clarify/.

import { describe, expect, test } from 'bun:test'

import {
  buildMandatoryClarifyPreamble,
  renderEnvelopeFollowupPrompt,
  renderUserPrompt,
} from '@agent-workflow/shared'

const META = { repoPath: '/r', baseBranch: 'main', taskId: 't' }

describe('RFC-100 mandatory ask-back — clarify-active prompt', () => {
  const clarifyActive = renderUserPrompt({
    promptTemplate: 'do the thing',
    inputs: {},
    meta: META,
    agentOutputs: ['design', 'plan'],
    hasClarifyChannel: true,
  })

  test('emits the mandatory preamble + clarify format, never the output format', () => {
    expect(clarifyActive).toContain('MANDATORY ASK-BACK')
    expect(clarifyActive).toContain('<workflow-clarify>')
    // The <workflow-output> port list / format MUST be absent while clarifying.
    expect(clarifyActive).not.toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(clarifyActive).not.toContain('block listing these ports')
    // The declared ports must not leak as an output port list/example.
    expect(clarifyActive).not.toContain('<port name="design">')
    expect(clarifyActive).not.toContain('<port name="plan">')
  })

  test('carries the full ask-back discipline (no assumptions / deep / no term-guessing / language)', () => {
    expect(clarifyActive).toContain('Investigate first, then ask')
    expect(clarifyActive).toContain('in priority order')
    expect(clarifyActive).toContain('Never guess unfamiliar terms')
    expect(clarifyActive).toContain('No assumptions, no fabrication, no silent defaults')
    expect(clarifyActive).toContain('Ask in the same language as the inputs / the user')
    expect(clarifyActive).toContain('Asking back is the correct outcome')
  })

  test('preamble is self-contained (leading separator, forbids output explicitly)', () => {
    const pre = buildMandatoryClarifyPreamble()
    expect(pre.startsWith('\n\n---\n')).toBe(true)
    expect(pre).toContain('You may NOT emit `<workflow-output>`')
    expect(pre).toContain('only after the user clicks "Stop clarifying"')
  })
})

describe('RFC-100 mandatory ask-back — stop round restores the output format', () => {
  test('hasClarifyChannel=false emits the output protocol block, not the mandatory preamble', () => {
    const stop = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: false,
      // a real stop round still carries the answers block (directive=stop is
      // applied upstream by the scheduler when flipping effectiveHasClarifyChannel).
      clarifyContext: { answersBlock: 'A', iteration: '2', directive: 'stop' },
    })
    expect(stop).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(stop).toContain('<port name="design">')
    expect(stop).not.toContain('MANDATORY ASK-BACK')
  })
})

describe('RFC-100 clarify-required follow-up', () => {
  test('re-demands a <workflow-clarify> envelope (clarify-only, no output)', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'clarify-required',
    })
    expect(out).toContain('did not ask back')
    expect(out).toContain('MANDATORY ask-back mode')
    expect(out).toContain('exactly one `<workflow-clarify>` block')
    expect(out).toContain('Do NOT emit `<workflow-output>`')
  })

  test('clarify-required + directive=continue still appends the Keep-clarifying trailer', () => {
    const out = renderEnvelopeFollowupPrompt({
      hasClarifyChannel: true,
      reason: 'clarify-required',
      clarifyDirective: 'continue',
    })
    expect(out).toContain('Keep clarifying')
    expect(out).toContain('MUST be another `<workflow-clarify>` envelope')
  })
})
