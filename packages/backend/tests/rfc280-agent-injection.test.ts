// RFC-280 T1 — unified injection layer (services/execution/agentInjection.ts).
//
// Why this file exists: two same-symptom production incidents ("agent says the
// MCP does not exist" — one from the retired pre-RFC-276 launcher gate, one
// from an agent with no MCP reference) exposed that the MCP row → runtime wire
// transform existed as FOUR parallel implementations with no shared declared
// manifest. This suite locks the single implementation:
//   1. partition semantics (disabled split-out, same-id dedupe, and the
//      design-gate P1-1 ruling: different-id-same-name must THROW, never
//      silently substitute — mirrors the scheduler's exact-identity fence);
//   2. wire-shape parity with the playground's independent implementation
//      (prepareMcpTestExecutionMaterial) — the T6 cutover depends on this;
//   3. the driver renderInjection hook returning the same entries + manifest
//      that buildInlineConfig / toClaudeMcpConfig compose internally.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import {
  AgentInjectionError,
  declarePlugins,
  declareSkills,
  declareSubagents,
  deriveClaudeDroppedParams,
  partitionMcpsForInjection,
  renderClaudeMcpInjection,
  renderClaudeMcpServerEntry,
  renderOpencodeMcpEntry,
  renderOpencodeMcpInjection,
} from '@/services/execution/agentInjection'
import { buildInlineConfig } from '@/services/runtime/opencode/inlineConfig'
import { toClaudeMcpConfig } from '@/services/runtime/claudeCode/inject'
import { prepareMcpTestExecutionMaterial } from '@/services/runtime/mcpTestExecutionMaterial'
import { claudeCodeDriver } from '@/services/runtime/claudeCode/driver'
import { opencodeDriver } from '@/services/runtime/opencode/driver'
import type { Agent } from '@agent-workflow/shared'

function localMcp(name: string, extra: Partial<Mcp> = {}): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'local',
    config: { command: ['uvx', name + '-srv'] },
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as Mcp
}

function remoteMcp(name: string, extra: Partial<Mcp> = {}): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'remote',
    config: { url: 'https://example.test/' + name },
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as Mcp
}

function emptyAgent(name: string): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('partitionMcpsForInjection (RFC-280 T1)', () => {
  test('disabled rows go to skippedDisabledMcps, not the wire', () => {
    const out = partitionMcpsForInjection([
      localMcp('on'),
      localMcp('off', { enabled: false }),
      localMcp('off2', { enabled: false }),
    ])
    expect(out.injected.map((m) => m.name)).toEqual(['on'])
    expect(out.declared.mcpServers).toEqual(['on'])
    expect(out.declared.skippedDisabledMcps).toEqual(['off', 'off2'])
  })

  test('same canonical id referenced twice dedupes, first-seen order kept', () => {
    const a = localMcp('shared')
    const b = localMcp('shared') // same id ('mcp-shared') — closure union case
    const out = partitionMcpsForInjection([a, b, localMcp('tail')])
    expect(out.declared.mcpServers).toEqual(['shared', 'tail'])
  })

  test('DIFFERENT ids sharing one enabled runtime name throw (design-gate P1-1)', () => {
    const ownerA = localMcp('rag-search', { id: 'mcp-one-id' } as Partial<Mcp>)
    const ownerB = localMcp('rag-search', { id: 'mcp-two-id' } as Partial<Mcp>)
    expect(() => partitionMcpsForInjection([ownerA, ownerB])).toThrow(AgentInjectionError)
    try {
      partitionMcpsForInjection([ownerA, ownerB])
      throw new Error('unreachable')
    } catch (err) {
      expect((err as AgentInjectionError).code).toBe('agent-injection-duplicate-mcp-name')
    }
  })

  test('a disabled row never participates in the duplicate-name conflict', () => {
    const disabledTwin = localMcp('rag-search', {
      id: 'mcp-two-id',
      enabled: false,
    } as Partial<Mcp>)
    const enabled = localMcp('rag-search', { id: 'mcp-one-id' } as Partial<Mcp>)
    const out = partitionMcpsForInjection([disabledTwin, enabled])
    expect(out.declared.mcpServers).toEqual(['rag-search'])
    expect(out.declared.skippedDisabledMcps).toEqual(['rag-search'])
  })

  test('prototype-shaped names are handled as plain data', () => {
    const out = partitionMcpsForInjection([localMcp('constructor'), localMcp('__proto__')])
    expect(out.declared.mcpServers).toEqual(['constructor', '__proto__'])
    const rendered = renderOpencodeMcpInjection([localMcp('constructor')])
    expect(Object.hasOwn(rendered.entries ?? {}, 'constructor')).toBe(true)
  })

  test('all-disabled or empty input renders null entries with a faithful manifest', () => {
    expect(renderOpencodeMcpInjection([]).entries).toBeNull()
    const out = renderClaudeMcpInjection([localMcp('x', { enabled: false })])
    expect(out.entries).toBeNull()
    expect(out.declared.skippedDisabledMcps).toEqual(['x'])
  })
})

