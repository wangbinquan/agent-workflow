// RFC-197 T1 — locks the complete agent.md → AgentForm preview surface.
// This regression exists because AgentImportDialog previously applied runtime /
// dependsOn / mcp / plugins without showing them in its three-column preview.

import { describe, expect, test } from 'vitest'
import type { AgentMarkdownParseResult } from '@agent-workflow/shared'
import { parseAgentMarkdown } from '@agent-workflow/shared'
import {
  agentMarkdownFilenameStem,
  describeAgentImport,
  validateAgentMarkdownFile,
} from '../src/lib/agent-import-preview'

describe('describeAgentImport', () => {
  test('routes the complete parser surface into all five AgentForm sections', () => {
    const parsed = parseAgentMarkdown(
      [
        '---',
        'name: reviewer',
        'description: Reviews changes',
        'runtime: opencode-review',
        'inputs:',
        '  - name: source',
        '    kind: string',
        '    description: Change set to inspect',
        'outputs: [result]',
        'outputKinds:',
        '  result: markdown',
        'outputWrapperPortNames:',
        '  result: merged_result',
        'dependsOn: [planner]',
        'mcp: [github]',
        'plugins: [review-tools]',
        'role: aggregator',
        'permission:',
        '  edit: deny',
        '  bash: allow',
        'mode: subagent',
        '---',
        'Review the changes carefully.',
        'Return actionable findings.',
      ].join('\n'),
    )

    const preview = describeAgentImport(parsed)
    expect(preview.sections.map((section) => section.tab)).toEqual([
      'basics',
      'prompt',
      'ports',
      'resources',
      'advanced',
    ])
    expect(preview.sections.map((section) => section.items.map((item) => item.field))).toEqual([
      ['name', 'description', 'runtime'],
      ['bodyMd'],
      ['inputs', 'outputs', 'outputKinds', 'outputWrapperPortNames'],
      ['dependsOn', 'mcp', 'plugins'],
      ['role', 'permission', 'mode'],
    ])
    expect(preview.itemCount).toBe(14)
    expect(preview.sectionCount).toBe(5)
    expect(preview.firstTab).toBe('basics')

    const resources = preview.sections.find((section) => section.tab === 'resources')!
    expect(resources.items.map((item) => item.field)).toEqual(['dependsOn', 'mcp', 'plugins'])
    expect(resources.items.every((item) => item.kind === 'list')).toBe(true)

    const extra = preview.sections
      .find((section) => section.tab === 'advanced')!
      .items.find((item) => item.field === 'mode')!
    expect(extra.kind).toBe('extra')
    expect(extra.id).toBe('frontmatterExtra.mode')
  })

  test('body facts use UTF-8 bytes, line count, and a bounded first-line excerpt', () => {
    const parsed: AgentMarkdownParseResult = {
      partial: { bodyMd: `你好\n${'x'.repeat(220)}` },
      warnings: [],
      unrecognizedKeys: [],
      hadFrontmatter: false,
    }
    const item = describeAgentImport(parsed).sections[0]!.items[0]!
    expect(item).toMatchObject({ kind: 'body', field: 'bodyMd', bytes: 227, lines: 2 })
    expect(item.kind === 'body' && item.excerpt).toBe('你好')
  })

  test('preserves empty first-class arrays/maps because applying them clears the draft', () => {
    const parsed: AgentMarkdownParseResult = {
      partial: {
        outputs: [],
        outputKinds: {},
        dependsOn: [],
        permission: {},
      },
      warnings: [],
      unrecognizedKeys: [],
      hadFrontmatter: true,
    }
    const preview = describeAgentImport(parsed)
    expect(preview.itemCount).toBe(4)
    expect(preview.sections.flatMap((section) => section.items.map((item) => item.field))).toEqual([
      'outputs',
      'outputKinds',
      'dependsOn',
      'permission',
    ])
  })

  test('empty partial and empty frontmatterExtra do not enable a no-op import', () => {
    const empty: AgentMarkdownParseResult = {
      partial: { frontmatterExtra: {} },
      warnings: [],
      unrecognizedKeys: [],
      hadFrontmatter: true,
    }
    expect(describeAgentImport(empty)).toEqual({
      sections: [],
      itemCount: 0,
      sectionCount: 0,
      firstTab: null,
    })
  })

  test('defensively renders an unstringifiable extra instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const parsed: AgentMarkdownParseResult = {
      partial: { frontmatterExtra: { custom: circular } },
      warnings: [],
      unrecognizedKeys: ['custom'],
      hadFrontmatter: true,
    }
    const item = describeAgentImport(parsed).sections[0]!.items[0]!
    expect(item.kind).toBe('extra')
    expect(item.kind === 'extra' && item.value).toBe('[object Object]')
  })
})

describe('agent markdown upload helpers', () => {
  test.each(['agent.md', 'agent.markdown', 'AGENT.MD', 'Agent.MarkDown'])(
    '%s is accepted',
    (name) => {
      const file = new File(['body'], name, { type: 'text/plain' })
      expect(validateAgentMarkdownFile(file)).toEqual({ ok: true, file })
    },
  )

  test.each(['agent.txt', 'agent.zip', 'agent', '.md.txt'])('%s is rejected', (name) => {
    expect(validateAgentMarkdownFile(new File(['body'], name))).toEqual({
      ok: false,
      reason: 'extension',
    })
  })

  test('filename stem removes the complete markdown extension', () => {
    expect(agentMarkdownFilenameStem('reviewer.markdown')).toBe('reviewer')
    expect(agentMarkdownFilenameStem('reviewer.MD')).toBe('reviewer')
  })
})
