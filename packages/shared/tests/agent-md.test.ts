// Tests for RFC-018 shared parser (parseAgentMarkdown).
// Locks in mapping rules, opencode normalize parity (tools→permission,
// steps?? maxSteps), and the unrecognized-key → frontmatterExtra fallback.

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
    expect(r.partial.model).toBe('anthropic/claude-sonnet-4-6')
    expect(r.partial.variant).toBe('balanced')
    expect(r.partial.temperature).toBe(0.2)
    expect(r.partial.steps).toBe(12)
    expect(r.partial.permission).toEqual({ edit: 'ask' })
    expect(r.partial.bodyMd).toBe('body line')
    expect(r.partial.frontmatterExtra).toEqual({
      mode: 'subagent',
      color: '#FF5733',
      hidden: true,
    })
    expect(r.unrecognizedKeys.sort()).toEqual(['color', 'hidden', 'mode'])
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

  test('maxSteps coalesces into steps when steps missing; both preserved when both present', () => {
    const a = parseAgentMarkdown('---\nmaxSteps: 50\n---\n')
    expect(a.partial.steps).toBe(50)
    expect(a.partial.maxSteps).toBe(50)

    const b = parseAgentMarkdown('---\nsteps: 10\nmaxSteps: 50\n---\n')
    expect(b.partial.steps).toBe(10)
    expect(b.partial.maxSteps).toBe(50)
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

  test('type mismatch routes value to extras + warning (model number)', () => {
    const r = parseAgentMarkdown('---\nmodel: 42\n---\n')
    expect(r.partial.model).toBeUndefined()
    expect(r.partial.frontmatterExtra).toEqual({ model: 42 })
    expect(r.warnings.some((w) => w.startsWith('model must be non-empty string'))).toBe(true)
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
})
