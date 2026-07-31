import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent, type Mcp } from '@agent-workflow/shared'
import { ContainmentCoordinator, type PreparedContainmentPlan } from '@/services/sandbox'
import { createLogger } from '@/util/log'
import type { BusinessNodeSpawnContext } from '@/services/runtime/types'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import {
  buildControlledOpencodeConfig,
  deriveHermeticOpencodeLayout,
  removeHermeticOpencodeLayout,
} from '@/services/runtime/opencode/hermetic'
import {
  businessOpencodeIdentityDigest,
  identityDigest,
} from '@/services/runtime/opencode/executionIdentity'
import {
  OPENCODE_DIRECT_PROTOCOL_CODEC,
  ROOT_SESSION_PERMISSION_RULES,
  type SelectedModel,
} from '@/services/runtime/opencode/directApiSchemas'
import {
  buildVerifiedOpencodeBusinessPlan,
  type VerifiedBusinessPlanDependencies,
} from '@/services/runtime/opencode/verifiedPlan'
import { AW_INTERNAL_GIT_IDENTITY, runGit } from '@/util/git'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalAuth = process.env.OPENCODE_AUTH_CONTENT
const TEST_BINARY_DIGEST = 'f'.repeat(64)
let activeContainment: PreparedContainmentPlan | undefined

afterEach(async () => {
  activeContainment = undefined
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuth
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function agent(): Agent {
  return {
    id: 'agent-worker',
    name: 'worker',
    description: 'verified worker',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'frozen persona',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function agentWithBash(bash: 'allow' | 'deny'): Agent {
  return { ...agent(), permission: { bash } }
}

function localMcp(input: {
  executable: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
}): Mcp {
  return {
    id: 'mcp-tools',
    name: 'tools',
    description: 'local test tools',
    type: 'local',
    config: {
      command: [input.executable, ...(input.args ?? ['--mode', 'safe'])],
      env: input.env ?? { TOOL_MODE: 'safe' },
      timeoutMs: input.timeoutMs ?? 4_000,
    },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function verifiedContext(input: {
  appHome: string
  worktreePath: string
  runRoot: string
  nodeRunId: string
  bash: 'allow' | 'deny'
  mcp?: Mcp
  nonceChar: string
  owner?: NonNullable<BusinessNodeSpawnContext['opencodeResumeOwner']>
  repoWorktreePaths?: readonly string[]
}): BusinessNodeSpawnContext {
  return {
    agent: agentWithBash(input.bash),
    prompt: 'do stable work',
    injectedMemoryBlock: null,
    dependents: [],
    mcps: input.mcp === undefined ? [] : [input.mcp],
    plugins: [],
    resolvedParamsByAgent: new Map([
      [
        'worker',
        {
          model: 'openai/gpt-5.6',
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        },
      ],
    ]),
    skills: [],
    ...(input.owner === undefined
      ? {}
      : {
          resumeSessionId: input.owner.sessionId,
          opencodeResumeOwner: input.owner,
        }),
    worktreePath: input.worktreePath,
    ...(input.repoWorktreePaths === undefined
      ? {}
      : { repoWorktreePaths: input.repoWorktreePaths }),
    runRoot: input.runRoot,
    configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
    wantsInventory: false,
    nodeRunId: input.nodeRunId,
    log: createLogger('rfc224-verified-plan-resume-test'),
    appHome: input.appHome,
    taskId: 'task-1',
    nodeId: 'node-1',
    opencodeControlNonce: input.nonceChar.repeat(32),
    opencodeLeaseNonceDigest: input.nonceChar.toLowerCase().repeat(64),
    ...(activeContainment === undefined ? {} : { containment: activeContainment }),
  }
}

const PLAN_DEPENDENCIES: VerifiedBusinessPlanDependencies = {
  inspectBinary: async () => ({
    resolvedPath: '/runtime/opencode',
    digest: TEST_BINARY_DIGEST,
  }),
  snapshotBinary: async ({ snapshotPath }) => {
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, 'official test seam', { flag: 'wx', mode: 0o500 })
    await chmod(snapshotPath, 0o500)
    return {
      resolvedPath: '/runtime/opencode',
      snapshotPath,
      digest: TEST_BINARY_DIGEST,
    }
  },
  // Unit tests freeze a tiny seam instead of copying/hashing the host's 60+
  // MiB Bun binary. The dedicated toolchain case below asserts source-path
  // exclusion and the exact model-facing PATH.
  resolveToolchainBinary: (token) => (token === 'bun' ? '/runtime/bun' : null),
  snapshotToolchainBinary: async ({ snapshotPath }) => {
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, 'bun test seam', { flag: 'wx', mode: 0o500 })
    await chmod(snapshotPath, 0o500)
    return {
      resolvedPath: '/runtime/bun',
      snapshotPath,
      digest: 'e'.repeat(64),
    }
  },
}

async function activateVerifiedLinux(appHome: string): Promise<void> {
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: 'linux',
  })
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: 'api', key: 'test-only-key' },
  })
  activeContainment = await new ContainmentCoordinator({
    provider: {
      mode: 'enforce',
      status: { mechanism: 'bwrap', available: true, detail: null },
      appHome,
    },
    qualifyBwrap: async () => '/usr/bin/bwrap',
  }).admit('model-child-netless-v1')
}

