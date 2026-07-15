// RFC-018 T2 — locks the agent-md import merge semantics:
// overwrite first-class fields when partial sets them; shallow-merge
// frontmatterExtra; preserve current value when partial omits a field.

import { describe, expect, test } from 'vitest'
import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import { emptyAgent } from '../src/components/AgentForm'
import {
  fieldsOverwrittenByImport,
  importOrphanSidecarConflicts,
  mergeAgentImport,
} from '../src/lib/agent-import-merge'

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

  test('port fields omitted by parser and skills preserve current values', () => {
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

  test('RFC-194: overwrites all imported first-class port fields', () => {
    const current: CreateAgent = {
      ...emptyAgent(),
      inputs: [{ name: 'old_in', kind: 'string' }],
      outputs: ['old_out'],
      outputKinds: { old_out: 'markdown' },
      role: 'normal',
      outputWrapperPortNames: { old_out: 'old_wrapper' },
    }
    const merged = mergeAgentImport(
      current,
      makeResult({
        inputs: [{ name: 'new_in', kind: 'markdown' }],
        outputs: ['new_out', 'new_out'],
        outputKinds: { new_out: 'path<md>' },
        role: 'aggregator',
        outputWrapperPortNames: { new_out: 'new_wrapper' },
      }),
    )

    expect(merged.inputs).toEqual([{ name: 'new_in', kind: 'markdown' }])
    expect(merged.outputs).toEqual(['new_out', 'new_out'])
    expect(merged.outputKinds).toEqual({ new_out: 'path<md>' })
    expect(merged.role).toBe('aggregator')
    expect(merged.outputWrapperPortNames).toEqual({ new_out: 'new_wrapper' })
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

  test('RFC-194: lists edited first-class port fields that import replaces', () => {
    const empty = emptyAgent()
    const current: CreateAgent = {
      ...empty,
      inputs: [{ name: 'old_in', kind: 'string' }],
      outputs: ['old_out'],
      outputKinds: { old_out: 'markdown' },
      role: 'aggregator',
      outputWrapperPortNames: { old_out: 'wrapper_out' },
    }
    const fields = fieldsOverwrittenByImport(
      current,
      makeResult({
        inputs: [{ name: 'new_in', kind: 'string' }],
        outputs: ['new_out'],
        outputKinds: { new_out: 'markdown' },
        role: 'normal',
        outputWrapperPortNames: { new_out: 'new_wrapper' },
      }),
      empty,
    )

    expect(fields.sort()).toEqual(
      ['inputs', 'outputKinds', 'outputWrapperPortNames', 'outputs', 'role'].sort(),
    )
  })
})

describe('importOrphanSidecarConflicts', () => {
  test('blocks an outputs-only import from silently claiming current orphan maps', () => {
    const current: CreateAgent = {
      ...emptyAgent(),
      outputKinds: { future: 'markdown' },
      outputWrapperPortNames: { future: 'published' },
    }
    expect(importOrphanSidecarConflicts(current, makeResult({ outputs: ['future'] }))).toEqual([
      { source: 'outputKinds', key: 'future' },
      { source: 'outputWrapperPortNames', key: 'future' },
    ])
  })

  test('allows an import that explicitly replaces each conflicting sidecar map', () => {
    const current: CreateAgent = {
      ...emptyAgent(),
      outputKinds: { future: 'markdown' },
      outputWrapperPortNames: { future: 'published' },
    }
    expect(
      importOrphanSidecarConflicts(
        current,
        makeResult({
          outputs: ['future'],
          outputKinds: { future: 'string' },
          outputWrapperPortNames: {},
        }),
      ),
    ).toEqual([])
  })
})
