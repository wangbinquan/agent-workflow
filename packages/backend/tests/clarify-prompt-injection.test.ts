// RFC-023 — prompt-token injection contract for clarify.
//
// Locks the four builtin token names + auto-append section behaviour from
// design.md §4.3 + plan.md T3 §C2. The grep-style source-code guards prove
// the token strings still appear in shared/src/prompt.ts: if a refactor
// renames any of them, this test breaks loudly rather than silently
// dropping the substitution.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildClarifyProtocolBlock, renderUserPrompt } from '@agent-workflow/shared'

const PROMPT_TS_PATH = resolve(__dirname, '../../shared/src/prompt.ts')

describe('RFC-023/132 prompt token substitution', () => {
  // RFC-148 (RFC-132 收尾): __clarify_questions__/__clarify_answers__ tokens
  // and the round-grouped auto-append sections are GONE — the flat
  // `## Clarify Q&A` block is the single injection surface. The two live
  // tokens keep substituting.
  test('replaces the two live __clarify_*__ tokens when context is set', () => {
    const out = renderUserPrompt({
      promptTemplate: 'iter={{__clarify_iteration__}} remaining={{__clarify_remaining__}}',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        flatBlock: '## Clarify Q&A\n\n1. [q1] which db?\n   Answer: Postgres',
        iteration: '1',
        remaining: '4',
      },
    })
    expect(out).toContain('iter=1 remaining=4')
    expect(out).toContain('1. [q1] which db?')
  })

  test('appends the flat block verbatim (owns its own heading)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Please continue based on prior clarifications.',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        flatBlock: '## Clarify Q&A\n\n1. [q1] which db?\n   Answer: Postgres',
        iteration: '1',
        remaining: '',
      },
    })
    expect(out).toContain('## Clarify Q&A')
    expect(out).toContain('Answer: Postgres')
    // legacy round-grouped headings must never come back
    expect(out).not.toContain('Prior Rounds (Questions)')
    expect(out).not.toContain('Prior Rounds (Answers)')
  })

  test('omits clarify sections when flat block is empty', () => {
    const out = renderUserPrompt({
      promptTemplate: 'plain run',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: { flatBlock: '', iteration: '0', remaining: '' },
    })
    expect(out).not.toContain('## Clarify Q&A')
  })

  // RFC-100: the clarify format block is now clarify-ONLY (no more "EITHER
  // output OR clarify, NEVER both" bi-modal rule) — while a clarify channel is
  // active the agent may not emit <workflow-output> at all.
  test('buildClarifyProtocolBlock states the clarify-only rule (RFC-100)', () => {
    const block = buildClarifyProtocolBlock()
    expect(block).toContain('<workflow-clarify>')
    expect(block).toContain('exactly one <workflow-clarify> block')
    expect(block).toContain('NO <workflow-output>')
    expect(block).toContain('rejected until the user stops clarifying')
  })

  // Locks the explicit warning that a 5th+ option is silently dropped by
  // parseClarifyEnvelopeBody (CLARIFY_MAX_OPTIONS_PER_QUESTION=4). Without
  // this nudge in the prompt, agents routinely emit 5–6 options and the user
  // never sees the trailing ones. If this breaks, the wording in
  // shared/src/prompt.ts:buildClarifyProtocolBlock has drifted from the
  // truncation contract in packages/backend/tests/clarify-options-cap.test.ts.
  test('buildClarifyProtocolBlock warns that options beyond the 4th are dropped', () => {
    const block = buildClarifyProtocolBlock()
    expect(block).toContain('beyond the 4th is silently dropped')
    expect(block).toContain('cap each question at 4')
  })

  // Locks in the bi-modal wording fix: when the scheduler tells the renderer
  // the agent node has a clarify channel, the trailing protocol block must
  // present `<workflow-output>` and `<workflow-clarify>` as a bi-modal choice
  // BEFORE describing the output format. RFC-039 further sharpened the
  // basetone: the preamble now defaults to "(B) <workflow-clarify> first",
  // explicitly demoting (A) to a permission gate. The previous
  // "equally first-class" wording still let agents glide into output mode
  // whenever inputs looked plausible. Do not weaken these assertions without
  // re-confirming the regression (agent biased toward output instead of
  // asking back, even when the user wired a clarify channel).
  describe('bi-modal trailing block when the clarify channel is mandatory', () => {
    test('renderer emits the mandatory ask-back preamble and NO output format', () => {
      const out = renderUserPrompt({
        promptTemplate: 'do the thing',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['design'],
        clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
      })
      expect(out).toContain('MANDATORY ASK-BACK')
      expect(out).toContain('The user wired a clarify channel')
      expect(out).toContain('Operate with ZERO guessing')
      // RFC-100: NO <workflow-output> format is emitted while clarify is active.
      expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
      expect(out).not.toContain('When you are ready to commit the final answer')
      // Clarify format block follows the preamble.
      expect(out).toContain('Clarify format.')
      expect(out.indexOf('MANDATORY ASK-BACK')).toBeLessThan(out.indexOf('Clarify format.'))
    })

    test('legacy single-envelope wording is preserved when clarifyChannel is omitted', () => {
      const out = renderUserPrompt({
        promptTemplate: 'do the thing',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['design'],
      })
      expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
      expect(out).not.toContain('This node has a clarify channel')
      expect(out).not.toContain('Clarify mode is enabled')
    })

    test('clarify lead frames ask-back as the expected outcome (RFC-100)', () => {
      const block = buildClarifyProtocolBlock()
      expect(block).not.toContain('ONLY if')
      expect(block).toContain('Asking back is the expected outcome')
    })
  })
})