async function activateVerifiedMac(
  appHome: string,
  profile: 'runner-filesystem-v1' | 'model-child-netless-v1' = 'model-child-netless-v1',
): Promise<void> {
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: 'darwin',
  })
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: 'api', key: 'test-only-key' },
  })
  activeContainment = await new ContainmentCoordinator({
    provider: {
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome,
    },
    qualifySeatbelt: async () => {},
  }).admit(profile)
}

function ownerFromPlan(
  plan: Awaited<ReturnType<typeof buildVerifiedOpencodeBusinessPlan>>,
): NonNullable<BusinessNodeSpawnContext['opencodeResumeOwner']> {
  if (plan.control?.kind !== 'opencode-session') throw new Error('expected OpenCode control')
  return {
    sessionId: 'session-resume',
    taskId: 'task-1',
    nodeId: 'node-1',
    createdNodeRunId: plan.control.createdNodeRunId,
    identityDigest: plan.control.identityDigest,
    runtimeBinaryDigest: plan.control.runtimeBinaryDigest,
    sessionContractDigest: plan.control.sessionContractDigest,
    sessionStoreKey: plan.control.sessionStoreKey,
    projectId: 'project-1',
    protocolCodec: plan.control.protocolCodec,
    reportedVersion: 'custom-version-telemetry',
  }
}

