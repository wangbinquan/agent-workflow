// RFC-234 (T1) — locks the agent.md WRITER against the RFC-018 parser:
// serialize → parse must round-trip every first-class field (the format was
// import-only before this RFC). Also locks the dump posture: reference entries
// are caller-supplied opaque strings (session handles allowed) and identity
// fields have no representation at all.

import { describe, expect, test } from 'bun:test'
import { parseAgentMarkdown } from '../src/agent-md'
import { serializeAgentMarkdown } from '../src/agent-md-serialize'

describe('serializeAgentMarkdown ⇄ parseAgentMarkdown', () => {
  test('full-field round trip', () => {
    const md = serializeAgentMarkdown({
      name: 'auditor',
      description: 'Audits diffs for defects',
      permission: { edit: 'deny', bash: 'deny' },
      skills: [
        { kind: 'managed', name: 'security-checklist' },
        { kind: 'managed', name: 'shared-skill', ownerUsername: 'alice' },
        { kind: 'project', name: 'repo-local' },
      ],
      dependsOn: ['helper-agent'],
      mcp: ['gh-mcp'],
      plugins: ['lint-plugin'],
      inputs: [{ name: 'diff', kind: 'string', required: true, description: 'unified diff' }],
      outputs: ['findings', 'summary'],
      outputKinds: { findings: 'markdown' },
      role: 'aggregator',
      outputWrapperPortNames: { findings: 'all_findings' },
      runtime: 'opencode',
      frontmatterExtra: { customFlag: true },
      bodyMd: 'You are an auditor.\n\nBe thorough.',
    })

    const r = parseAgentMarkdown(md)
    expect(r.warnings).toEqual([])
    expect(r.hadFrontmatter).toBe(true)
    expect(r.partial.name).toBe('auditor')
    expect(r.partial.description).toBe('Audits diffs for defects')
    expect(r.partial.permission).toEqual({ edit: 'deny', bash: 'deny' })
    expect(r.skillSelectors).toEqual([
      { kind: 'managed', name: 'security-checklist' },
      { kind: 'managed', name: 'shared-skill', ownerUsername: 'alice' },
      { kind: 'project', name: 'repo-local' },
    ])
    expect(r.partial.dependsOn).toEqual(['helper-agent'])
    expect(r.partial.mcp).toEqual(['gh-mcp'])
    expect(r.partial.plugins).toEqual(['lint-plugin'])
    expect(r.partial.inputs).toEqual([
      { name: 'diff', kind: 'string', required: true, description: 'unified diff' },
    ])
    expect(r.partial.outputs).toEqual(['findings', 'summary'])
    expect(r.partial.outputKinds).toEqual({ findings: 'markdown' })
    expect(r.partial.role).toBe('aggregator')
    expect(r.partial.outputWrapperPortNames).toEqual({ findings: 'all_findings' })
    expect(r.partial.runtime).toBe('opencode')
    expect(r.partial.frontmatterExtra).toEqual({ customFlag: true })
    expect(r.partial.bodyMd).toBe('You are an auditor.\n\nBe thorough.')
    expect(r.unrecognizedKeys).toEqual(['customFlag'])
  })

  test('minimal doc: empty collections omitted, empty body allowed', () => {
    const md = serializeAgentMarkdown({ name: 'tiny', outputs: [], skills: [], bodyMd: '' })
    expect(md).toBe('---\nname: tiny\n---\n')
    const r = parseAgentMarkdown(md)
    expect(r.partial.name).toBe('tiny')
    expect(r.partial.bodyMd).toBe('')
    expect(r.partial.outputs).toBeUndefined()
  })

  test('frontmatter framing survives hostile content (bare --- lines, colons)', () => {
    const md = serializeAgentMarkdown({
      name: 'hostile',
      description: '--- not a fence: really',
      bodyMd: 'body with\n---\nfence-looking line',
    })
    const r = parseAgentMarkdown(md)
    expect(r.warnings).toEqual([])
    expect(r.partial.description).toBe('--- not a fence: really')
    expect(r.partial.bodyMd).toBe('body with\n---\nfence-looking line')
  })

  test('dump posture: session handles ride reference lists verbatim; identity has no shape', () => {
    const md = serializeAgentMarkdown({
      name: 'dumped',
      skills: ['res#skill#2'],
      dependsOn: ['res#agent#3'],
      mcp: ['res#mcp#1'],
      plugins: ['res#plugin#4'],
      bodyMd: 'x',
    })
    expect(md).toContain('res#skill#2')
    expect(md).toContain('res#agent#3')
    // AgentMarkdownDocument has no id/owner/username fields at the type level;
    // assert none of the common identity keys can appear in output.
    expect(md).not.toContain('ownerUserId')
    expect(md).not.toContain('userId')
    expect(md).not.toContain('username')
  })

  test('frontmatterExtra cannot shadow first-class keys or resurrect tools', () => {
    const md = serializeAgentMarkdown({
      name: 'real-name',
      frontmatterExtra: { name: 'shadow', tools: { bash: true }, keepMe: 1 },
      bodyMd: '',
    })
    const r = parseAgentMarkdown(md)
    expect(r.partial.name).toBe('real-name')
    expect(r.partial.permission).toBeUndefined()
    expect(r.partial.frontmatterExtra).toEqual({ keepMe: 1 })
  })
})
