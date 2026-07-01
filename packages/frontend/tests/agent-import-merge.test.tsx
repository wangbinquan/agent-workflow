// RFC-018 T2 — locks the agent-md import merge semantics:
// overwrite first-class fields when partial sets them; shallow-merge
// frontmatterExtra; preserve current value when partial omits a field.

import { describe, expect, test } from 'vitest'
import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import { emptyAgent } from '../src/components/AgentForm'
import { fieldsOverwrittenByImport, mergeAgentImport } from '../src/lib/agent-import-merge'

function makeResult(partial: Partial<CreateAgent>): AgentMarkdownParseResult {
  return { partial, warnings: [], unrecognizedKeys: [], hadFrontmatter: true }
}

describe('mergeAgentImport', () => {
  test('overwrites first-class fields onto empty draft', () => {
    const current = emptyAgent()
    const merged = mergeAgentImport(
      current,
      makeResult({
        name: 'r',
        description: 'd',
        runtime: 'opencode',
        dependsOn: ['dep-a'],
      }),
    )
    expect(merged.name).toBe('r')
    expect(merged.description).toBe('d')
    expect(merged.runtime).toBe('opencode')
    expect(merged.dependsOn).toEqual(['dep-a'])
    // untouched defaults preserved
    expect(merged.outputs).toEqual([])
    expect(merged.skills).toEqual([])
  })

  test('shallow-merges frontmatterExtra: distinct keys preserved', () => {
    const current: CreateAgent = { ...emptyAgent(), frontmatterExtra: { mode: 'subagent' } }
    const merged = mergeAgentImport(current, makeResult({ frontmatterExtra: { color: '#fff' } }))
    expect(merged.frontmatterExtra).toEqual({ mode: 'subagent', color: '#fff' })
  })

  test('shallow-merges frontmatterExtra: same key, import wins', () => {
    const current: CreateAgent = { ...emptyAgent(), frontmatterExtra: { mode: 'subagent' } }
    const merged = mergeAgentImport(current, makeResult({ frontmatterExtra: { mode: 'primary' } }))
    expect(merged.frontmatterExtra).toEqual({ mode: 'primary' })
  })

  test('partial field undefined preserves current value', () => {
    const current: CreateAgent = { ...emptyAgent(), description: 'kept' }
    const merged = mergeAgentImport(current, makeResult({ bodyMd: 'new body' }))
    expect(merged.description).toBe('kept')
    expect(merged.bodyMd).toBe('new body')
  })

  test('outputs / skills never touched by parser are preserved', () => {
    const current: CreateAgent = {
      ...emptyAgent(),
      outputs: ['p1'],
      skills: ['s1'],
    }
    const merged = mergeAgentImport(
      current,
      makeResult({ description: 'd', frontmatterExtra: { mode: 'subagent' } }),
    )
    expect(merged.outputs).toEqual(['p1'])
    expect(merged.skills).toEqual(['s1'])
  })
})

describe('fieldsOverwrittenByImport', () => {
  test('returns empty when current matches empty draft', () => {
    const empty = emptyAgent()
    const fields = fieldsOverwrittenByImport(
      empty,
      makeResult({ description: 'new', runtime: 'opencode' }),
      empty,
    )
    expect(fields).toEqual([])
  })

  test('lists fields the user has already edited that would be replaced', () => {
    const empty = emptyAgent()
    const current: CreateAgent = { ...empty, description: 'edited', runtime: 'claude-code' }
    const fields = fieldsOverwrittenByImport(
      current,
      makeResult({ description: 'imported', runtime: 'opencode', bodyMd: 'new' }),
      empty,
    )
    expect(fields.sort()).toEqual(['description', 'runtime'])
  })

  test('ignores frontmatterExtra (shallow merge, not overwrite)', () => {
    const empty = emptyAgent()
    const current: CreateAgent = { ...empty, frontmatterExtra: { mode: 'subagent' } }
    const fields = fieldsOverwrittenByImport(
      current,
      makeResult({ frontmatterExtra: { color: '#fff' } }),
      empty,
    )
    expect(fields).toEqual([])
  })
})
