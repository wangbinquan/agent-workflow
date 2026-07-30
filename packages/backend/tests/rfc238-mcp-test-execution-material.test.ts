import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Mcp } from '@agent-workflow/shared'
import { ContainmentCoordinator, type PreparedContainmentPlan } from '../src/services/sandbox'
import { prepareMcpTestExecutionMaterial } from '../src/services/runtime/mcpTestExecutionMaterial'

const tempDirs: string[] = []

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(value)
  return value
}

async function containment(appHome: string): Promise<PreparedContainmentPlan> {
  if (process.platform === 'linux') {
    return new ContainmentCoordinator({
      provider: {
        mode: 'enforce',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome,
      },
      qualifyBwrap: async () => '/usr/bin/bwrap',
    }).admit('opencode-verified-v1')
  }
  return new ContainmentCoordinator({
    provider: {
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome,
    },
    qualifySeatbelt: async () => {},
  }).admit('opencode-verified-v1')
}

function remoteMcp(secret: string, bearer: string): Extract<Mcp, { type: 'remote' }> {
  return {
    id: 'mcp-remote',
    name: 'remote_fixture',
    description: '',
    type: 'remote',
    config: {
      url: 'https://example.test/mcp',
      headers: { Authorization: `Bearer ${bearer}`, 'X-Tenant': 'tenant-1' },
      oauth: {
        clientId: 'client-1',
        clientSecret: secret,
        scope: 'mcp.read',
      },
      timeoutMs: 5_000,
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

describe('RFC-238 frozen MCP execution material', () => {
  test('remote identity digests credential slots without secret values', async () => {
    const base = root('rfc238-remote-material-')
    const appHome = join(base, 'app-home')
    const worktreePath = join(base, 'worktree')
    mkdirSync(worktreePath, { recursive: true, mode: 0o700 })
    const admitted = await containment(appHome)

    const first = await prepareMcpTestExecutionMaterial({
      mcp: remoteMcp('oauth-secret-one', 'header-secret-one'),
      root: join(base, 'material-one'),
      worktreePath,
      appHome,
      containment: admitted,
    })
    const second = await prepareMcpTestExecutionMaterial({
      mcp: remoteMcp('oauth-secret-two', 'header-secret-two'),
      root: join(base, 'material-two'),
      worktreePath,
      appHome,
      containment: admitted,
    })

    expect(first.executionDigest).toBe(second.executionDigest)
    expect(first.rawCommandDigest).toBe(second.rawCommandDigest)
    expect((first.opencodeEntry.headers as Record<string, string>).Authorization).toContain(
      'header-secret-one',
    )
    expect((first.opencodeEntry.oauth as Record<string, string>).clientSecret).toBe(
      'oauth-secret-one',
    )
    const durableIdentity = JSON.stringify({
      executionDigest: first.executionDigest,
      rawCommandDigest: first.rawCommandDigest,
    })
    expect(durableIdentity).not.toContain('oauth-secret-one')
    expect(durableIdentity).not.toContain('header-secret-one')
  })

  test('local material seals the executable and detects snapshot or wrapper tampering', async () => {
    const base = root('rfc238-local-material-')
    const appHome = join(base, 'app-home')
    const worktreePath = join(base, 'worktree')
    const executable = join(base, 'bin', 'fixture-mcp')
    mkdirSync(worktreePath, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(executable), { recursive: true, mode: 0o700 })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    chmodSync(executable, 0o500)
    const admitted = await containment(appHome)

    const materialRoot = join(base, 'material')
    const material = await prepareMcpTestExecutionMaterial({
      mcp: {
        id: 'mcp-local',
        name: 'local_fixture',
        description: '',
        type: 'local',
        config: {
          command: [executable, '--stdio'],
          env: { FIXTURE_TOKEN: 'private-value' },
        },
        enabled: true,
        schemaVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      root: materialRoot,
      worktreePath,
      appHome,
      containment: admitted,
    })

    expect(material.opencodeEntry.command).toEqual([join(materialRoot, 'mcp-wrapper', 'run')])
    expect(material.claudeEntry).toEqual({
      command: join(materialRoot, 'mcp-wrapper', 'run'),
      args: [],
    })
    expect(readFileSync(join(materialRoot, 'mcp-wrapper', 'netless.json'), 'utf8')).toContain(
      join(materialRoot, 'mcp-bin', 'server'),
    )
    await expect(material.preSpawnVerify()).resolves.toBeUndefined()

    const snapshot = join(materialRoot, 'mcp-bin', 'server')
    chmodSync(snapshot, 0o700)
    writeFileSync(snapshot, '#!/bin/sh\nexit 9\n')
    chmodSync(snapshot, 0o500)
    await expect(material.preSpawnVerify()).rejects.toMatchObject({
      code: 'execution-identity-untrusted-binary',
    })
  })

  test('local material resolves a stable PATH token and rejects silently-dropped env keys', async () => {
    const base = root('rfc238-local-path-material-')
    const appHome = join(base, 'app-home')
    const worktreePath = join(base, 'worktree')
    mkdirSync(worktreePath, { recursive: true, mode: 0o700 })
    const admitted = await containment(appHome)
    const local = (env: Record<string, string>): Extract<Mcp, { type: 'local' }> => ({
      id: 'mcp-local-path',
      name: 'local_path_fixture',
      description: '',
      type: 'local',
      config: { command: ['true'], env },
      enabled: true,
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    const material = await prepareMcpTestExecutionMaterial({
      mcp: local({ FIXTURE_TOKEN: 'private-value' }),
      root: join(base, 'material-ok'),
      worktreePath,
      appHome,
      containment: admitted,
    })
    expect(material.rawCommandDigest).toMatch(/^[0-9a-f]{64}$/)
    await expect(material.preSpawnVerify()).resolves.toBeUndefined()

    await expect(
      prepareMcpTestExecutionMaterial({
        mcp: local({ lowercase_key: 'must-not-be-silently-dropped' }),
        root: join(base, 'material-rejected'),
        worktreePath,
        appHome,
        containment: admitted,
      }),
    ).rejects.toMatchObject({ code: 'execution-identity-mismatch' })
  })
})
