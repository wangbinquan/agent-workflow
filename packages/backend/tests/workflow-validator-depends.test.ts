// Locks RFC-022 §design 4.4 — workflow validator scans the dependsOn closure
// for every agent-single / agent-multi node.
//
// Red here means a workflow can pass `POST /api/workflows/:id/validate` while
// referencing an agent whose dependsOn chain points at a missing agent or a
// missing skill — those will only surface as a node failure at task launch.
// Catching them at save time is the whole purpose of static validation.

import { describe, expect, test } from 'bun:test'
import type { Agent, Skill, WorkflowDefinition } from '@agent-workflow/shared'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(
  name: string,
  outputs: string[] = [],
  opts: { skills?: string[]; dependsOn?: string[]; mcp?: string[]; plugins?: string[] } = {},
): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    syncOutputsOnIterate: true,
    permission: {},
    skills: opts.skills ?? [],
    dependsOn: opts.dependsOn ?? [],
    mcp: opts.mcp ?? [],
    plugins: opts.plugins ?? [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function skill(name: string): Skill {
  return {
    id: `skill-${name}`,
    name,
    description: '',
    sourceKind: 'managed',
    managedPath: `/tmp/${name}`,
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeDef(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'orchestrator' }],
    edges: [],
  }
}

describe('RFC-022 workflow validator: dependsOn closure scan', () => {
  test('reports agent-dependency-not-found when closure references a missing agent', () => {
    // orchestrator → auditor (defined) → explainer (NOT defined)
    const orch = agent('orchestrator', ['out'], { dependsOn: ['auditor'] })
    const auditor = agent('auditor', ['out'], { dependsOn: ['explainer'] })
    const def = makeDef()
    const res = validateWorkflowDef(def, { agents: [orch, auditor], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('agent-dependency-not-found')
    const missingIssue = res.issues.find((i) => i.code === 'agent-dependency-not-found')
    expect(missingIssue?.pointer).toBe('n1')
    expect(missingIssue?.message).toContain('explainer')
  })

  test('reports skill-not-found when a dependent agent references a missing skill', () => {
    // orchestrator → auditor; auditor.skills = ['style-guide'] but
    // style-guide skill is not registered. Primary's own skills validate
    // independently — we want the dependent's skill miss reported too.
    const orch = agent('orchestrator', ['out'], { dependsOn: ['auditor'] })
    const auditor = agent('auditor', ['out'], { skills: ['style-guide'] })
    const def = makeDef()
    const res = validateWorkflowDef(def, { agents: [orch, auditor], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('skill-not-found')
    const missingSkill = res.issues.find((i) => i.code === 'skill-not-found')
    expect(missingSkill?.message).toContain('auditor')
    expect(missingSkill?.message).toContain('style-guide')
  })

  test('valid: full closure resolves (agents + skills) — no agent-dependency-not-found', () => {
    const orch = agent('orchestrator', ['out'], { dependsOn: ['auditor'] })
    const auditor = agent('auditor', ['out'], {
      skills: ['style-guide'],
      dependsOn: ['explainer'],
      mcp: [],
      plugins: [],
    })
    const explainer = agent('explainer')
    const def = makeDef()
    const res = validateWorkflowDef(def, {
      agents: [orch, auditor, explainer],
      skills: [skill('style-guide')],
    })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('agent-dependency-not-found')
    expect(codes).not.toContain('skill-not-found')
  })

  test('seen-set guards against externally-introduced cycles (no infinite loop)', () => {
    // The save-time guard refuses cycles, but the validator is also reachable
    // through YAML import / CI fixtures with stale DBs. Defensive `seen` set
    // must short-circuit before recursing into a loop. Red here = hung test.
    const a = agent('a', ['out'], { dependsOn: ['b'] })
    const b = agent('b', ['out'], { dependsOn: ['a'] }) // cycle a↔b
    const def: WorkflowDefinition = {
      ...makeDef(),
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a' }],
    }
    const res = validateWorkflowDef(def, { agents: [a, b], skills: [] })
    // No specific cycle code from the validator (save-guard owns that); the
    // validator just needs to terminate cleanly with no dep-related issues
    // beyond what the data warrants. Critically: it must NOT hang.
    expect(res.issues.some((i) => i.code === 'agent-dependency-not-found')).toBe(false)
  })
})