describe('wire-shape parity with the playground material (T6 cutover ground)', () => {
  const cases: Mcp[] = [
    localMcp('plain'),
    localMcp('env-timeout', {
      config: {
        command: ['bun', '/srv/mcp.ts', '--flag'],
        env: { API_KEY: 'k', MODE: 'x' },
        timeoutMs: 12_000,
      },
    } as Partial<Mcp>),
    remoteMcp('bare'),
    remoteMcp('full', {
      config: {
        url: 'https://svc.example.test/rpc',
        headers: { Authorization: 'Bearer t' },
        oauth: { clientId: 'cid' },
        timeoutMs: 9_000,
      },
    } as Partial<Mcp>),
  ]

  for (const mcp of cases) {
    test(`opencode + claude entries match prepareMcpTestExecutionMaterial for '${mcp.name}'`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc280-parity-'))
      const material = await prepareMcpTestExecutionMaterial({ mcp, root })
      expect(renderOpencodeMcpEntry(mcp)).toEqual({ ...material.opencodeEntry })
      expect(renderClaudeMcpServerEntry(mcp)).toEqual({ ...material.claudeEntry })
    })
  }

  test('credential-bearing URLs render verbatim (RFC-280 user ruling: allowed)', () => {
    // The playground material still REJECTS userinfo URLs today; that branch is
    // removed at T6 (design.md §7.4), after which this case joins the parity
    // matrix above. The unified layer never rejects them.
    const mcp = remoteMcp('userinfo', {
      config: { url: 'https://svc-user:svc-pass@mcp.example.test/rpc' },
    } as Partial<Mcp>)
    expect(renderOpencodeMcpEntry(mcp)).toEqual({
      type: 'remote',
      enabled: true,
      url: 'https://svc-user:svc-pass@mcp.example.test/rpc',
    })
    expect(renderClaudeMcpServerEntry(mcp)).toEqual({
      type: 'http',
      url: 'https://svc-user:svc-pass@mcp.example.test/rpc',
    })
  })
})

describe('driver renderInjection hook (RFC-280 T1)', () => {
  const mcps = [localMcp('a'), remoteMcp('b'), localMcp('off', { enabled: false })]

  test('opencode hook matches buildInlineConfig composition + manifest', () => {
    const hook = opencodeDriver.renderInjection({ mcps })
    const composed = buildInlineConfig(emptyAgent('root'), new Map(), [], mcps)
    expect(hook.mcpEntries).toEqual(composed.mcp ?? null)
    expect(hook.declared.mcpServers).toEqual(['a', 'b'])
    expect(hook.declared.skippedDisabledMcps).toEqual(['off'])
  })

  test('claude hook matches toClaudeMcpConfig composition + manifest', () => {
    const hook = claudeCodeDriver.renderInjection({ mcps })
    const composed = toClaudeMcpConfig(mcps)
    expect(hook.mcpEntries).toEqual(composed?.mcpServers ?? null)
    expect(hook.declared.mcpServers).toEqual(['a', 'b'])
  })

  test('claude hook: nothing enabled → null entries (flag omitted upstream)', () => {
    const hook = claudeCodeDriver.renderInjection({ mcps: [localMcp('x', { enabled: false })] })
    expect(hook.mcpEntries).toBeNull()
    expect(toClaudeMcpConfig([localMcp('x', { enabled: false })])).toBeNull()
  })
})

