// RFC-028 T1: shared MCP schema contract tests.
//
// These tests pin the *wire format* the API, UI and runner agree on. Notably:
//   - Local has NO `cwd` field. opencode `McpLocalConfig` does not accept cwd;
//     stdio child cwd is taken from the opencode process directory. If a
//     future edit adds `cwd` here, the regression below catches it. See
//     docs/OPENCODE_CONFIG.md §3.3.
//   - Local uses `env` / `timeoutMs` (the runner translates to opencode's
//     `environment` / `timeout` at inject time; that translation is locked by
//     runner tests in T7).
//   - Remote `url` must be http(s); `oauth` can be an object or literal false.
//   - Agent.mcp default `[]`; name regex matches McpNameSchema.

import { describe, expect, test } from 'bun:test'
import {
  CreateAgentSchema,
  CreateMcpSchema,
  McpLocalConfigSchema,
  McpNameSchema,
  McpRemoteConfigSchema,
  McpSchema,
  MCP_NAME_RE,
  RenameMcpSchema,
  UpdateMcpSchema,
} from '../src'

describe('McpNameSchema', () => {
  test('accepts lowercase alphanumerics with dashes / underscores', () => {
    for (const ok of ['a', 'postgres', 'postgres-prod', 'a_b_c', 'name-1', 'x0']) {
      expect(McpNameSchema.safeParse(ok).success).toBe(true)
    }
  })

  test('rejects leading dash / uppercase / spaces / path traversal', () => {
    for (const bad of ['-foo', '_bar', 'A', 'foo bar', 'foo/bar', '..', '', 'X'.repeat(129)]) {
      expect(McpNameSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('regex is exported and matches schema behavior', () => {
    expect(MCP_NAME_RE.test('postgres-prod')).toBe(true)
    expect(MCP_NAME_RE.test('Postgres')).toBe(false)
  })
})

describe('McpLocalConfigSchema', () => {
  test('happy path: command-only', () => {
    const r = McpLocalConfigSchema.safeParse({ command: ['uvx', 'postgres-mcp'] })
    expect(r.success).toBe(true)
  })

  test('happy path: command + env + timeoutMs', () => {
    const r = McpLocalConfigSchema.safeParse({
      command: ['bash', '-lc', 'echo hi'],
      env: { PG_URL: 'postgresql://localhost/x', TOKEN: 't' },
      timeoutMs: 30_000,
    })
    expect(r.success).toBe(true)
  })

  test('rejects empty command', () => {
    expect(McpLocalConfigSchema.safeParse({ command: [] }).success).toBe(false)
  })

  test('rejects non-string env values', () => {
    const r = McpLocalConfigSchema.safeParse({
      command: ['x'],
      env: { N: 1 as unknown as string },
    })
    expect(r.success).toBe(false)
  })

  test('REGRESSION: schema does NOT accept `cwd` (would be silently ignored by opencode)', () => {
    // This is the cwd-not-accepted regression guard called out in
    // RFC-028-T1 plan. opencode/packages/opencode/src/config/mcp.ts has no
    // cwd field; mcp/index.ts:417 takes cwd from InstanceState.directory.
    // Adding cwd here would mislead users into thinking they can pin a
    // working directory per server.
    const r = McpLocalConfigSchema.safeParse({ command: ['x'], cwd: '/tmp' })
    expect(r.success).toBe(false)
  })

  test('rejects negative or zero timeoutMs', () => {
    expect(McpLocalConfigSchema.safeParse({ command: ['x'], timeoutMs: 0 }).success).toBe(false)
    expect(McpLocalConfigSchema.safeParse({ command: ['x'], timeoutMs: -1 }).success).toBe(false)
  })
})

describe('McpRemoteConfigSchema', () => {
  test('happy path: url + headers', () => {
    const r = McpRemoteConfigSchema.safeParse({
      url: 'https://mcp.corp.internal/sse',
      headers: { Authorization: 'Bearer xxx' },
    })
    expect(r.success).toBe(true)
  })

  test('accepts oauth: false to disable OAuth auto-detection', () => {
    const r = McpRemoteConfigSchema.safeParse({
      url: 'https://api.example.com/mcp',
      oauth: false,
    })
    expect(r.success).toBe(true)
  })

  test('accepts oauth object with clientId / scope', () => {
    const r = McpRemoteConfigSchema.safeParse({
      url: 'https://api.example.com/mcp',
      oauth: { clientId: 'abc', scope: 'read' },
    })
    expect(r.success).toBe(true)
  })

  test('rejects non-http(s) url', () => {
    for (const bad of ['ftp://x', 'file:///tmp', 'mcp.local', '']) {
      expect(McpRemoteConfigSchema.safeParse({ url: bad }).success).toBe(false)
    }
  })
})

describe('CreateMcpSchema', () => {
  test('local with defaults: enabled=true, description=""', () => {
    const r = CreateMcpSchema.safeParse({
      name: 'postgres',
      type: 'local',
      config: { command: ['uvx', 'pg-mcp'] },
    })
    if (!r.success) throw r.error
    expect(r.data.enabled).toBe(true)
    expect(r.data.description).toBe('')
    expect(r.data.type).toBe('local')
  })

  test('remote with explicit enabled=false', () => {
    const r = CreateMcpSchema.safeParse({
      name: 'sentry',
      type: 'remote',
      config: { url: 'https://sentry.io/mcp' },
      enabled: false,
    })
    if (!r.success) throw r.error
    expect(r.data.enabled).toBe(false)
  })

  test('discriminator: type=local with remote config fields → fail', () => {
    const r = CreateMcpSchema.safeParse({
      name: 'x',
      type: 'local',
      config: { url: 'https://x.io' },
    })
    expect(r.success).toBe(false)
  })

  test('missing type → fail', () => {
    const r = CreateMcpSchema.safeParse({ name: 'x', config: { command: ['x'] } })
    expect(r.success).toBe(false)
  })
})

describe('UpdateMcpSchema', () => {
  test('partial: just description', () => {
    expect(UpdateMcpSchema.safeParse({ description: 'updated' }).success).toBe(true)
  })

  test('partial: just enabled', () => {
    expect(UpdateMcpSchema.safeParse({ enabled: false }).success).toBe(true)
  })

  test('config replacement: local', () => {
    expect(
      UpdateMcpSchema.safeParse({
        type: 'local',
        config: { command: ['x'] },
      }).success,
    ).toBe(true)
  })

  test('unknown extra key → fail (strict)', () => {
    expect(UpdateMcpSchema.safeParse({ randomKey: 1 }).success).toBe(false)
  })
})

describe('RenameMcpSchema', () => {
  test('happy path', () => {
    const r = RenameMcpSchema.safeParse({ newName: 'foo-bar' })
    if (!r.success) throw r.error
    expect(r.data.newName).toBe('foo-bar')
  })

  test('invalid name → fail', () => {
    expect(RenameMcpSchema.safeParse({ newName: 'Bar' }).success).toBe(false)
  })
})

describe('McpSchema round-trip', () => {
  test('local row shape', () => {
    const row = {
      id: '01HXX',
      name: 'postgres',
      description: 'prod db',
      type: 'local' as const,
      config: { command: ['uvx', 'pg-mcp'], env: { U: '1' } },
      enabled: true,
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    }
    const r = McpSchema.safeParse(row)
    if (!r.success) throw r.error
    expect(r.data.type).toBe('local')
  })

  test('remote row shape', () => {
    const row = {
      id: '01HYY',
      name: 'sentry',
      description: '',
      type: 'remote' as const,
      config: { url: 'https://sentry.io/mcp', oauth: false as const },
      enabled: false,
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    }
    const r = McpSchema.safeParse(row)
    if (!r.success) throw r.error
    expect(r.data.type).toBe('remote')
  })
})

describe('Agent.mcp field (RFC-028 wiring into AgentSchema)', () => {
  test('default `[]` when omitted', () => {
    const r = CreateAgentSchema.safeParse({ name: 'foo' })
    if (!r.success) throw r.error
    expect(r.data.mcp).toEqual([])
  })

  test('accepts valid mcp names', () => {
    const r = CreateAgentSchema.safeParse({ name: 'foo', mcp: ['postgres-prod', 'sentry'] })
    if (!r.success) throw r.error
    expect(r.data.mcp).toEqual(['postgres-prod', 'sentry'])
  })

  test('accepts id-or-name refs (RFC-223 PR-1: no name-format check on the ref)', () => {
    // The mcp field now stores id-or-name references, so an id-shaped value
    // (ULID, uppercase) is accepted — the old name-grammar check is gone.
    const r = CreateAgentSchema.safeParse({ name: 'foo', mcp: ['01HZY8QK9AXAMPLEID000000AB'] })
    expect(r.success).toBe(true)
  })

  test('rejects an empty-string ref', () => {
    const r = CreateAgentSchema.safeParse({ name: 'foo', mcp: [''] })
    expect(r.success).toBe(false)
  })

  test('max 64 entries', () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => `m${i}`)
    const r = CreateAgentSchema.safeParse({ name: 'foo', mcp: tooMany })
    expect(r.success).toBe(false)
  })
})
