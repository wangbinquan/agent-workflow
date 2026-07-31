import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import { ContainmentCoordinator, type PreparedContainmentPlan } from '../src/services/sandbox'
import { buildClaudeMcpTestSpawn } from '../src/services/runtime/claudeCode/mcpTest'
import { removeHermeticOpencodeLayout } from '../src/services/runtime/opencode/hermetic'
import { buildVerifiedOpencodeMcpTestPlan } from '../src/services/runtime/opencode/verifiedMcpTestPlan'
import { opencodeMcpTestSessionStore } from '../src/services/runtime/opencode/verifiedMcpTestPlan'
import { VerifiedLaunchManifestSchema } from '../src/services/runtime/opencode/verifiedManifest'
import type {
  McpTestExecutionMaterial,
  McpTestSpawnContext,
  McpTestSpawnPlan,
} from '../src/services/runtime/types'

const tempDirs: string[] = []
const opencodeStores = new Set<string>()
const OPEN_CODE_DIGEST = 'f'.repeat(64)
const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(value)
  return value
}

function material(materialRoot: string): McpTestExecutionMaterial {
  mkdirSync(materialRoot, { recursive: true, mode: 0o700 })
  return {
    codec: 'mcp-test-execution-material-v1',
    mcpId: 'mcp-1',
    runtimeKey: 'fixture',
    type: 'local',
    opencodeEntry: {
      type: 'local',
      enabled: true,
      command: ['/sealed/fixture-mcp', '--stdio'],
    },
    claudeEntry: {
      command: '/sealed/fixture-mcp',
      args: ['--stdio'],
      env: { FIXTURE_SECRET: 'not-on-argv' },
    },
    executionDigest: '1'.repeat(64),
    rawCommandDigest: '2'.repeat(64),
    root: materialRoot,
    preSpawnVerify: async () => {},
  }
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
    }).admit('model-child-netless-v1')
  }
  return new ContainmentCoordinator({
    provider: {
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome,
    },
    qualifySeatbelt: async () => {},
  }).admit('model-child-netless-v1')
}

async function opencodeContext(input: {
  base: string
  turnId: string
  containment: PreparedContainmentPlan
  resume?: {
    sessionId: string
    projectId: string
    first: McpTestSpawnPlan
  }
}): Promise<McpTestSpawnContext> {
  const appHome = join(input.base, 'app-home')
  const worktreePath = join(input.base, 'worktree')
  const runDir = join(input.base, `run-${input.turnId}`)
  const sessionId = 'test-session'
  mkdirSync(worktreePath, { recursive: true, mode: 0o700 })
  const opencodeControl: NonNullable<McpTestSpawnContext['opencodeControl']> =
    input.resume === undefined
      ? {
          kind: 'new',
          nonce: 'N'.repeat(32),
          leaseNonceDigest: 'a'.repeat(64),
          createdTurnId: input.turnId,
        }
      : (() => {
          const firstControl = input.resume.first.control
          if (firstControl?.kind !== 'opencode-mcp-test') {
            throw new Error('expected first-turn OpenCode control receipt')
          }
          return {
            kind: 'resume' as const,
            nonce: 'R'.repeat(32),
            leaseNonceDigest: 'b'.repeat(64),
            createdTurnId: firstControl.createdTurnId,
            expectedSessionId: input.resume.sessionId,
            expectedProjectId: input.resume.projectId,
            expectedIdentityDigest: firstControl.identityDigest,
            expectedRuntimeBinaryDigest: firstControl.runtimeBinaryDigest,
            expectedSessionContractDigest: firstControl.sessionContractDigest,
            expectedSessionStoreKey: firstControl.sessionStoreKey,
            expectedProtocolCodec: firstControl.protocolCodec,
          }
        })()
  const sessionStoreRoot = opencodeMcpTestSessionStore({ appHome, sessionId }).root
  opencodeStores.add(sessionStoreRoot)
  return {
    sessionId,
    turnId: input.turnId,
    agentName: 'aw-mcp-runtime-test',
    systemPrompt: 'Use only the mounted MCP.',
    prompt: 'List the available capabilities.',
    executionMaterial: material(join(runDir, 'material')),
    model: 'openai/gpt-5',
    variant: 'high',
    temperature: 0.25,
    maxSteps: 12,
    worktreePath,
    sessionRoot: join(input.base, 'session-root'),
    sessionStoreRoot,
    runDir,
    appHome,
    configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
    runtimeBinary: '/official/opencode',
    bridgeCredentials: false,
    containment: input.containment,
    opencodeControl,
    log,
  }
}

