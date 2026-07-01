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
import type { RuntimeProfile } from '../src/services/runtimeRegistry'

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + (overrides.name ?? 'x'),
    name: 'x',
    description: 'desc',
    outputs: [],
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

    const cfg = buildInlineConfig(primary, new Map(), [dep1, dep2])
    const keys = Object.keys(cfg.agent)
    expect(keys).toEqual(['orchestrator', 'code-auditor', 'unit-test-runner'])
    expect(cfg.agent.orchestrator?.prompt).toBe('orchestrator body')
    expect(cfg.agent['code-auditor']?.prompt).toBe('auditor body')
    expect(cfg.agent['unit-test-runner']?.prompt).toBe('runner body')
  })

  test('RFC-113: each agent entry uses ITS runtime profile from the params map', () => {
    // RFC-115: agents no longer carry model/variant/etc. — the inline params
    // come solely from the per-agent runtime profile map (each agent resolves
    // its own runtime).
    const primary = mkAgent({ name: 'orchestrator' })
    const dep = mkAgent({ name: 'code-auditor' })
    const params = new Map<string, RuntimeProfile>([
      [
        'orchestrator',
        { model: 'opus', variant: 'v1', temperature: 0.2, steps: null, maxSteps: 50 },
      ],
      [
        'code-auditor',
        { model: 'haiku', variant: 'va', temperature: 0.7, steps: 100, maxSteps: null },
      ],
    ])
    const cfg = buildInlineConfig(primary, params, [dep])
    // each agent gets ITS runtime's params (not the agent.model column).
    expect(cfg.agent.orchestrator?.model).toBe('opus')
    expect(cfg.agent.orchestrator?.variant).toBe('v1')
    expect(cfg.agent.orchestrator?.temperature).toBe(0.2)
    expect(cfg.agent.orchestrator?.maxSteps).toBe(50)
    expect(cfg.agent['code-auditor']?.model).toBe('haiku')
    expect(cfg.agent['code-auditor']?.steps).toBe(100)
  })

  test('RFC-113: an agent absent from the params map emits NO model/variant/etc (omit → binary default)', () => {
    const primary = mkAgent({ name: 'orchestrator' })
    const cfg = buildInlineConfig(primary, new Map(), [])
    expect(cfg.agent.orchestrator?.model).toBeUndefined()
    expect(cfg.agent.orchestrator?.temperature).toBeUndefined()
  })

  test('legacy single-agent shape preserved when dependents is empty', () => {
    const primary = mkAgent({ name: 'lonely' })
    const cfg = buildInlineConfig(primary, new Map(), [])
    expect(Object.keys(cfg.agent)).toEqual(['lonely'])
  })

  test('defensive: a dependent matching the primary name is skipped (would otherwise overwrite primary entry)', () => {
    const primary = mkAgent({ name: 'a', bodyMd: 'primary body' })
    const collision = mkAgent({ name: 'a', bodyMd: 'collision body' })
    const cfg = buildInlineConfig(primary, new Map(), [collision])
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
    expect(entry.options).toEqual({ outputs: [] })
  })
})
