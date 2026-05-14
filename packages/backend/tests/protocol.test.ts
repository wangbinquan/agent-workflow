import { describe, expect, test } from 'bun:test'
import { buildProtocolBlock, renderUserPrompt } from '../src/services/protocol'

const META = {
  repoPath: '/Users/me/repo',
  baseBranch: 'main',
  taskId: '01HXTASK',
}

describe('buildProtocolBlock', () => {
  test('lists declared ports in English', () => {
    const block = buildProtocolBlock(['summary', 'findings'])
    expect(block).toContain('MUST end your reply with a `<workflow-output>` block')
    expect(block).toContain('  - summary')
    expect(block).toContain('  - findings')
    expect(block).toContain('<port name="summary">...</port>')
    expect(block).toContain('<port name="findings">...</port>')
    expect(block).toMatch(/<\/workflow-output>$/)
  })

  test('empty agent outputs still produce a usable block', () => {
    const block = buildProtocolBlock([])
    expect(block).toContain('<workflow-output>')
    expect(block).toContain('</workflow-output>')
  })
})

describe('renderUserPrompt — template substitution', () => {
  test('replaces {{port}} with concatenated upstream content', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Audit this diff:\n{{git_diff}}',
      inputs: { git_diff: 'diff --git a/x b/x\n+hello' },
      meta: META,
      agentOutputs: ['findings'],
    })
    expect(out).toContain('Audit this diff:\ndiff --git')
    expect(out).toContain('+hello')
  })

  test('built-in variables replaced', () => {
    const out = renderUserPrompt({
      promptTemplate: 'repo={{__repo_path__}} base={{__base_branch__}} task={{__task_id__}}',
      inputs: {},
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain(`repo=${META.repoPath}`)
    expect(out).toContain(`base=${META.baseBranch}`)
    expect(out).toContain(`task=${META.taskId}`)
  })

  test('unknown {{x}} substitutes empty string (caller does static check elsewhere)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'before [{{nope}}] after',
      inputs: {},
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain('before [] after')
  })

  test('unreferenced input ports appended as sections in insertion order', () => {
    const out = renderUserPrompt({
      promptTemplate: 'just do {{action}}',
      inputs: { action: 'audit', git_diff: 'A diff\n', notes: 'be terse' },
      meta: META,
      agentOutputs: ['findings'],
    })
    expect(out).toContain('just do audit')
    expect(out).toContain('\n\n## git_diff\nA diff')
    expect(out).toContain('\n\n## notes\nbe terse')
    // Action was referenced so it must NOT show up as a section
    expect(out).not.toMatch(/## action\n/)
  })

  test('empty promptTemplate falls back to sections-only', () => {
    const out = renderUserPrompt({
      promptTemplate: undefined,
      inputs: { x: 'X' },
      meta: META,
      agentOutputs: ['out1'],
    })
    expect(out).toContain('## x\nX')
    expect(out).toContain('<workflow-output>')
  })

  test('protocol block always appended at the end', () => {
    const out = renderUserPrompt({
      promptTemplate: 'do thing',
      inputs: {},
      meta: META,
      agentOutputs: ['x'],
    })
    expect(out.endsWith('</workflow-output>')).toBe(true)
  })

  test('multiple references to same port still mark it as referenced once', () => {
    const out = renderUserPrompt({
      promptTemplate: '{{a}} then {{a}} again',
      inputs: { a: 'AAA', b: 'BBB' },
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain('AAA then AAA again')
    expect(out).toContain('## b\nBBB')
    expect(out).not.toMatch(/## a\n/)
  })

  test('built-in vars do not need to appear in inputs', () => {
    const out = renderUserPrompt({
      promptTemplate: 'cwd={{__repo_path__}}',
      inputs: { unrelated: 'data' },
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain(`cwd=${META.repoPath}`)
    expect(out).toContain('## unrelated\ndata')
  })
})
