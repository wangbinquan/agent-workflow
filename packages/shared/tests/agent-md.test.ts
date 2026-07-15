// Tests for RFC-018 shared parser (parseAgentMarkdown).
// Locks in mapping rules, opencode normalize parity (tools→permission), and the
// unrecognized-key → frontmatterExtra fallback — including the RFC-115 rule that
// the dropped generation keys (model/variant/temperature/steps/maxSteps) now
// fall through to frontmatterExtra instead of becoming first-class fields.

import { describe, expect, test } from 'bun:test'
import { parseAgentMarkdown } from '../src/agent-md'

describe('parseAgentMarkdown', () => {
  test('happy-path: description + body', () => {
    const r = parseAgentMarkdown('---\ndescription: A reviewer\n---\nYou are an auditor.\n')
    expect(r.hadFrontmatter).toBe(true)
    expect(r.partial).toEqual({
      description: 'A reviewer',
      bodyMd: 'You are an auditor.',
    })
    expect(r.warnings).toEqual([])
    expect(r.unrecognizedKeys).toEqual([])
  })

  test('full field set with unknown keys routed to extras', () => {
    const src = [
      '---',
      'name: reviewer',
      'description: A reviewer',
      'model: anthropic/claude-sonnet-4-6',
      'variant: balanced',
      'temperature: 0.2',
      'steps: 12',
      'permission:',
      '  edit: ask',
      'mode: subagent',
      'color: "#FF5733"',
      'hidden: true',
      '---',
      'body line',
    ].join('\n')
    const r = parseAgentMarkdown(src)
    expect(r.partial.name).toBe('reviewer')
    expect(r.partial.description).toBe('A reviewer')
    expect(r.partial.permission).toEqual({ edit: 'ask' })
    expect(r.partial.bodyMd).toBe('body line')
    // RFC-115: model/variant/temperature/steps are no longer first-class fields —
    // they land in frontmatterExtra alongside the genuinely unknown keys.
    expect(r.partial.frontmatterExtra).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      variant: 'balanced',
      temperature: 0.2,
      steps: 12,
      mode: 'subagent',
      color: '#FF5733',
      hidden: true,
    })
    expect(r.unrecognizedKeys.sort()).toEqual([
      'color',
      'hidden',
      'mode',
      'model',
      'steps',
      'temperature',
      'variant',
    ])
    expect(r.warnings).toEqual([])
  })

  test('tools normalize: write/edit/patch collapse to permission.edit', () => {
    const src = [
      '---',
      'tools:',
      '  write: false',
      '  bash: true',
      '  read: true',
      '---',
      'b',
    ].join('\n')
    const r = parseAgentMarkdown(src)
    expect(r.partial.permission).toEqual({
      edit: 'deny',
      bash: 'allow',
      read: 'allow',
    })
    // tools consumed → not in extras / unrecognized
    expect(r.partial.frontmatterExtra).toBeUndefined()
    expect(r.unrecognizedKeys).toEqual([])
  })

  test('explicit permission wins over tools-derived entries', () => {
    const src = [
      '---',
      'tools:',
      '  write: true', // would map to edit=allow
      '  edit: false', // also maps to edit (last-tools-wins → edit=deny)
      'permission:',
      '  edit: ask', // explicit → final winner
      '---',
    ].join('\n')
    const r = parseAgentMarkdown(src)
    expect(r.partial.permission?.edit).toBe('ask')
  })

  // RFC-115 regression lock: the agent contract dropped model/variant/
  // temperature/steps/maxSteps (they moved onto the runtime profile in RFC-113).
  // A legacy agent.md carrying them must NOT re-introduce them as first-class
  // CreateAgent fields — they route into frontmatterExtra verbatim (no data
  // loss, surfaced in the import preview) and emit no validation warning.
  test('RFC-115: dropped generation keys route to frontmatterExtra, never partial', () => {
    const r = parseAgentMarkdown(
      [
        '---',
        'model: anthropic/claude-sonnet-4-6',
        'variant: balanced',
        'temperature: 0.4',
        'steps: 10',
        'maxSteps: 50',
        '---',
        'body',
      ].join('\n'),
    )
    // Not first-class fields any more.
    expect('model' in r.partial).toBe(false)
    expect('variant' in r.partial).toBe(false)
    expect('temperature' in r.partial).toBe(false)
    expect('steps' in r.partial).toBe(false)
    expect('maxSteps' in r.partial).toBe(false)
    // Preserved verbatim in frontmatterExtra instead.
    expect(r.partial.frontmatterExtra).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      variant: 'balanced',
      temperature: 0.4,
      steps: 10,
      maxSteps: 50,
    })
    expect(r.unrecognizedKeys.sort()).toEqual([
      'maxSteps',
      'model',
      'steps',
      'temperature',
      'variant',
    ])
    // No "must be non-empty/positive" warnings — plain passthrough now.
    expect(r.warnings).toEqual([])
  })

  test('malformed YAML surfaces yaml-parse-failed warning, partial keeps body', () => {
    const src = '---\nkey: : :\n---\nbody'
    const r = parseAgentMarkdown(src)
    expect(r.hadFrontmatter).toBe(true)
    expect(r.warnings[0]?.startsWith('yaml-parse-failed:')).toBe(true)
    expect(r.partial).toEqual({ bodyMd: 'body' })
  })

  test('no frontmatter: entire input goes to bodyMd', () => {
    const r = parseAgentMarkdown('just a body line\nsecond line\n')
    expect(r.hadFrontmatter).toBe(false)
    expect(r.partial).toEqual({ bodyMd: 'just a body line\nsecond line' })
    expect(r.warnings).toEqual([])
  })

  test('array-typed frontmatter is rejected with warning, body kept', () => {
    const r = parseAgentMarkdown('---\n- a\n- b\n---\nbody')
    expect(r.partial).toEqual({ bodyMd: 'body' })
    expect(r.warnings.some((w) => w.startsWith('frontmatter-not-object'))).toBe(true)
  })

  test('null frontmatter (empty block) → no fields, body kept', () => {
    const r = parseAgentMarkdown('---\n\n---\nbody')
    expect(r.partial).toEqual({ bodyMd: 'body' })
    expect(r.warnings).toEqual([])
  })

  test('body trim: outer blank lines stripped, inner preserved', () => {
    const src = '---\ndescription: x\n---\n\n\n  body line\n\nsecond\n\n\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.bodyMd).toBe('body line\n\nsecond')
  })

  test('filenameStem used when frontmatter has no name', () => {
    const r = parseAgentMarkdown('---\ndescription: x\n---\nbody', {
      filenameStem: 'reviewer',
    })
    expect(r.partial.name).toBe('reviewer')
  })

  test('frontmatter.name beats filenameStem', () => {
    const r = parseAgentMarkdown('---\nname: explicit\n---\n', {
      filenameStem: 'fromfile',
    })
    expect(r.partial.name).toBe('explicit')
  })

  test('RFC-115: a numeric model value passes through to frontmatterExtra with no warning', () => {
    const r = parseAgentMarkdown('---\nmodel: 42\n---\n')
    // model is no longer validated — any value (even a number) is just an
    // unrecognized key that lands in frontmatterExtra without a warning.
    expect('model' in r.partial).toBe(false)
    expect(r.partial.frontmatterExtra).toEqual({ model: 42 })
    expect(r.warnings.some((w) => w.startsWith('model must be'))).toBe(false)
  })

  test('non-object permission falls back to extras', () => {
    const r = parseAgentMarkdown('---\npermission: allow\n---\n')
    expect(r.partial.permission).toBeUndefined()
    expect(r.partial.frontmatterExtra).toEqual({ permission: 'allow' })
    expect(r.warnings.some((w) => w.includes('permission must be an object'))).toBe(true)
  })

  test('body containing additional --- fences is preserved verbatim', () => {
    const src = ['---', 'description: x', '---', 'pre', '', '---', 'inner', '---', 'post'].join(
      '\n',
    )
    const r = parseAgentMarkdown(src)
    expect(r.partial.bodyMd).toBe('pre\n\n---\ninner\n---\npost')
  })

  test('unicode + CJK content survives roundtrip', () => {
    const src = '---\ndescription: 中文描述\n---\n你好世界'
    const r = parseAgentMarkdown(src)
    expect(r.partial.description).toBe('中文描述')
    expect(r.partial.bodyMd).toBe('你好世界')
  })

  test('non-boolean tools entry produces warning but other entries still map', () => {
    const src = '---\ntools:\n  bash: true\n  weird: "allow"\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.permission).toEqual({ bash: 'allow' })
    expect(r.warnings.some((w) => w.startsWith('tools.weird must be boolean'))).toBe(true)
  })

  test('CRLF newlines are accepted', () => {
    const src = '---\r\ndescription: x\r\n---\r\nbody'
    const r = parseAgentMarkdown(src)
    expect(r.partial.description).toBe('x')
    expect(r.partial.bodyMd).toBe('body')
  })

  // RFC-194: all existing port fields are first-class import fields. Duplicate
  // names intentionally survive parsing so the Ports editor can present its
  // explicit repair flow instead of hiding the field in frontmatterExtra.
  test('RFC-194: port fields parse first-class and preserve legacy duplicates', () => {
    const src = [
      '---',
      'inputs:',
      '  - name: source',
      '    kind: string',
      '    required: true',
      '  - name: source',
      '    kind: markdown',
      'outputs:',
      '  - result',
      '  - result',
      'outputKinds:',
      '  result: markdown',
      'role: aggregator',
      'outputWrapperPortNames:',
      '  result: merged_result',
      '---',
      'body',
    ].join('\n')

    const r = parseAgentMarkdown(src)

    expect(r.partial.inputs).toEqual([
      { name: 'source', kind: 'string', required: true },
      { name: 'source', kind: 'markdown' },
    ])
    expect(r.partial.outputs).toEqual(['result', 'result'])
    expect(r.partial.outputKinds).toEqual({ result: 'markdown' })
    expect(r.partial.role).toBe('aggregator')
    expect(r.partial.outputWrapperPortNames).toEqual({ result: 'merged_result' })
    expect(r.partial.frontmatterExtra).toBeUndefined()
    expect(r.unrecognizedKeys).toEqual([])
    expect(r.warnings).toEqual([])
  })

  test('RFC-194: malformed port fields are preserved in extras with warnings', () => {
    const src = [
      '---',
      'inputs:',
      '  - name: valid',
      '    kind: not_registered',
      'outputs:',
      '  - result',
      '  - 7',
      'outputKinds:',
      '  result: not_registered',
      'role: leader',
      'outputWrapperPortNames:',
      '  result: ""',
      '---',
    ].join('\n')

    const r = parseAgentMarkdown(src)

    expect(r.partial.inputs).toBeUndefined()
    expect(r.partial.outputs).toBeUndefined()
    expect(r.partial.outputKinds).toBeUndefined()
    expect(r.partial.role).toBeUndefined()
    expect(r.partial.outputWrapperPortNames).toBeUndefined()
    expect(r.partial.frontmatterExtra).toEqual({
      inputs: [{ name: 'valid', kind: 'not_registered' }],
      outputs: ['result', 7],
      outputKinds: { result: 'not_registered' },
      role: 'leader',
      outputWrapperPortNames: { result: '' },
    })
    expect(r.unrecognizedKeys).toEqual([])
    expect(r.warnings).toEqual([
      'inputs must be an array of valid input ports; kept in frontmatterExtra',
      'outputs must be an array of strings; kept in frontmatterExtra',
      'outputKinds must map port names to registered kinds; kept in frontmatterExtra',
      'role must be normal or aggregator; kept in frontmatterExtra',
      'outputWrapperPortNames must map port names to non-empty strings; kept in frontmatterExtra',
    ])
  })

  // RFC-022: dependsOn parser cases.
  test('dependsOn (array of valid names) round-trips and dedupes order', () => {
    const src =
      '---\ndependsOn:\n  - code-auditor\n  - unit_test_runner\n  - code-auditor\n---\nbody'
    const r = parseAgentMarkdown(src)
    expect(r.partial.dependsOn).toEqual(['code-auditor', 'unit_test_runner'])
    expect(r.warnings).toEqual([])
    expect(r.unrecognizedKeys).toEqual([])
  })

  test('dependsOn with an invalid name entry demotes the whole field to frontmatterExtra with a warning', () => {
    // Mixed valid + invalid: per design.md §4.5 we don't silently swallow the
    // invalid entry; the whole field goes to extras so the import dialog can
    // surface the raw value to the author for manual fixing.
    const src = '---\ndependsOn:\n  - code-auditor\n  - "Bad Name!"\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.dependsOn).toBeUndefined()
    expect(r.partial.frontmatterExtra?.dependsOn).toEqual(['code-auditor', 'Bad Name!'])
    expect(r.warnings.some((w) => w.includes('dependsOn entries must match'))).toBe(true)
  })

  test('dependsOn with non-array value demotes to frontmatterExtra with a warning', () => {
    const src = '---\ndependsOn: code-auditor\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.dependsOn).toBeUndefined()
    expect(r.partial.frontmatterExtra?.dependsOn).toBe('code-auditor')
    expect(r.warnings.some((w) => w.startsWith('dependsOn must be an array'))).toBe(true)
  })

  // RFC-028: mcp parser cases — mirror dependsOn's shape policy so the import
  // dialog can surface missing-MCP candidates the same way as missing-agents.
  test('mcp (array of valid names) round-trips and dedupes order', () => {
    const src = '---\nmcp:\n  - postgres-prod\n  - sentry\n  - postgres-prod\n---\nbody'
    const r = parseAgentMarkdown(src)
    expect(r.partial.mcp).toEqual(['postgres-prod', 'sentry'])
    expect(r.warnings).toEqual([])
    expect(r.unrecognizedKeys).toEqual([])
  })

  test('mcp with an invalid name demotes the whole field to frontmatterExtra with a warning', () => {
    const src = '---\nmcp:\n  - postgres-prod\n  - "Bad Name"\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.mcp).toBeUndefined()
    expect(r.partial.frontmatterExtra?.mcp).toEqual(['postgres-prod', 'Bad Name'])
    expect(r.warnings.some((w) => w.includes('mcp entries must match'))).toBe(true)
  })

  test('mcp with non-array value demotes to frontmatterExtra with a warning', () => {
    const src = '---\nmcp: postgres-prod\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.mcp).toBeUndefined()
    expect(r.partial.frontmatterExtra?.mcp).toBe('postgres-prod')
    expect(r.warnings.some((w) => w.startsWith('mcp must be an array'))).toBe(true)
  })

  // RFC-031: plugins parser cases — mirror dependsOn / mcp shape policy so the
  // import dialog can surface missing-plugin candidates the same way.
  test('plugins (array of valid names) round-trips and dedupes order', () => {
    const src = '---\nplugins:\n  - dd-trace\n  - opencode-changelog\n  - dd-trace\n---\nbody'
    const r = parseAgentMarkdown(src)
    expect(r.partial.plugins).toEqual(['dd-trace', 'opencode-changelog'])
    expect(r.warnings).toEqual([])
    expect(r.unrecognizedKeys).toEqual([])
  })

  test('plugins with an invalid name demotes the whole field to frontmatterExtra', () => {
    const src = '---\nplugins:\n  - dd-trace\n  - "Bad Name"\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.plugins).toBeUndefined()
    expect(r.partial.frontmatterExtra?.plugins).toEqual(['dd-trace', 'Bad Name'])
    expect(r.warnings.some((w) => w.includes('plugins entries must match'))).toBe(true)
  })

  test('plugins with non-array value demotes to frontmatterExtra', () => {
    const src = '---\nplugins: dd-trace\n---\n'
    const r = parseAgentMarkdown(src)
    expect(r.partial.plugins).toBeUndefined()
    expect(r.partial.frontmatterExtra?.plugins).toBe('dd-trace')
    expect(r.warnings.some((w) => w.startsWith('plugins must be an array'))).toBe(true)
  })

  // RFC-111 (Codex audit F6): `runtime` must parse into partial.runtime, not get
  // silently dropped into frontmatterExtra — it was missing from KNOWN_KEYS, so an
  // authored `runtime:` never applied on import.
  test('RFC-111/F6: runtime parses into partial.runtime (not frontmatterExtra)', () => {
    const src = ['---', 'name: r', 'runtime: claude-code', '---', 'b'].join('\n')
    const r = parseAgentMarkdown(src)
    expect(r.partial.runtime).toBe('claude-code')
    expect(r.partial.frontmatterExtra).toBeUndefined()
    expect(r.unrecognizedKeys).not.toContain('runtime')
    expect(r.warnings).toEqual([])
  })

  test('RFC-111/F6: non-string runtime demotes to frontmatterExtra with a warning', () => {
    const src = ['---', 'name: r', 'runtime: 123', '---', 'b'].join('\n')
    const r = parseAgentMarkdown(src)
    expect(r.partial.runtime).toBeUndefined()
    expect(r.partial.frontmatterExtra).toEqual({ runtime: 123 })
    expect(r.warnings.some((w) => w.startsWith('runtime must be a non-empty string'))).toBe(true)
  })
})