describe('RFC-224 verified business-plan owner barrier', () => {
  test('projects only a linked worktree Git common dir into shell and local MCP children', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc227-linked-git-projection-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const scratchRepo = join(appHome, 'scratch', 'task-1')
    const worktreePath = join(appHome, 'iso', 'task-1', 'run-linked')
    const runRoot = join(appHome, 'runs', 'task-1', 'run-linked')
    const executable = join(root, 'tools', 'server')
    await mkdir(scratchRepo, { recursive: true })
    await mkdir(dirname(worktreePath), { recursive: true })
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    await chmod(executable, 0o500)
    expect((await runGit(scratchRepo, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
    await writeFile(join(scratchRepo, 'README.md'), 'scratch fixture\n')
    expect((await runGit(scratchRepo, ['add', 'README.md'])).exitCode).toBe(0)
    expect(
      (
        await runGit(scratchRepo, ['commit', '-q', '-m', 'fixture'], {
          env: AW_INTERNAL_GIT_IDENTITY,
        })
      ).exitCode,
    ).toBe(0)
    expect(
      (await runGit(scratchRepo, ['worktree', 'add', '-q', '--detach', worktreePath, 'HEAD']))
        .exitCode,
    ).toBe(0)
    const commonDir = await realpath(join(scratchRepo, '.git'))
    await activateVerifiedMac(appHome)

    const plan = await buildVerifiedOpencodeBusinessPlan(
      verifiedContext({
        appHome,
        worktreePath,
        repoWorktreePaths: [worktreePath],
        runRoot,
        nodeRunId: 'run-linked',
        bash: 'allow',
        mcp: localMcp({ executable }),
        nonceChar: 'c',
      }),
      ['opencode'],
      PLAN_DEPENDENCIES,
    )

    try {
      const sealRoot = join(runRoot, 'opencode-identity-seal')
      const toolchainPath = join(sealRoot, 'toolchain', 'bun')
      const shellManifest = JSON.parse(
        await readFile(join(sealRoot, 'shell', 'netless.json'), 'utf8'),
      ) as { gitCommonDirs: string[]; bindReadOnly: string[]; env: Record<string, string> }
      const [mcpIdentity] = await readdir(join(sealRoot, 'mcp'))
      const mcpManifest = JSON.parse(
        await readFile(join(sealRoot, 'mcp', mcpIdentity!, 'netless.json'), 'utf8'),
      ) as { gitCommonDirs: string[]; bindReadOnly: string[]; env: Record<string, string> }

      expect(shellManifest.gitCommonDirs).toEqual([commonDir])
      expect(mcpManifest.gitCommonDirs).toEqual([commonDir])
      expect(shellManifest.gitCommonDirs).not.toContain(scratchRepo)
      expect(shellManifest.bindReadOnly).toContain(toolchainPath)
      expect(mcpManifest.bindReadOnly).toContain(toolchainPath)
      expect(shellManifest.env.PATH).toBe(`${dirname(toolchainPath)}:/usr/bin:/bin`)
      expect(mcpManifest.env.PATH).toBe(`${dirname(toolchainPath)}:/usr/bin:/bin`)
      expect(plan.sandboxTopology).toBe('provider-child-only')
    } finally {
      await plan.cleanup?.()
      await removeHermeticOpencodeLayout(plan.sessionStore!.root)
    }
  })

  test('rejects a writable .git pointer redirected to an unrelated valid repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc227-linked-git-redirection-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const worktreePath = join(root, 'redirected-worktree')
    const unrelatedRepo = join(root, 'unrelated-repo')
    await mkdir(worktreePath, { recursive: true })
    await mkdir(unrelatedRepo, { recursive: true })
    expect((await runGit(unrelatedRepo, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
    await writeFile(join(worktreePath, '.git'), `gitdir: ${join(unrelatedRepo, '.git')}\n`)
    await activateVerifiedMac(appHome)

    await expect(
      buildVerifiedOpencodeBusinessPlan(
        verifiedContext({
          appHome,
          worktreePath,
          repoWorktreePaths: [worktreePath],
          runRoot: join(appHome, 'runs', 'task-1', 'run-redirected'),
          nodeRunId: 'run-redirected',
          bash: 'allow',
          nonceChar: 'd',
        }),
        ['opencode'],
        PLAN_DEPENDENCIES,
      ),
    ).rejects.toMatchObject({
      code: 'execution-identity-store-unsafe',
    })
  })

  test('macOS uses one child Seatbelt layer so Bash never nests sandbox-exec', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc227-seatbelt-topology-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const worktreePath = join(root, 'worktree')
    const executable = join(root, 'tools', 'server')
    await mkdir(worktreePath, { recursive: true })
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    await chmod(executable, 0o500)
    await activateVerifiedMac(appHome)

    const plan = await buildVerifiedOpencodeBusinessPlan(
      verifiedContext({
        appHome,
        worktreePath,
        runRoot: join(appHome, 'runs', 'task-1', 'run-mac'),
        nodeRunId: 'run-mac',
        bash: 'allow',
        mcp: localMcp({ executable }),
        nonceChar: 'a',
      }),
      ['opencode'],
      PLAN_DEPENDENCIES,
    )

    try {
      expect(plan.sandboxTopology).toBe('provider-child-only')
      expect(plan.diagnostics).toMatchObject({
        containmentProviderId: 'macos-seatbelt',
        runnerSandboxed: false,
      })
    } finally {
      await plan.cleanup?.()
      await removeHermeticOpencodeLayout(plan.sessionStore!.root)
    }
  })

  test('freezes Bun into the model-facing shell PATH without exposing its source directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc227-bun-toolchain-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const worktreePath = join(root, 'worktree')
    const runRoot = join(appHome, 'runs', 'task-1', 'run-bun')
    await mkdir(worktreePath, { recursive: true })
    await activateVerifiedMac(appHome)

    const plan = await buildVerifiedOpencodeBusinessPlan(
      verifiedContext({
        appHome,
        worktreePath,
        runRoot,
        nodeRunId: 'run-bun',
        bash: 'allow',
        nonceChar: 'c',
      }),
      ['opencode'],
      {
        ...PLAN_DEPENDENCIES,
        resolveToolchainBinary: (token) => (token === 'bun' ? '/mutable/home/bin/bun' : null),
        snapshotToolchainBinary: async ({ command, snapshotPath }) => {
          expect(command).toEqual(['/mutable/home/bin/bun'])
          await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
          await writeFile(snapshotPath, 'frozen bun test seam', { flag: 'wx', mode: 0o500 })
          await chmod(snapshotPath, 0o500)
          return {
            resolvedPath: '/mutable/home/bin/bun',
            snapshotPath,
            digest: 'b'.repeat(64),
          }
        },
      },
    )

    try {
      const snapshotPath = join(runRoot, 'opencode-identity-seal', 'toolchain', 'bun')
      const shellManifest = JSON.parse(
        await readFile(join(runRoot, 'opencode-identity-seal', 'shell', 'netless.json'), 'utf8'),
      ) as { bindReadOnly: string[]; env: Record<string, string> }
      expect(shellManifest.bindReadOnly).toContain(snapshotPath)
      expect(shellManifest.bindReadOnly).not.toContain('/mutable/home/bin/bun')
      expect(shellManifest.env.PATH).toBe(`${dirname(snapshotPath)}:/usr/bin:/bin`)
      expect((await lstat(snapshotPath)).mode & 0o777).toBe(0o500)
    } finally {
      await plan.cleanup?.()
      await removeHermeticOpencodeLayout(plan.sessionStore!.root)
    }
  })

  test('macOS keeps the runner Seatbelt when no model-controlled child can spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc227-seatbelt-outer-topology-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const worktreePath = join(root, 'worktree')
    await mkdir(worktreePath, { recursive: true })
    await activateVerifiedMac(appHome, 'runner-filesystem-v1')

    const plan = await buildVerifiedOpencodeBusinessPlan(
      verifiedContext({
        appHome,
        worktreePath,
        runRoot: join(appHome, 'runs', 'task-1', 'run-mac-no-child'),
        nodeRunId: 'run-mac-no-child',
        bash: 'deny',
        nonceChar: 'b',
      }),
      ['opencode'],
      PLAN_DEPENDENCIES,
    )

    try {
      expect(plan.sandboxTopology).toBe('runner-outer')
      expect(plan.diagnostics).toMatchObject({
        containmentProviderId: 'macos-seatbelt',
        runnerSandboxed: true,
      })
    } finally {
      await plan.cleanup?.()
      await removeHermeticOpencodeLayout(plan.sessionStore!.root)
    }
  })

  test('existing-owner identity drift fails before touching its store or run layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc224-verified-plan-'))
    roots.push(root)
    const worktreePath = join(root, 'worktree')
    const appHome = join(root, 'app')
    const runRoot = join(appHome, 'runs', 'task-1', 'run-resume')
    const storeKey = 'business_store_0123456789'
    const storeRoot = join(appHome, 'opencode-stores', 'business', storeKey)
    await mkdir(worktreePath)
    await mkdir(runRoot, { recursive: true })
    await chmod(runRoot, 0o711)
    await mkdir(storeRoot, { recursive: true })
    await writeFile(join(storeRoot, 'sentinel'), 'existing session bytes\n')
    const canonicalWorktree = await realpath(worktreePath)
    const storeEntriesBefore = await readdir(storeRoot)
    const runModeBefore = (await lstat(runRoot)).mode & 0o777

    await activateVerifiedLinux(appHome)

    const selectedModel: SelectedModel = {
      providerID: 'openai',
      modelID: 'gpt-5.6',
    }
    const layout = deriveHermeticOpencodeLayout(storeRoot)
    const controlledConfig = buildControlledOpencodeConfig({
      name: 'worker',
      prompt: 'frozen persona',
      description: 'verified worker',
      model: 'openai/gpt-5.6',
      temperature: null,
      steps: null,
      options: { outputs: [] },
      userPermission: {},
      toolOutputPattern: join(layout.xdgData, 'opencode', 'tool-output', '*'),
      shellPath: join(runRoot, 'opencode-identity-seal', 'shell', 'sh'),
      allowShell: true,
      mcp: {},
    })
    const createdNodeRunId = 'run-created'
    const title = `agent-workflow:rfc224:${createdNodeRunId}`
    const sessionContractDigest = identityDigest({
      directory: canonicalWorktree,
      path: '',
      title,
      agent: 'worker',
      model: selectedModel,
      permission: ROOT_SESSION_PERMISSION_RULES,
      parentID: null,
      workspaceID: null,
      share: null,
      revert: null,
      metadata: null,
    })
    const expectedIdentityDigest = businessOpencodeIdentityDigest({
      config: controlledConfig,
      agent: 'worker',
      model: selectedModel,
      binaryDigest: TEST_BINARY_DIGEST,
      sealRoot: join(runRoot, 'opencode-identity-seal'),
    })
    const ctx: BusinessNodeSpawnContext = {
      agent: agent(),
      prompt: 'do work',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map([
        [
          'worker',
          {
            model: 'openai/gpt-5.6',
            variant: null,
            temperature: null,
            steps: null,
            maxSteps: null,
          },
        ],
      ]),
      skills: [],
      resumeSessionId: 'session-1',
      worktreePath,
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
      wantsInventory: false,
      nodeRunId: 'run-resume',
      log: createLogger('rfc224-verified-plan-test'),
      appHome,
      taskId: 'task-1',
      nodeId: 'node-1',
      opencodeControlNonce: 'n'.repeat(32),
      opencodeLeaseNonceDigest: 'a'.repeat(64),
      containment: activeContainment!,
      opencodeResumeOwner: {
        sessionId: 'session-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        createdNodeRunId,
        // The only immutable drift: all other reconstructed owner fields match.
        identityDigest:
          expectedIdentityDigest.slice(0, -1) + (expectedIdentityDigest.endsWith('0') ? '1' : '0'),
        runtimeBinaryDigest: TEST_BINARY_DIGEST,
        sessionContractDigest,
        sessionStoreKey: storeKey,
        projectId: 'project-1',
        protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
        reportedVersion: '0.9.0-custom',
      },
    }

    try {
      await buildVerifiedOpencodeBusinessPlan(ctx, ['opencode'], PLAN_DEPENDENCIES)
      throw new Error('expected owner mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionIdentityFailure)
      expect((error as ExecutionIdentityFailure).code).toBe('execution-identity-session-mismatch')
    }

    expect(await readdir(storeRoot)).toEqual(storeEntriesBefore)
    expect(await readFile(join(storeRoot, 'sentinel'), 'utf8')).toBe('existing session bytes\n')
    expect((await lstat(runRoot)).mode & 0o777).toBe(runModeBefore)
    expect(await Bun.file(join(runRoot, 'opencode-scratch')).exists()).toBe(false)
    expect(await Bun.file(join(runRoot, 'opencode-identity-seal')).exists()).toBe(false)
    expect(await Bun.file(join(runRoot, 'opencode-verified-manifest.json')).exists()).toBe(false)
  })

  test.each(['allow', 'deny'] as const)(
    'a matching owner resumes across a different nodeRun/runRoot with bash=%s',
    async (bash) => {
      const root = mkdtempSync(join(tmpdir(), 'rfc224-verified-resume-'))
      roots.push(root)
      const appHome = join(root, 'app')
      const worktreePath = join(root, 'worktree')
      const executable = join(root, 'tools', 'server')
      await mkdir(worktreePath, { recursive: true })
      await mkdir(dirname(executable), { recursive: true })
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
      await chmod(executable, 0o500)
      await activateVerifiedLinux(appHome)
      const mcp = localMcp({ executable })

      const fresh = await buildVerifiedOpencodeBusinessPlan(
        verifiedContext({
          appHome,
          worktreePath,
          runRoot: join(appHome, 'runs', 'task-1', 'run-1'),
          nodeRunId: 'run-1',
          bash,
          mcp,
          nonceChar: 'a',
        }),
        ['opencode'],
        PLAN_DEPENDENCIES,
      )
      const owner = ownerFromPlan(fresh)
      expect(fresh.sandboxTopology).toBe('runner-outer')
      expect(fresh.diagnostics).toMatchObject({
        containmentProviderId: 'linux-bwrap',
        runnerSandboxed: true,
      })
      const resumed = await buildVerifiedOpencodeBusinessPlan(
        verifiedContext({
          appHome,
          worktreePath,
          runRoot: join(appHome, 'runs', 'task-1', 'run-2'),
          nodeRunId: 'run-2',
          bash,
          mcp,
          nonceChar: 'b',
          owner,
        }),
        ['opencode'],
        PLAN_DEPENDENCIES,
      )
      expect(resumed.control).toMatchObject({
        kind: 'opencode-session',
        mode: 'resume',
        identityDigest: owner.identityDigest,
        createdNodeRunId: 'run-1',
      })
      await resumed.cleanup?.()
      await fresh.cleanup?.()
      await removeHermeticOpencodeLayout(fresh.sessionStore!.root)
    },
  )

  test('resume rejects every local MCP executable/argv/env/timeout identity drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc224-verified-mcp-drift-'))
    roots.push(root)
    const appHome = join(root, 'app')
    const worktreePath = join(root, 'worktree')
    const executable = join(root, 'tools', 'server')
    const otherExecutable = join(root, 'tools', 'other-server')
    await mkdir(worktreePath, { recursive: true })
    await mkdir(dirname(executable), { recursive: true })
    for (const path of [executable, otherExecutable]) {
      await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
      await chmod(path, 0o500)
    }
    await activateVerifiedLinux(appHome)
    const baseline = localMcp({ executable })
    const fresh = await buildVerifiedOpencodeBusinessPlan(
      verifiedContext({
        appHome,
        worktreePath,
        runRoot: join(appHome, 'runs', 'task-1', 'run-1'),
        nodeRunId: 'run-1',
        bash: 'allow',
        mcp: baseline,
        nonceChar: 'a',
      }),
      ['opencode'],
      PLAN_DEPENDENCIES,
    )
    const owner = ownerFromPlan(fresh)
    const drifts = [
      localMcp({ executable: otherExecutable }),
      localMcp({ executable, args: ['--mode', 'changed'] }),
      localMcp({ executable, env: { TOOL_MODE: 'changed' } }),
      localMcp({ executable, timeoutMs: 4_001 }),
    ]
    for (const [index, mcp] of drifts.entries()) {
      await expect(
        buildVerifiedOpencodeBusinessPlan(
          verifiedContext({
            appHome,
            worktreePath,
            runRoot: join(appHome, 'runs', 'task-1', `run-drift-${index}`),
            nodeRunId: `run-drift-${index}`,
            bash: 'allow',
            mcp,
            nonceChar: ['b', 'c', 'd', 'e'][index]!,
            owner,
          }),
          ['opencode'],
          PLAN_DEPENDENCIES,
        ),
      ).rejects.toMatchObject({ code: 'execution-identity-session-mismatch' })
    }
    await fresh.cleanup?.()
    await removeHermeticOpencodeLayout(fresh.sessionStore!.root)
  })
})
