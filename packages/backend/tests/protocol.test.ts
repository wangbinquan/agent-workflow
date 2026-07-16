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

  // Locks in the markdown_file guidance: agents were observed to emit a
  // worktree-relative path on a markdown_file port without ever creating the
  // file behind it, then resolvePortContent (envelope.ts) failed the run on
  // the missing file. The protocol block now spells out the file-first
  // contract by name so the agent can't conflate markdown_file with
  // sibling string/markdown ports. If these assertions ever break, the agent
  // is about to be allowed back into the "path without a file" failure mode
  // — re-confirm the regression before weakening them.
  describe('markdown_file output kind guidance', () => {
    test('flags the markdown_file port in the bullet list', () => {
      const block = buildProtocolBlock(['summary', 'report'], { report: 'markdown_file' })
      expect(block).toContain('  - summary\n')
      expect(block).toContain(
        '  - report (path — write the file first, then emit only its worktree-relative path)',
      )
    })

    test('emits the two-step write-then-emit-path block naming the markdown_file ports', () => {
      const block = buildProtocolBlock(['summary', 'report', 'plan'], {
        report: 'markdown_file',
        plan: 'markdown_file',
      })
      // Names every markdown_file port so the agent knows which ones need a
      // real file behind them; sibling string ports are NOT named here.
      expect(block).toContain(
        'For path-kind ports above (`report` (extension .md/.markdown), `plan` (extension .md/.markdown))',
      )
      expect(block).toContain('USE A FILE-WRITING TOOL')
      expect(block).toContain('Write / Edit')
      expect(block).toContain('task worktree')
      expect(block).toContain(
        'place ONLY that worktree-relative path inside the matching `<port>` tag',
      )
      expect(block).toContain(
        'a path that does not point to an existing file with the declared extension causes the run to fail',
      )
    })

    test('swaps the `...` placeholder for a path hint inside the format example', () => {
      const block = buildProtocolBlock(['summary', 'report'], { report: 'markdown_file' })
      // summary is a plain string port — placeholder unchanged.
      expect(block).toContain('<port name="summary">...</port>')
      // report is markdown_file — placeholder becomes a worktree-relative path hint.
      expect(block).toContain(
        '<port name="report"><worktree-relative path to the file you just wrote></port>',
      )
    })

    test('omits the guidance block entirely when no port is markdown_file', () => {
      const noKindsBlock = buildProtocolBlock(['summary', 'findings'])
      const allStringBlock = buildProtocolBlock(['summary', 'findings'], {
        summary: 'string',
        findings: 'markdown',
      })
      for (const block of [noKindsBlock, allStringBlock]) {
        expect(block).not.toContain('For path-kind ports above')
        expect(block).not.toContain('write the file first')
        expect(block).not.toContain('USE A FILE-WRITING TOOL')
      }
    })

    test('preserves trailing </workflow-output> contract so the prompt still ends with the envelope example', () => {
      const block = buildProtocolBlock(['report'], { report: 'markdown_file' })
      // protocol block always ends with the literal close tag — this is the
      // contract the 'protocol block always appended at the end' test below
      // depends on; the markdown_file guidance is inserted BEFORE the
      // example, not after.
      expect(block.endsWith('</workflow-output>')).toBe(true)
    })

    // RFC-100 (was: "bi-modal trailing block still surfaces markdown_file
    // guidance"). buildProtocolBlock no longer has a clarify mode — while a
    // clarify channel is ACTIVE the agent is given ONLY the mandatory ask-back
    // preamble + clarify format (no `<workflow-output>` format, hence no
    // markdown_file guidance). This locks that clarify-active prompts withhold
    // the output-port guidance the old bi-modal block used to carry.
    test('RFC-100: clarify-active prompt withholds the output format + markdown_file guidance', () => {
      const out = renderUserPrompt({
        promptTemplate: 'go',
        inputs: {},
        meta: META,
        agentOutputs: ['design'],
        agentOutputKinds: { design: 'markdown_file' },
        clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
      })
      // mandatory ask-back preamble + clarify format are present...
      expect(out).toContain('MANDATORY ASK-BACK')
      expect(out).toContain('<workflow-clarify>')
      // ...the output format / port list / markdown_file guidance are NOT.
      expect(out).not.toContain('MUST end your reply with a `<workflow-output>` block')
      expect(out).not.toContain('For path-kind ports above')
      expect(out).not.toContain('USE A FILE-WRITING TOOL')
    })
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

  // Regression: `{{ port }}` with surrounding whitespace is a common authoring
  // habit AND is accepted by the launch-time validator (workflow.validator.ts
  // TEMPLATE_RE), so it MUST substitute here too. Before the fix the renderer's
  // regex was `/\{\{(\w+)\}\}/g` (no `\s*`), so a launch-valid `{{ git_diff }}`
  // rendered a LITERAL placeholder to the agent. Locks renderer↔validator
  // ref-regex alignment.
  test('resolves refs with surrounding whitespace: {{ port }} / {{  __repo_path__  }}', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Audit: {{ git_diff }} at {{  __repo_path__  }}',
      inputs: { git_diff: 'DIFFDATA' },
      meta: META,
      agentOutputs: ['findings'],
    })
    expect(out).toContain(`Audit: DIFFDATA at ${META.repoPath}`)
    expect(out).not.toContain('{{ git_diff }}')
    expect(out).not.toContain('__repo_path__')
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

  test('extended builtins: __node_id__ / __iteration__ / __shard_key__', () => {
    const out = renderUserPrompt({
      promptTemplate: 'node={{__node_id__}} iter={{__iteration__}} shard={{__shard_key__}}',
      inputs: {},
      meta: { ...META, nodeId: 'a1', iteration: 2, shardKey: 'src/x.ts' },
      agentOutputs: [],
    })
    expect(out).toContain('node=a1')
    expect(out).toContain('iter=2')
    expect(out).toContain('shard=src/x.ts')
  })

  test('extended builtins resolve to empty string when meta omits them', () => {
    const out = renderUserPrompt({
      promptTemplate: 'node=[{{__node_id__}}] iter=[{{__iteration__}}] shard=[{{__shard_key__}}]',
      inputs: {},
      meta: META,
      agentOutputs: [],
    })
    expect(out).toContain('node=[]')
    expect(out).toContain('iter=[]')
    expect(out).toContain('shard=[]')
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

  test('agentOutputKinds is threaded into the trailing protocol block', () => {
    const out = renderUserPrompt({
      promptTemplate: 'go',
      inputs: {},
      meta: META,
      agentOutputs: ['report'],
      agentOutputKinds: { report: 'markdown_file' },
    })
    // End-to-end: the runner-equivalent call surfaces the file-first rule.
    expect(out).toContain('For path-kind ports above (`report` (extension .md/.markdown))')
    expect(out).toContain('USE A FILE-WRITING TOOL')
    expect(out).toContain(
      '<port name="report"><worktree-relative path to the file you just wrote></port>',
    )
    // Final `</workflow-output>` is still the very last token of the prompt.
    expect(out.endsWith('</workflow-output>')).toBe(true)
  })
})
