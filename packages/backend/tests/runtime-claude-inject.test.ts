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

describe('toClaudeAgents (RFC-111 PR-C)', () => {
  it('maps dependents to { name: { description, prompt } }; empty → null', () => {
    expect(toClaudeAgents([])).toBeNull()
    const agents = toClaudeAgents([depAgent('reviewer', 'You review.', 'Reviews code')])
    expect(agents).toEqual({ reviewer: { description: 'Reviews code', prompt: 'You review.' } })
  })

  it('dedupes by name (first wins)', () => {
    const agents = toClaudeAgents([depAgent('a', 'first'), depAgent('a', 'second')])
    expect(Object.keys(agents!)).toEqual(['a'])
    expect(agents!.a?.prompt).toBe('first')
  })
})
