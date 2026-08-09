// RFC-111 PR-C — toClaudeMcpConfig / toClaudeAgents pure transforms from the
// platform's DB-shape MCP / dependsOn closure into claude's --mcp-config /
// --agents inline-JSON wire shapes.

import type { Agent, Mcp } from '@agent-workflow/shared'
import { describe, expect, it } from 'bun:test'
import { toClaudeAgents, toClaudeMcpConfig } from '@/services/runtime/claudeCode/inject'

function localMcp(name: string, command: string[], extra: Partial<Mcp> = {}): Mcp {
  return { name, type: 'local', enabled: true, config: { command }, ...extra } as Mcp
}

describe('toClaudeMcpConfig (RFC-111 PR-C)', () => {
  it('splits local command into command + args and keeps env', () => {
    const cfg = toClaudeMcpConfig([
      localMcp('fs', ['npx', '-y', 'server-fs'], {
        config: { command: ['npx', '-y', 'server-fs'], env: { K: 'v' } },
      } as Partial<Mcp>),
    ])
    expect(cfg).not.toBeNull()
    expect(cfg!.mcpServers.fs).toEqual({
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { K: 'v' },
    })
  })

  it('maps a remote MCP to { type:http, url, headers }', () => {
    const remote = {
      name: 'sentry',
      type: 'remote',
      enabled: true,
      config: { url: 'https://x.io/mcp', headers: { Authorization: 'Bearer t' } },
    } as unknown as Mcp
    const cfg = toClaudeMcpConfig([remote])
    expect(cfg!.mcpServers.sentry).toEqual({
      type: 'http',
      url: 'https://x.io/mcp',
      headers: { Authorization: 'Bearer t' },
    })
  })

  it('drops disabled + dedupes by name; empty → null', () => {
    expect(toClaudeMcpConfig([])).toBeNull()
    const disabled = { ...localMcp('a', ['cmd']), enabled: false } as Mcp
    expect(toClaudeMcpConfig([disabled])).toBeNull()
    const cfg = toClaudeMcpConfig([localMcp('a', ['x']), localMcp('a', ['y'])])
    expect(Object.keys(cfg!.mcpServers)).toEqual(['a'])
    expect((cfg!.mcpServers.a as { command: string }).command).toBe('x') // first wins
  })

  it('keeps a valid prototype-shaped MCP name as an own registry key', () => {
    const cfg = toClaudeMcpConfig([localMcp('constructor', ['mcp-bin'])])
    expect(Object.hasOwn(cfg?.mcpServers ?? {}, 'constructor')).toBe(true)
    const entry = Object.getOwnPropertyDescriptor(cfg?.mcpServers ?? {}, 'constructor')?.value as
      | Record<string, unknown>
      | undefined
    expect(entry?.command).toBe('mcp-bin')
  })
})

function depAgent(name: string, bodyMd: string, description = 'd'): Agent {
  return {
    id: name,
    name,
    description,
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

// 2026-08-09：返回形状从裸 registry 改为 `{agents, warnings}`——每个 dependent 现在
// 还携带自己的 model 与 permission 推出的 tools，而「父的装载集是硬上界」这条能力
// 损失必须能被调用方说出来。以下三条只随形状改判，断言的语义一字未变。
describe('toClaudeAgents (RFC-111 PR-C)', () => {
  it('maps dependents to { name: { description, prompt } }; empty → null', () => {
    expect(toClaudeAgents([])).toBeNull()
    const out = toClaudeAgents([depAgent('reviewer', 'You review.', 'Reviews code')])
    expect(out?.agents).toEqual({
      reviewer: { description: 'Reviews code', prompt: 'You review.' },
    })
    expect(out?.warnings).toEqual([])
  })

  it('dedupes by name (first wins)', () => {
    const out = toClaudeAgents([depAgent('a', 'first'), depAgent('a', 'second')])
    expect(Object.keys(out!.agents)).toEqual(['a'])
    expect(out!.agents.a?.prompt).toBe('first')
  })

  it('keeps a valid prototype-shaped dependent name as an own registry key', () => {
    const out = toClaudeAgents([depAgent('constructor', 'constructor prompt')])
    expect(Object.hasOwn(out?.agents ?? {}, 'constructor')).toBe(true)
    const entry = Object.getOwnPropertyDescriptor(out?.agents ?? {}, 'constructor')?.value as
      | { prompt: string }
      | undefined
    expect(entry?.prompt).toBe('constructor prompt')
  })
})