const OPENCODE_DEPENDENCIES = {
  random: (size: number) => Buffer.alloc(size, 7),
  sourceEnv: { OPENAI_API_KEY: 'test-only-key' },
  inspectBinary: async () => ({
    resolvedPath: '/runtime/opencode',
    digest: OPEN_CODE_DIGEST,
  }),
  snapshotBinary: async ({ snapshotPath }: { snapshotPath: string }) => {
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    writeFileSync(snapshotPath, 'sealed OpenCode test fixture', {
      flag: 'wx',
      mode: 0o500,
    })
    chmodSync(snapshotPath, 0o500)
    return {
      resolvedPath: '/runtime/opencode',
      snapshotPath,
      digest: OPEN_CODE_DIGEST,
    }
  },
}

function flagValue(cmd: readonly string[], flag: string): string | undefined {
  const index = cmd.indexOf(flag)
  return index < 0 ? undefined : cmd[index + 1]
}

afterEach(async () => {
  await Promise.all(
    [...opencodeStores].map((storeRoot) => removeHermeticOpencodeLayout(storeRoot).catch(() => {})),
  )
  opencodeStores.clear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 runtime MCP-only spawn plans', () => {
  test('OpenCode uses a verified one-MCP manifest and resumes the exact owner identity', async () => {
    const base = root('rfc238-opencode-')
    const appHome = join(base, 'app-home')
    const admitted = await containment(appHome)
    const firstContext = await opencodeContext({
      base,
      turnId: 'turn-1',
      containment: admitted,
    })
    const first = await buildVerifiedOpencodeMcpTestPlan(
      firstContext,
      ['/official/opencode'],
      OPENCODE_DEPENDENCIES,
    )
    expect(first.control?.kind).toBe('opencode-mcp-test')
    expect(first.sessionStore).toMatchObject({
      root: firstContext.sessionStoreRoot,
      persistent: true,
    })
    expect(first.env).toEqual({})
    expect(first.cmd).toContain('__opencode-verified-run')

    const manifestPath = flagValue(first.cmd, '--manifest')
    const manifest = VerifiedLaunchManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath!, 'utf8')),
    )
    expect(manifest).toMatchObject({
      storeKind: 'mcp-test',
      mode: 'new',
      testSessionId: firstContext.sessionId,
      turnId: 'turn-1',
      selectedAgent: 'aw-mcp-runtime-test',
      selectedModel: { providerID: 'openai', modelID: 'gpt-5', variant: 'high' },
      binaryDigest: OPEN_CODE_DIGEST,
      mcpExecutionDigest: firstContext.executionMaterial.executionDigest,
    })
    const config = manifest.expectedConfig as Record<string, unknown>
    expect(config.plugin).toEqual([])
    expect(Object.keys(config.mcp as Record<string, unknown>)).toEqual(['fixture'])
    expect(config.shell).toBe('/bin/false')
    const agent = (config.agent as Record<string, Record<string, unknown>>)['aw-mcp-runtime-test']!
    expect(agent).toMatchObject({
      model: 'openai/gpt-5',
      variant: 'high',
      temperature: 0.25,
      steps: 12,
    })
    expect(agent.permission).toMatchObject({
      '*': 'deny',
      'fixture_*': 'allow',
      bash: 'deny',
      read: 'deny',
      edit: 'deny',
      write: 'deny',
    })

    const resumedContext = await opencodeContext({
      base,
      turnId: 'turn-2',
      containment: admitted,
      resume: {
        sessionId: 'native-opencode-session',
        projectId: 'project-1',
        first,
      },
    })
    const resumed = await buildVerifiedOpencodeMcpTestPlan(
      {
        ...resumedContext,
        resumeSessionId: 'native-opencode-session',
      },
      ['/official/opencode'],
      OPENCODE_DEPENDENCIES,
    )
    const resumeManifestPath = flagValue(resumed.cmd, '--manifest')
    const resumeManifest = VerifiedLaunchManifestSchema.parse(
      JSON.parse(readFileSync(resumeManifestPath!, 'utf8')),
    )
    expect(resumeManifest).toMatchObject({
      storeKind: 'mcp-test',
      mode: 'resume',
      expectedSessionId: 'native-opencode-session',
      expectedProjectId: 'project-1',
      sessionStoreKey:
        first.control?.kind === 'opencode-mcp-test' ? first.control.sessionStoreKey : undefined,
    })
    expect(resumed.diagnostics?.nativeSessionMode).toBe('resume')

    await resumed.cleanup?.()
    await first.cleanup?.()
    expect(existsSync(resumedContext.runDir)).toBe(false)
    expect(existsSync(firstContext.runDir)).toBe(false)
    expect(existsSync(firstContext.sessionStoreRoot)).toBe(true)
  })

  test('Claude keeps MCP secrets out of argv and separates first session from resume', async () => {
    const base = root('rfc238-claude-')
    const runtimeBinary = join(base, 'bin', 'claude')
    mkdirSync(dirname(runtimeBinary), { recursive: true, mode: 0o700 })
    writeFileSync(runtimeBinary, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    chmodSync(runtimeBinary, 0o500)

    const makeContext = (
      turnId: string,
      extra: Partial<McpTestSpawnContext>,
    ): McpTestSpawnContext => {
      const runDir = join(base, `run-${turnId}`)
      const sessionRoot = join(base, 'session-root')
      mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
      return {
        sessionId: 'test-session',
        turnId,
        agentName: 'aw-mcp-runtime-test',
        systemPrompt: 'Use only the mounted MCP.',
        prompt: 'List the available capabilities.',
        executionMaterial: material(join(runDir, 'material')),
        worktreePath: base,
        sessionRoot,
        sessionStoreRoot: join(sessionRoot, 'store'),
        runDir,
        appHome: base,
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
        runtimeBinary,
        bridgeCredentials: false,
        log,
        ...extra,
      }
    }

    const firstContext = makeContext('turn-1', {
      nativeSessionId: 'native-claude-session',
    })
    const first = await buildClaudeMcpTestSpawn(firstContext)
    const mcpConfigPath = flagValue(first.cmd, '--mcp-config')
    expect(mcpConfigPath).toBe(join(firstContext.executionMaterial.root, 'claude-mcp-config.json'))
    expect(first.cmd.join(' ')).not.toContain('not-on-argv')
    expect(statSync(mcpConfigPath!).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(mcpConfigPath!, 'utf8'))).toEqual({
      mcpServers: {
        fixture: {
          command: '/sealed/fixture-mcp',
          args: ['--stdio'],
          env: { FIXTURE_SECRET: 'not-on-argv' },
        },
      },
    })
    expect(flagValue(first.cmd, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(first.cmd, '--tools')).toBe('')
    expect(flagValue(first.cmd, '--setting-sources')).toBe('')
    expect(flagValue(first.cmd, '--allowedTools')).toBe('mcp__fixture__*')
    expect(flagValue(first.cmd, '--session-id')).toBe('native-claude-session')
    expect(first.cmd).not.toContain('--resume')
    expect(first.env.CLAUDE_CONFIG_DIR).toBe(firstContext.sessionStoreRoot)
    expect(existsSync(firstContext.sessionStoreRoot)).toBe(true)
    await expect(first.preSpawnVerify?.()).resolves.toBeUndefined()

    const resumed = await buildClaudeMcpTestSpawn(
      makeContext('turn-2', {
        resumeSessionId: 'native-claude-session',
      }),
    )
    expect(flagValue(resumed.cmd, '--resume')).toBe('native-claude-session')
    expect(resumed.cmd).not.toContain('--session-id')
    expect(resumed.diagnostics?.nativeSessionMode).toBe('resume')

    await expect(
      buildClaudeMcpTestSpawn(
        makeContext('turn-3', {
          nativeSessionId: 'new-id',
          resumeSessionId: 'old-id',
        }),
      ),
    ).rejects.toThrow('mcp-test-native-session-conflict')

    await resumed.cleanup?.()
    await first.cleanup?.()
  })
})
