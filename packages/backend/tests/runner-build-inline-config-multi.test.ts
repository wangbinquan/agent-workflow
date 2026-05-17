// Locks RFC-022 §design 4.3 — `buildInlineConfig(primary, overrides, dependents)`.
//
// Red here means inline JSON injection no longer carries the full closure
// (regression to the legacy single-agent map) OR per-node model/variant/
// temperature overrides started leaking to dependent agents. Both are
// product-visible: the first breaks opencode's task-tool routing to closure
// agents, the second silently shifts a dependent's model away from its
// authored default.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { buildInlineAgentEntry, buildInlineConfig } from '../src/services/runner'

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + (overrides.name ?? 'x'),
    name: 'x',
    description: 'desc',
    outputs: [],
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '## body',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('RFC-022 buildInlineConfig (primary + dependents)', () => {
  test('emits one agent entry per closure member, primary first', () => {
    const primary = mkAgent({ name: 'orchestrator', bodyMd: 'orchestrator body' })
    const dep1 = mkAgent({ name: 'code-auditor', bodyMd: 'auditor body' })
    const dep2 = mkAgent({ name: 'unit-test-runner', bodyMd: 'runner body' })

    const cfg = buildInlineConfig(primary, undefined, [dep1, dep2])
    const keys = Object.keys(cfg.agent)
    expect(keys).toEqual(['orchestrator', 'code-auditor', 'unit-test-runner'])
    expect(cfg.agent.orchestrator?.prompt).toBe('orchestrator body')
    expect(cfg.agent['code-auditor']?.prompt).toBe('auditor body')
    expect(cfg.agent['unit-test-runner']?.prompt).toBe('runner body')
  })

  test('per-node overrides apply ONLY to primary; dependents keep their own model/variant/temperature', () => {
    const primary = mkAgent({
      name: 'orchestrator',
      model: 'anthropic/claude-opus-4-7',
      variant: 'default',
      temperature: 0.2,
    })
    const dep = mkAgent({
      name: 'code-auditor',
      model: 'anthropic/claude-haiku-4-5',
      variant: 'auditor-variant',
      temperature: 0.7,
    })
    const cfg = buildInlineConfig(
      primary,
      { model: 'openrouter/o1-preview', variant: 'override-variant', temperature: 1.5 },
      [dep],
    )
    expect(cfg.agent.orchestrator?.model).toBe('openrouter/o1-preview')
    expect(cfg.agent.orchestrator?.variant).toBe('override-variant')
    expect(cfg.agent.orchestrator?.temperature).toBe(1.5)
    // Dependent must NOT inherit the per-node override.
    expect(cfg.agent['code-auditor']?.model).toBe('anthropic/claude-haiku-4-5')
    expect(cfg.agent['code-auditor']?.variant).toBe('auditor-variant')
    expect(cfg.agent['code-auditor']?.temperature).toBe(0.7)
  })

  test('legacy single-agent shape preserved when dependents is empty', () => {
    const primary = mkAgent({ name: 'lonely' })
    const cfg = buildInlineConfig(primary, undefined, [])
    expect(Object.keys(cfg.agent)).toEqual(['lonely'])
  })

  test('defensive: a dependent matching the primary name is skipped (would otherwise overwrite primary entry)', () => {
    const primary = mkAgent({ name: 'a', bodyMd: 'primary body' })
    const collision = mkAgent({ name: 'a', bodyMd: 'collision body' })
    const cfg = buildInlineConfig(primary, undefined, [collision])
    expect(Object.keys(cfg.agent)).toEqual(['a'])
    expect(cfg.agent.a?.prompt).toBe('primary body')
  })

  test('buildInlineAgentEntry omits undefined optional fields', () => {
    // The runner has historically inferred field presence with `?? agent.model`
    // / `if (steps !== undefined)` — keep those gates intact so opencode
    // doesn't see e.g. `temperature: undefined` in its merged config.
    const a = mkAgent({ name: 'minimal' })
    const entry = buildInlineAgentEntry(a)
    expect(entry.model).toBeUndefined()
    expect(entry.variant).toBeUndefined()
    expect(entry.temperature).toBeUndefined()
    expect(entry.steps).toBeUndefined()
    // Always-present fields:
    expect(entry.prompt).toBe('## body')
    expect(entry.description).toBe('desc')
    expect(entry.permission).toEqual({})
    expect(entry.options).toEqual({ outputs: [], readonly: false })
  })
})