describe('declaration helpers (RFC-280 T2)', () => {
  test('declareSkills lists managed only — project skills are CLI-discovered', () => {
    expect(
      declareSkills([
        { name: 'm1', sourceKind: 'managed' },
        { name: 'p1', sourceKind: 'project' },
        { name: 'm2', sourceKind: 'managed' },
      ]),
    ).toEqual(['m1', 'm2'])
  })

  test('declareSubagents excludes the root and dedupes first-seen', () => {
    const deps = [emptyAgent('root'), emptyAgent('a'), emptyAgent('b'), emptyAgent('a')]
    expect(declareSubagents('root', deps)).toEqual(['a', 'b'])
  })

  test('declarePlugins drops disabled and dedupes', () => {
    const plugins = [
      { name: 'p1', enabled: true },
      { name: 'off', enabled: false },
      { name: 'p1', enabled: true },
    ] as never[]
    expect(declarePlugins(plugins)).toEqual(['p1'])
  })

  test('deriveClaudeDroppedParams names exactly the non-null non-model params', () => {
    expect(
      deriveClaudeDroppedParams({
        model: 'anthropic/claude-sonnet-5',
        variant: 'high',
        temperature: 0.2,
        steps: null,
        maxSteps: 50,
        isSandbox: false,
      }),
    ).toEqual(['variant', 'temperature', 'maxSteps'])
    expect(
      deriveClaudeDroppedParams({
        model: null,
        variant: null,
        temperature: null,
        steps: null,
        maxSteps: null,
        isSandbox: false,
      }),
    ).toEqual([])
  })

  test('opencode hook declares skills/subagents/plugins faces', () => {
    const hook = opencodeDriver.renderInjection({
      mcps: [localMcp('m')],
      agent: emptyAgent('root'),
      dependents: [emptyAgent('helper')],
      skills: [
        { name: 'sk', sourceKind: 'managed' },
        { name: 'proj', sourceKind: 'project' },
      ],
      plugins: [{ name: 'plg', enabled: true }] as never[],
    })
    expect(hook.declared.skills).toEqual(['sk'])
    expect(hook.declared.subagents).toEqual(['helper'])
    expect(hook.declared.plugins).toEqual(['plg'])
    expect(hook.declared.tools).toBeNull()
    expect(hook.declared.unsupported).toEqual([])
  })

  test('claude hook declares tools gate, droppedParams and plugin unsupported', () => {
    const gated = { ...emptyAgent('root'), permission: { read: 'allow', bash: 'deny' } } as Agent
    const hook = claudeCodeDriver.renderInjection({
      mcps: [],
      agent: gated,
      dependents: [emptyAgent('helper')],
      profile: {
        model: 'anthropic/claude-sonnet-5',
        variant: 'high',
        temperature: null,
        steps: null,
        maxSteps: null,
        isSandbox: false,
      },
      plugins: [{ name: 'plg', enabled: true }] as never[],
    })
    expect(hook.declared.tools).toEqual(['Read'])
    expect(hook.declared.droppedParams).toEqual(['variant'])
    expect(hook.declared.unsupported).toEqual(['plugin:plg'])
    expect(hook.declared.subagents).toEqual(['helper'])
    // Unconstrained agent → tools null (claude keeps its own defaults).
    const open = claudeCodeDriver.renderInjection({ mcps: [], agent: emptyAgent('free') })
    expect(open.declared.tools).toBeNull()
  })
})
