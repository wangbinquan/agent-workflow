// RFC-056 §6 update mode (2026-05-22 amendment) — pure shared-layer locks.
//
// Two product semantics this test pins:
//   1. `## Prior Output (to be updated)` section emits when
//      crossClarifyContext.priorOutputBlock is populated; the agent reads
//      the working draft instead of regenerating from scratch.
//   2. `## Update Directive` section emits ONLY when priorOutputBlock is
//      populated — paired one-to-one so the directive never appears
//      without the draft (would confuse the agent — "update what?").
//   3. Section order: Prior Output → External Feedback → Update Directive
//      so the agent reads "here's the draft" → "here's the change driver"
//      → "your action this round is update, not regenerate".
//   4. buildPriorOutputBlock empty-input → empty string (renderer suppresses
//      both sections); single port → `### <port>` + body; multi-port
//      preserves caller order.
//
// If any of these go red the cross-clarify update-mode prompt contract has
// drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  buildPriorOutputBlock,
  CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE,
  CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE,
  CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT,
  renderUserPrompt,
} from '@agent-workflow/shared'

describe('RFC-056 §6 update mode — buildPriorOutputBlock', () => {
  test('empty inputs → empty string (caller can suppress section)', () => {
    expect(buildPriorOutputBlock([])).toBe('')
  })

  test('single port → `### <port>` heading + content body', () => {
    const out = buildPriorOutputBlock([{ portName: 'design', content: '# Design v1\n...body...' }])
    expect(out).toContain('### design')
    expect(out).toContain('# Design v1')
    expect(out).toContain('...body...')
  })

  test('multi-port preserves caller order (NOT dictionary-sorted)', () => {
    const out = buildPriorOutputBlock([
      { portName: 'docpath', content: 'docs/design.md content' },
      { portName: 'summary', content: 'one-liner' },
    ])
    const docpathIdx = out.indexOf('### docpath')
    const summaryIdx = out.indexOf('### summary')
    expect(docpathIdx).toBeGreaterThan(-1)
    expect(summaryIdx).toBeGreaterThan(docpathIdx)
  })

  test('drops empty / whitespace-only content rows (no `### port_name` heading without body)', () => {
    const out = buildPriorOutputBlock([
      { portName: 'design', content: '   ' },
      { portName: 'summary', content: 'real content' },
    ])
    expect(out).not.toContain('### design')
    expect(out).toContain('### summary')
    expect(out).toContain('real content')
  })

  test('constants resolve to the literal heading strings (regression guard against silent rename)', () => {
    expect(CROSS_CLARIFY_PRIOR_OUTPUT_BLOCK_TITLE).toBe('## Prior Output (to be updated)')
    expect(CROSS_CLARIFY_UPDATE_DIRECTIVE_BLOCK_TITLE).toBe('## Update Directive')
    expect(CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT.length).toBeGreaterThan(50)
    // The directive must clearly say "update" + "not regenerate" so the
    // agent's mental model flips. Silent re-wording that drops either
    // keyword should fail this lock.
    expect(CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT.toLowerCase()).toContain('update')
    expect(CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT.toLowerCase()).toContain('not regenerate')
  })
})

describe('RFC-056 §6 update mode — renderUserPrompt section emit + ordering', () => {
  test('emits `## Prior Output (to be updated)` when crossClarifyContext.priorOutputBlock is set', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
        priorOutputBlock: '### design\n\n# Prior draft body',
      },
    })
    expect(out).toContain('## Prior Output (to be updated)')
    expect(out).toContain('### design')
    expect(out).toContain('# Prior draft body')
  })

  test('emits `## Update Directive` ONLY when priorOutputBlock is also set (paired)', () => {
    // Case A: priorOutputBlock present → directive emits.
    const withPrior = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: 'feedback body',
        iteration: '1',
        sourcesCsv: '',
        priorOutputBlock: '### design\n\nbody',
      },
    })
    expect(withPrior).toContain('## Update Directive')
    expect(withPrior).toContain('update')

    // Case B: priorOutputBlock empty → directive suppressed (would confuse
    // the agent — "update what?").
    const withoutPrior = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: 'feedback body',
        iteration: '1',
        sourcesCsv: '',
      },
    })
    expect(withoutPrior).not.toContain('## Update Directive')
    expect(withoutPrior).not.toContain('## Prior Output (to be updated)')
  })

  test('section order: Prior Output → External Feedback → Update Directive (update-mode logical flow)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
        priorOutputBlock: '### design\n\nbody',
      },
    })
    const priorIdx = out.indexOf('## Prior Output (to be updated)')
    const externalIdx = out.indexOf('## External Feedback')
    const directiveIdx = out.indexOf('## Update Directive')
    expect(priorIdx).toBeGreaterThan(-1)
    expect(externalIdx).toBeGreaterThan(priorIdx)
    expect(directiveIdx).toBeGreaterThan(externalIdx)
  })

  test('legacy path: no crossClarifyContext → no Prior Output / Update Directive sections', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: { requirement: 'something' },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
    })
    expect(out).not.toContain('## Prior Output (to be updated)')
    expect(out).not.toContain('## Update Directive')
    expect(out).not.toContain('## External Feedback')
    expect(out).toContain('## requirement')
    expect(out).toContain('something')
  })
})