describe('RFC-023 prompt.ts source-code-text grep guard', () => {
  // These are stable, externally visible token names per the RFC. Renaming any
  // of them silently is a contract break (frontend / backend / agent prompts
  // all reference the same strings). The guard makes any rename loud.
  // RFC-148: the questions/answers tokens are retired with the legacy
  // round-grouped path. The impl-gate compat fix reintroduced their NAMES
  // into prompt.ts as the DEPRECATED_PROMPT_TOKENS set (saved templates keep
  // launching with a warning), so a file-level "never mentions" lock is the
  // wrong shape — the real contract is table membership: live tokens in
  // BUILTIN_VARS, retired names ONLY in the deprecated set (locked in
  // rfc103-validator-builtin-vars.test.ts). Here we keep the live-token
  // anchors plus a substitution-case lock: the retired tokens must never
  // regrow a dedicated substitution case (their rendering is the default
  // empty-string branch).
  const required = ['__clarify_iteration__', '__clarify_remaining__']
  const src = readFileSync(PROMPT_TS_PATH, 'utf8')

  for (const token of required) {
    test(`prompt.ts mentions ${token}`, () => {
      expect(src).toContain(token)
    })
  }
  test('retired tokens have no dedicated substitution case', () => {
    expect(src).not.toMatch(/case '__clarify_questions__'/)
    expect(src).not.toMatch(/case '__clarify_answers__'/)
  })
})

// RFC-039 — strong ask-back bias when a clarify channel is wired. The user's
// production complaint: with the legacy "equally first-class" wording, agents
// glided into <workflow-output> whenever inputs looked plausible, ignoring the
// user's explicit "I wired a clarify channel so you'd ask first" signal. These
// tests lock the new default-to-(B) anchors. Do not weaken without fresh
// production evidence — see design/RFC-039-clarify-ask-bias/proposal.md §G1.
describe('RFC-039 bi-modal preamble default-asks (B) and lists ask-back triggers', () => {
  test('preamble contains the RFC-100 mandatory ask-back anchors', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    })
    // Anchor 1 — declares mandatory ask-back mode.
    expect(out).toContain('MANDATORY ASK-BACK')
    // Anchor 2 — the only valid reply is clarify; output is forbidden.
    expect(out).toContain('Your ONLY valid reply this round is a `<workflow-clarify>` envelope')
    expect(out).toContain('You may NOT emit `<workflow-output>`')
    // Anchor 3 — zero-guessing directive.
    expect(out).toContain('Operate with ZERO guessing')
    // Anchor 4 — the ask-back discipline bullets (kept loose so wording can
    // drift slightly but the discipline set survives).
    expect(out).toMatch(/Investigate first, then ask/)
    expect(out).toMatch(/Never guess unfamiliar terms/)
    expect(out).toMatch(/No assumptions, no fabrication/)
    expect(out).toMatch(/writing "TBD"/)
  })

  test('legacy "equally first-class" wording is gone', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    })
    expect(out).not.toContain('Both envelopes are equally first-class')
    expect(out).not.toContain('Do NOT default to (A) just because')
  })

  test('non-clarify-channel path stays on the legacy single-envelope wording', () => {
    // RFC-039 only sharpens the mandatory-clarify-channel branch. Channels that
    // never wired clarify must still see the original "MUST end your reply
    // with <workflow-output>" wording — otherwise non-clarify workflows would
    // suddenly see a phantom (B) option they have no way to honour.
    const out = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
    })
    expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(out).not.toContain('By default, your next reply should be (B)')
    expect(out).not.toContain('This node has a clarify channel')
  })
})

// RFC-039 — prompt.ts / clarify.ts source-code grep guards. Prevents a future
// refactor from silently re-introducing the legacy soft wording. The pattern
// mirrors the RFC-023 guards above + the `selectionOnDrag` guard from RFC-022.
describe('RFC-039 source-code grep guards', () => {
  const PROMPT_SRC = readFileSync(PROMPT_TS_PATH, 'utf8')
  const CLARIFY_SRC = readFileSync(resolve(__dirname, '../../shared/src/clarify.ts'), 'utf8')

  test('prompt.ts must not retain the legacy "equally first-class" wording', () => {
    expect(PROMPT_SRC).not.toContain('Both envelopes are equally first-class')
  })

  test('prompt.ts contains the RFC-100 mandatory ask-back preamble anchor', () => {
    expect(PROMPT_SRC).toContain('MANDATORY ASK-BACK')
    expect(PROMPT_SRC).toContain('buildMandatoryClarifyPreamble')
  })

  test('clarify.ts must not retain the legacy "willing to answer" continue wording', () => {
    expect(CLARIFY_SRC).not.toContain('willing to answer more clarification questions')
  })

  test('clarify.ts contains the RFC-100 mandatory ask-back continue anchor', () => {
    expect(CLARIFY_SRC).toContain('mandatory ask-back mode')
  })
})
