// RFC-031 T6 (validator side) — workflow validator surfaces
// `plugin-not-found` / `plugin-disabled` for both the directly used agent and
// any agent in its dependsOn closure. Locks the wire shape so the UI can
// list missing plugins inline.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { validateWorkflowDef } from '../src/services/workflow.validator'

// RFC-223 (PR-1): agent refs are stored BY ID; this helper maps dependsOn /
// plugin NAMES to the `id-<name>` / `plugin-<name>` id convention (node→agent
// stays by name via agentName), matching the ctx plugin fixtures' ids below.
function agent(
  name: string,
  outputs: string[] = [],
  opts: { dependsOn?: string[]; plugins?: string[] } = {},
): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: (opts.dependsOn ?? []).map((d) => `id-${d}`),
    mcp: [],
    plugins: (opts.plugins ?? []).map((p) => `plugin-${p}`),
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function defWith(agentName: string) {
  return {
    $schema_version: 1 as const,
    inputs: [] as never[],
    nodes: [{ id: 'n1', kind: 'agent-single' as const, agentName }],
    edges: [] as never[],
  }
}

describe('workflow validator — RFC-031 plugin reference checks', () => {
  test('plugin-not-found on the directly used agent', () => {
    const a = agent('orchestrator', ['out'], { plugins: ['no-such'] })
    const res = validateWorkflowDef(defWith('orchestrator'), {
      agents: [a],
      skills: [],
      plugins: [],
    })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('plugin-not-found')
    const issue = res.issues.find((i) => i.code === 'plugin-not-found')
    expect(issue?.message).toContain('orchestrator')
    expect(issue?.message).toContain('no-such')
    expect(issue?.pointer).toBe('n1')
  })

  test('plugin-disabled when referenced plugin exists but is disabled', () => {
    const a = agent('orchestrator', ['out'], { plugins: ['off'] })
    const res = validateWorkflowDef(defWith('orchestrator'), {
      agents: [a],
      skills: [],
      plugins: [{ id: 'plugin-off', name: 'off', enabled: false }],
    })
    expect(res.issues.map((i) => i.code)).toContain('plugin-disabled')
  })

  test('closure: dependent agent referencing missing plugin → plugin-not-found', () => {
    const orch = agent('orchestrator', ['out'], { dependsOn: ['leaf'] })
    const leaf = agent('leaf', ['out'], { plugins: ['ghost'] })
    const res = validateWorkflowDef(defWith('orchestrator'), {
      agents: [orch, leaf],
      skills: [],
      plugins: [],
    })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('plugin-not-found')
    const issue = res.issues.find((i) => i.code === 'plugin-not-found')
    expect(issue?.message).toContain('leaf')
    expect(issue?.message).toContain('ghost')
  })

  test('no plugin issues when ctx.plugins is undefined (pre-RFC-031 callers)', () => {
    const a = agent('o', ['out'], { plugins: ['anything'] })
    const res = validateWorkflowDef(defWith('o'), { agents: [a], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('plugin-not-found')
    expect(codes).not.toContain('plugin-disabled')
  })

  test('happy path: all plugins known + enabled → no plugin issues', () => {
    const a = agent('o', ['out'], { plugins: ['ok'] })
    const res = validateWorkflowDef(defWith('o'), {
      agents: [a],
      skills: [],
      plugins: [{ id: 'plugin-ok', name: 'ok', enabled: true }],
    })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('plugin-not-found')
    expect(codes).not.toContain('plugin-disabled')
  })
})
