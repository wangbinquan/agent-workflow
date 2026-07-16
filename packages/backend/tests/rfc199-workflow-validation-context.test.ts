// RFC-199 B3 — validation-context receipts must change whenever inventory
// semantics change, while excluding prompt/secret/runtime-path material.

import { describe, expect, test } from 'bun:test'
import { canonicalJson, type Agent, type Skill } from '@agent-workflow/shared'
import {
  projectWorkflowValidationContext,
  workflowValidationContextHashOf,
  type ValidatorContext,
} from '../src/services/workflow.validator'

function agent(name = 'coder'): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: 'public description',
    ownerUserId: 'owner-1',
    visibility: 'private',
    builtin: false,
    inputs: [{ name: 'query', kind: 'string', required: true, description: 'input help' }],
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    outputWrapperPortNames: { answer: 'accepted' },
    role: 'normal',
    syncOutputsOnIterate: true,
    runtime: 'opencode',
    permission: { bash: 'allow-secret-shape' },
    skills: ['reviewing'],
    dependsOn: [],
    mcp: ['filesystem'],
    plugins: ['formatter'],
    frontmatterExtra: { apiKey: 'frontmatter-secret' },
    bodyMd: 'SYSTEM PROMPT SECRET',
    schemaVersion: 4,
    createdAt: 10,
    updatedAt: 20,
  }
}

function skill(name = 'reviewing'): Skill {
  return {
    id: `skill-${name}`,
    name,
    description: 'skill description',
    ownerUserId: 'owner-1',
    visibility: 'private',
    sourceKind: 'managed',
    managedPath: '/secret/skill/path',
    schemaVersion: 2,
    contentVersion: 7,
    createdAt: 10,
    updatedAt: 30,
  }
}

function context(): ValidatorContext {
  return {
    agents: [agent('coder'), agent('auditor')],
    skills: [skill('reviewing')],
    plugins: [
      {
        id: 'plugin-formatter',
        name: 'formatter',
        ownerUserId: 'owner-1',
        visibility: 'private',
        enabled: true,
        sourceKind: 'npm',
        resolvedVersion: '1.2.3',
        schemaVersion: 3,
        updatedAt: 40,
      },
    ],
  }
}

describe('RFC-199 validation context projection', () => {
  test('is deterministic across inventory row order and has a domain-separated hash', () => {
    const first = context()
    const reordered: ValidatorContext = {
      ...first,
      agents: [...first.agents].reverse(),
      skills: [...first.skills].reverse(),
      plugins: [...(first.plugins ?? [])].reverse(),
    }
    expect(projectWorkflowValidationContext(first)).toEqual(
      projectWorkflowValidationContext(reordered),
    )
    expect(workflowValidationContextHashOf(first)).toBe(workflowValidationContextHashOf(reordered))
    expect(workflowValidationContextHashOf(first)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('projects semantic identity/capability/version fields but excludes secrets and prompt text', () => {
    const serialized = canonicalJson(projectWorkflowValidationContext(context()))
    expect(serialized).toContain('outputWrapperPortNames')
    expect(serialized).toContain('contentVersion')
    expect(serialized).toContain('resolvedVersion')
    expect(serialized).not.toContain('SYSTEM PROMPT SECRET')
    expect(serialized).not.toContain('frontmatter-secret')
    expect(serialized).not.toContain('allow-secret-shape')
    expect(serialized).not.toContain('/secret/skill/path')
    expect(serialized).not.toContain('cachedPath')
    expect(serialized).not.toContain('spec')
  })

  test('every validator/port-relevant inventory family invalidates the hash', () => {
    const base = workflowValidationContextHashOf(context())
    const mutations: Array<(ctx: ValidatorContext) => void> = [
      (ctx) => ctx.agents[0]!.outputs.push('summary'),
      (ctx) => {
        ctx.agents[0]!.outputKinds = { answer: 'string' }
      },
      (ctx) => ctx.agents[0]!.inputs?.push({ name: 'repo', kind: 'path<*>' }),
      (ctx) => {
        ctx.agents[0]!.outputWrapperPortNames = { answer: 'report' }
      },
      (ctx) => {
        ctx.agents[0]!.role = 'aggregator'
      },
      (ctx) => ctx.agents[0]!.dependsOn.push('auditor'),
      (ctx) => ctx.agents[0]!.skills.push('extra-skill'),
      (ctx) => ctx.agents[0]!.mcp.push('browser'),
      (ctx) => ctx.agents[0]!.plugins.push('extra-plugin'),
      (ctx) => {
        ctx.agents[0]!.runtime = 'claude-code'
      },
      (ctx) => {
        ctx.agents[0]!.visibility = 'public'
      },
      (ctx) => {
        ctx.skills[0]!.contentVersion += 1
      },
      (ctx) => {
        ctx.plugins![0]!.enabled = false
      },
      (ctx) => {
        ctx.plugins![0]!.resolvedVersion = '2.0.0'
      },
    ]

    for (const mutate of mutations) {
      const next = structuredClone(context())
      mutate(next)
      expect(workflowValidationContextHashOf(next)).not.toBe(base)
    }
  })

  test('agent prompt, permission and arbitrary frontmatter do not enter the hash', () => {
    const base = context()
    const changed = structuredClone(base)
    changed.agents[0]!.bodyMd = 'DIFFERENT SECRET PROMPT'
    changed.agents[0]!.permission = { bash: 'deny' }
    changed.agents[0]!.frontmatterExtra = { token: 'different-secret' }
    expect(workflowValidationContextHashOf(changed)).toBe(workflowValidationContextHashOf(base))
  })
})
