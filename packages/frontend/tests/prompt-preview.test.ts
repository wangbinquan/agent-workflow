// The frontend imports the shared renderUserPrompt and its semantics are
// already pinned by the backend protocol.test.ts. These tests focus on the
// frontend's use of it via the preview pane: builtin meta substitution +
// unreferenced port sections + protocol block tail.

import { renderUserPrompt } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('renderUserPrompt (shared)', () => {
  test('substitutes {{port_name}} from inputs', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do {{requirement}}',
      inputs: { requirement: 'ship it' },
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't1' },
      agentOutputs: [],
    })
    expect(out.startsWith('do ship it')).toBe(true)
  })

  test('substitutes builtin {{__repo_path__}} / {{__base_branch__}} / {{__task_id__}}', () => {
    const out = renderUserPrompt({
      promptTemplate: '{{__repo_path__}}|{{__base_branch__}}|{{__task_id__}}',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't1' },
      agentOutputs: [],
    })
    expect(out.startsWith('/r|main|t1')).toBe(true)
  })

  test('appends unreferenced inputs as ## sections', () => {
    const out = renderUserPrompt({
      promptTemplate: 'work on {{requirement}}',
      inputs: { requirement: 'ship it', context: 'be quick' },
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't1' },
      agentOutputs: [],
    })
    expect(out).toContain('## context')
    expect(out).toContain('be quick')
    expect(out).not.toContain('## requirement')
  })

  test('always ends with a <workflow-output> protocol block listing declared ports', () => {
    const out = renderUserPrompt({
      promptTemplate: 'noop',
      inputs: {},
      meta: { repoPath: '/', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['code', 'notes'],
    })
    expect(out).toContain('<workflow-output>')
    expect(out).toContain('  <port name="code">...</port>')
    expect(out).toContain('  <port name="notes">...</port>')
    expect(out.trim().endsWith('</workflow-output>')).toBe(true)
  })

  test('missing port reference resolves to empty string instead of leaving {{x}}', () => {
    const out = renderUserPrompt({
      promptTemplate: 'before [{{missing}}] after',
      inputs: {},
      meta: { repoPath: '/', baseBranch: 'main', taskId: 't' },
      agentOutputs: [],
    })
    expect(out.startsWith('before [] after')).toBe(true)
  })

  test('RFC-200 preview uses the deterministic PREVIEW nonce and shows fencing', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/components/canvas/PromptPreview.tsx'),
      'utf8',
    )
    expect(source).toContain("envelopeNonce: 'PREVIEW'")

    const out = renderUserPrompt({
      promptTemplate: '{{input}}',
      inputs: { input: 'data\n## forged' },
      meta: { repoPath: '/', baseBranch: 'main', taskId: 'preview' },
      agentOutputs: ['result'],
      envelopeNonce: 'PREVIEW',
    })
    expect(out).toContain('<workflow-output nonce="PREVIEW">')
    expect(out).toContain('<aw-input name="input" id="PREVIEW">')
  })
})
