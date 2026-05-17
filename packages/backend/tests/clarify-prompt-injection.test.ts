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

describe('RFC-023 prompt token substitution', () => {
  test('replaces all four __clarify_*__ tokens when context is set', () => {
    const out = renderUserPrompt({
      promptTemplate:
        'iter={{__clarify_iteration__}} remaining={{__clarify_remaining__}}\nQ:\n{{__clarify_questions__}}\nA:\n{{__clarify_answers__}}',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '### Q1: which db?',
        answersBlock: '### Q1\nSelected: "Postgres"',
        iteration: '1',
        remaining: '4',
      },
    })
    expect(out).toContain('iter=1 remaining=4')
    expect(out).toContain('### Q1: which db?')
    expect(out).toContain('Selected: "Postgres"')
  })

  test('auto-appends `## Clarify Q&A` sections when tokens are not referenced in the template', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Please continue based on prior clarifications.',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '### Q1: which db?',
        answersBlock: '### Q1\nSynthesis: User chose: "Postgres"',
        iteration: '1',
        remaining: '',
      },
    })
    expect(out).toContain('## Clarify Q&A — Prior Rounds (Questions)')
    expect(out).toContain('## Clarify Q&A — Prior Rounds (Answers)')
  })

  test('omits auto-append sections when blocks are empty', () => {
    const out = renderUserPrompt({
      promptTemplate: 'plain run',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['design'],
      clarifyContext: { questionsBlock: '', answersBlock: '', iteration: '0', remaining: '' },
    })
    expect(out).not.toContain('## Clarify Q&A')
  })

  test('buildClarifyProtocolBlock contains the "EITHER ... OR ... NEVER both" rule', () => {
    const block = buildClarifyProtocolBlock()
    expect(block).toContain('<workflow-clarify>')
    expect(block).toContain('NEVER both')
    expect(block).toContain('Clarify mode is enabled for this node')
  })

  // Locks in the bi-modal wording fix: when the scheduler tells the renderer
  // the agent node has a clarify channel, the trailing protocol block must
  // present `<workflow-output>` and `<workflow-clarify>` as equally
  // first-class envelopes BEFORE describing the output format. The previous
  // single-envelope "You MUST end your reply with <workflow-output>" lead
  // anchored the agent toward output even when blocking questions remained.
  // Do not weaken these assertions without re-confirming the regression
  // (agent biased toward output instead of asking back).
  describe('bi-modal trailing block when hasClarifyChannel=true', () => {
    test('renderer emits bi-modal preamble and softens the output "MUST" wording', () => {
      const out = renderUserPrompt({
        promptTemplate: 'do the thing',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['design'],
        hasClarifyChannel: true,
      })
      expect(out).toContain('This node has a clarify channel')
      expect(out).toContain('Both envelopes are equally first-class')
      expect(out).toContain('Do NOT default to (A)')
      // Output format wording is softened — no top-level "MUST end your reply"
      expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
      expect(out).toContain('When you are ready to commit the final answer')
      // Clarify format block still follows after the output format block
      expect(out).toContain('Clarify mode is enabled for this node')
      expect(out.indexOf('<workflow-output>')).toBeLessThan(out.indexOf('Clarify mode is enabled'))
    })

    test('legacy single-envelope wording is preserved when hasClarifyChannel is omitted', () => {
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

    test('softened clarify lead encourages ask-back instead of framing it as last resort', () => {
      const block = buildClarifyProtocolBlock()
      // Previous wording was "If — and ONLY if — you have unresolved questions
      // that block you ... you MUST instead emit". That phrasing read as
      // "only in extreme blocking cases", which reinforced the output bias.
      expect(block).not.toContain('ONLY if')
      expect(block).toContain('Ask-back is a first-class outcome')
    })
  })
})

describe('RFC-023 prompt.ts source-code-text grep guard', () => {
  // These are stable, externally visible token names per the RFC. Renaming any
  // of them silently is a contract break (frontend / backend / agent prompts
  // all reference the same strings). The guard makes any rename loud.
  const required = [
    '__clarify_questions__',
    '__clarify_answers__',
    '__clarify_iteration__',
    '__clarify_remaining__',
  ]
  const src = readFileSync(PROMPT_TS_PATH, 'utf8')

  for (const token of required) {
    test(`prompt.ts mentions ${token}`, () => {
      expect(src).toContain(token)
    })
  }
})
