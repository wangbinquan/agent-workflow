import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import { prepareMcpTestExecutionMaterial } from '../src/services/runtime/mcpTestExecutionMaterial'

const tempDirs: string[] = []

function materialRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(value)
  return value
}

function remoteMcp(): Extract<Mcp, { type: 'remote' }> {
  return {
    id: 'mcp-remote',
    name: 'remote_fixture',
    description: '',
    type: 'remote',
    config: {
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret', 'X-Tenant': 'tenant-1' },
      oauth: { clientId: 'client-1', clientSecret: 'oauth-secret', scope: 'mcp.read' },
      timeoutMs: 5_000,
    },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function localMcp(command: string[] = ['fixture-mcp', '--stdio']): Extract<Mcp, { type: 'local' }> {
  return {
    id: 'mcp-local',
    name: 'local_fixture',
    description: '',
    type: 'local',
    config: {
      command,
      env: { FIXTURE_TOKEN: 'private-value', lowercase_key: 'forwarded' },
      timeoutMs: 4_000,
    },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 natural MCP execution material', () => {
  test('projects one remote MCP into ordinary OpenCode and Claude config', async () => {
    const material = await prepareMcpTestExecutionMaterial({
      mcp: remoteMcp(),
      root: materialRoot('rfc238-remote-material-'),
    })

    expect(material.opencodeEntry).toEqual({
      type: 'remote',
      enabled: true,
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret', 'X-Tenant': 'tenant-1' },
      oauth: { clientId: 'client-1', clientSecret: 'oauth-secret', scope: 'mcp.read' },
      timeout: 5_000,
    })
    expect(material.claudeEntry).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret', 'X-Tenant': 'tenant-1' },
    })
  })

  test('forwards the authored local command and environment without wrappers', async () => {
    const material = await prepareMcpTestExecutionMaterial({
      mcp: localMcp(),
      root: materialRoot('rfc238-local-material-'),
    })

    expect(material.opencodeEntry).toEqual({
      type: 'local',
      enabled: true,
      command: ['fixture-mcp', '--stdio'],
      environment: { FIXTURE_TOKEN: 'private-value', lowercase_key: 'forwarded' },
      timeout: 4_000,
    })
    expect(material.claudeEntry).toEqual({
      command: 'fixture-mcp',
      args: ['--stdio'],
      env: { FIXTURE_TOKEN: 'private-value', lowercase_key: 'forwarded' },
    })
  })

  test('rejects invalid names, URLs, and empty command parts', async () => {
    await expect(
      prepareMcpTestExecutionMaterial({
        mcp: { ...remoteMcp(), name: '../escape' },
        root: materialRoot('rfc238-invalid-name-'),
      }),
    ).rejects.toThrow('mcp-test-invalid-resource')
    await expect(
      prepareMcpTestExecutionMaterial({
        mcp: { ...remoteMcp(), config: { url: 'file:///tmp/server' } },
        root: materialRoot('rfc238-invalid-url-'),
      }),
    ).rejects.toThrow('mcp-test-invalid-remote-url')
    await expect(
      prepareMcpTestExecutionMaterial({
        mcp: localMcp(['fixture-mcp', '']),
        root: materialRoot('rfc238-invalid-command-'),
      }),
    ).rejects.toThrow('mcp-test-invalid-local-command')
  })
})
