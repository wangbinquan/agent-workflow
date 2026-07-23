import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent, type Mcp } from '@agent-workflow/shared'
import { setSandboxProvider } from '@/services/sandbox'
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
  PINNED_OPENCODE_VERSION,
  ROOT_SESSION_PERMISSION_RULES,
  type SelectedModel,
} from '@/services/runtime/opencode/directApiSchemas'
import { OFFICIAL_OPENCODE_BUILDS } from '@/services/runtime/opencode/officialBuilds'
import { buildVerifiedOpencodeBusinessPlan } from '@/services/runtime/opencode/verifiedPlan'
import type { VerifiedOpencodePlanDependencies } from '@/services/runtime/opencode/verifiedPlanCore'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalAuth = process.env.OPENCODE_AUTH_CONTENT

afterEach(async () => {
  setSandboxProvider(null)
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
  mcp: Mcp
  nonceChar: string
  owner?: NonNullable<BusinessNodeSpawnContext['opencodeResumeOwner']>
}): BusinessNodeSpawnContext {
  return {
    agent: agentWithBash(input.bash),
    prompt: 'do stable work',
    injectedMemoryBlock: null,
    dependents: [],
    mcps: [input.mcp],
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
  }
}

const PLAN_DEPENDENCIES: VerifiedOpencodePlanDependencies = {
  requireBwrap: async () => '/usr/bin/bwrap',
  snapshotBinary: async ({ snapshotPath }) => {
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, 'official test seam', { flag: 'wx', mode: 0o500 })
    await chmod(snapshotPath, 0o500)
    return snapshotPath
  },
}

function activateVerifiedLinux(appHome: string): void {
  Object.defineProperty(process, 'platform', {
    ...platformDescriptor,
    value: 'linux',
  })
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: 'api', key: 'test-only-key' },
  })
  setSandboxProvider({
    mode: 'enforce',
    status: { mechanism: 'bwrap', available: true, detail: null },
    appHome,
  })
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
    officialBuildDigest: plan.control.officialBuildDigest,
    sessionContractDigest: plan.control.sessionContractDigest,
    sessionStoreKey: plan.control.sessionStoreKey,
    projectId: 'project-1',
    opencodeVersion: PINNED_OPENCODE_VERSION,
  }
}

describe('RFC-224 verified business-plan owner barrier', () => {
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

    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'linux',
    })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: 'api', key: 'test-only-key' },
    })
    setSandboxProvider({
      mode: 'enforce',
      status: { mechanism: 'bwrap', available: true, detail: null },
      appHome,
    })

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
    const officialBuild = OFFICIAL_OPENCODE_BUILDS.find(
      (candidate) =>
        candidate.platform === 'linux' &&
        candidate.arch === process.arch &&
        candidate.version === PINNED_OPENCODE_VERSION,
    )!
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
      version: PINNED_OPENCODE_VERSION,
    })
    const expectedIdentityDigest = businessOpencodeIdentityDigest({
      config: controlledConfig,
      agent: 'worker',
      model: selectedModel,
      officialBuildDigest: officialBuild.digest,
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
      opencodeResumeOwner: {
        sessionId: 'session-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        createdNodeRunId,
        // The only immutable drift: all other reconstructed owner fields match.
        identityDigest:
          expectedIdentityDigest.slice(0, -1) + (expectedIdentityDigest.endsWith('0') ? '1' : '0'),
        officialBuildDigest: officialBuild.digest,
        sessionContractDigest,
        sessionStoreKey: storeKey,
        projectId: 'project-1',
        opencodeVersion: PINNED_OPENCODE_VERSION,
      },
    }

    try {
      await buildVerifiedOpencodeBusinessPlan(ctx, ['opencode'])
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
      activateVerifiedLinux(appHome)
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
    activateVerifiedLinux(appHome)
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
