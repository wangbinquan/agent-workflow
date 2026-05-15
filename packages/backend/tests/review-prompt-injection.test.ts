// Locks in RFC-005 PR-B T8 prompt-template contract.
//
// Three builtin tokens land in shared/prompt.ts:
//   {{__review_rejection__}}     ← reject reason text
//   {{__review_comments__}}      ← markdown-rendered comments list
//   {{__iterate_target_port__}}  ← name of the port being iterated
//
// If this goes red:
//   - the user-visible contract is broken (agent authors are documented to
//     reference these literal token names — see RFC-005 design.md §8)
//   - check packages/shared/src/prompt.ts BUILTIN_VARS + switch
//
// The source-code-text grep block at the bottom is intentional: it pins the
// literal token names against silent renames. Agents in production reference
// these strings by name — renaming the variable in code without updating the
// docs would break every workflow that depends on the contract.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { renderUserPrompt } from '@agent-workflow/shared'

const META = {
  repoPath: '/repo',
  baseBranch: 'main',
  taskId: 'task_1',
  nodeId: 'designer',
}

describe('RFC-005 review-prompt token substitution', () => {
  test('{{__review_rejection__}} substitutes from reviewContext.rejection', () => {
    const out = renderUserPrompt({
      promptTemplate: 'rerun: {{__review_rejection__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { rejection: 'wrong direction' },
    })
    expect(out).toContain('rerun: wrong direction')
  })

  test('{{__review_comments__}} substitutes the (pre-rendered) markdown string', () => {
    const md = '- §A > intro\n  selected: "foo"\n  comment: needs work'
    const out = renderUserPrompt({
      promptTemplate: 'feedback follows:\n{{__review_comments__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { comments: md },
    })
    expect(out).toContain('feedback follows:\n' + md)
  })

  test('{{__iterate_target_port__}} substitutes the port name', () => {
    const out = renderUserPrompt({
      promptTemplate: 'iterate: {{__iterate_target_port__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { iterateTargetPort: 'design' },
    })
    expect(out).toContain('iterate: design')
  })

  test('templates that omit the tokens get auto-appended sections', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do the thing',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: {
        rejection: 'r-text',
        comments: '- c1\n- c2',
        iterateTargetPort: 'design',
      },
    })
    expect(out).toContain('## Review Rejection\nr-text')
    expect(out).toContain('## Review Comments\n- c1\n- c2')
    expect(out).toContain('## Iterate Target Port\ndesign')
  })

  test('templates that explicitly reference tokens do NOT also get auto-section', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Reason: {{__review_rejection__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { rejection: 'r-text' },
    })
    expect(out).toContain('Reason: r-text')
    expect(out).not.toContain('## Review Rejection')
  })

  test('no reviewContext → all three tokens resolve to empty string', () => {
    const out = renderUserPrompt({
      promptTemplate:
        'a={{__review_rejection__}} b={{__review_comments__}} c={{__iterate_target_port__}}',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
    })
    expect(out).toContain('a= b= c=')
    // Auto-append section never fires when context is absent.
    expect(out).not.toContain('## Review Rejection')
    expect(out).not.toContain('## Review Comments')
    expect(out).not.toContain('## Iterate Target Port')
  })

  test('empty-string rejection / comments do not trigger auto-append (whitespace-only filtered)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do work',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { rejection: '   ', comments: '\n\n' },
    })
    expect(out).not.toContain('## Review Rejection')
    expect(out).not.toContain('## Review Comments')
  })

  test('existing builtin tokens still work — no regression to RFC-001 + RFC-004 callers', () => {
    const out = renderUserPrompt({
      promptTemplate: '{{__repo_path__}}|{{__base_branch__}}|{{__task_id__}}|{{__node_id__}}',
      inputs: {},
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain('/repo|main|task_1|designer')
  })

  test('per-port unreferenced sections still emit — auto-append section logic respects RFC-005 order', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do thing',
      inputs: { topic: 'X' },
      meta: META,
      agentOutputs: [],
      reviewContext: { rejection: 'r' },
    })
    // Both per-port sections AND review auto-append fire.
    expect(out).toContain('## topic\nX')
    expect(out).toContain('## Review Rejection\nr')
  })
})

// ---------------------------------------------------------------------------
// Source-code-text regression guards: catch silent renames of the public
// token names. Agents in production reference these literal strings; renaming
// in code without updating docs would break every workflow.
// ---------------------------------------------------------------------------

describe('RFC-005 prompt token names are stable in source', () => {
  const promptSrc = readFileSync(
    resolve(import.meta.dirname, '..', '..', 'shared', 'src', 'prompt.ts'),
    'utf8',
  )

  test('shared/prompt.ts mentions __review_rejection__ literally', () => {
    expect(promptSrc).toContain('__review_rejection__')
  })

  test('shared/prompt.ts mentions __review_comments__ literally', () => {
    expect(promptSrc).toContain('__review_comments__')
  })

  test('shared/prompt.ts mentions __iterate_target_port__ literally', () => {
    expect(promptSrc).toContain('__iterate_target_port__')
  })
})
