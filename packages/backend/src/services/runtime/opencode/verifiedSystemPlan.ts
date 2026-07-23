// RFC-224 — verified OpenCode plan for framework system agents.
//
// System invocations share the exact official-binary, hermetic-config,
// same-instance and direct-API launcher boundary used by business runs. Their
// only intentional differences are an all-tools-denied agent, no resume/control
// handshake, and a per-invocation store that is removed after capture.

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SpawnPlan, SystemAgentSpawnContext } from '../types'
import { getSandboxProvider, type SandboxProvider } from '@/services/sandbox'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  removeHermeticOpencodeLayout,
} from './hermetic'
import type { OfficialOpencodeBuild, snapshotOfficialOpencodeBinary } from './officialBuilds'
import { assertSourceFingerprintUnchanged, scanOpencodeProjectSurface } from './sourceGuard'
import { removeSealedTree } from './sealedInputs'
import { identityDigest } from './executionIdentity'
import { executionIdentityFailure } from './failure'
import {
  PINNED_OPENCODE_VERSION,
  ROOT_SESSION_PERMISSION_RULES,
  type SelectedModel,
} from './directApiSchemas'
import {
  verifiedLauncherCommand,
  writeVerifiedLaunchManifest,
  type VerifiedLaunchManifest,
} from './verifiedManifest'
import { assertOpencodeStoreUnlocked } from './storeHygiene'
import { assertVerifiedOpencodePlanBoundary, buildVerifiedOpencodePlan } from './verifiedPlanCore'

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000

export interface VerifiedSystemPlanDependencies {
  platform?: NodeJS.Platform
  arch?: string
  getSandbox?: () => SandboxProvider | null
  random?: (size: number) => Buffer
  snapshotBinary?: typeof snapshotOfficialOpencodeBinary
  requireBwrap?: () => Promise<string>
  officialBuild?: (
    version: string,
    platform: NodeJS.Platform,
    arch: string,
  ) => Readonly<OfficialOpencodeBuild>
  sourceEnv?: Readonly<Record<string, string | undefined>>
}

function parseSelectedModel(model: string | null | undefined): SelectedModel {
  if (typeof model !== 'string') {
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1 || model.includes('\0')) {
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function assertAbsolutePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return (async () => {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    await chmod(path, 0o700)
  })()
}

/**
 * Assemble a fresh, non-resumable system invocation. `runDir` must be outside
 * the source worktree: consuming/unlinking the one-shot manifest changes its
 * parent directory metadata, which would otherwise invalidate the source fence.
 */
export async function buildVerifiedOpencodeSystemPlan(
  ctx: SystemAgentSpawnContext,
  command: readonly string[],
  dependencies: VerifiedSystemPlanDependencies = {},
): Promise<SpawnPlan> {
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const sandbox = assertVerifiedOpencodePlanBoundary({
    platform,
    sandbox: (dependencies.getSandbox ?? getSandboxProvider)(),
  })
  if (
    !isAbsolute(ctx.worktreePath) ||
    !isAbsolute(ctx.runDir) ||
    !isAbsolute(ctx.appHome ?? '') ||
    resolve(ctx.worktreePath) !== ctx.worktreePath ||
    resolve(ctx.runDir) !== ctx.runDir ||
    resolve(ctx.appHome ?? '') !== ctx.appHome ||
    ctx.appHome !== sandbox.appHome ||
    ctx.resumeSessionId !== undefined
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const worktreePrefix = `${ctx.worktreePath}/`
  const runPrefix = `${ctx.runDir}/`
  if (
    ctx.worktreePath === ctx.runDir ||
    ctx.runDir.startsWith(worktreePrefix) ||
    ctx.worktreePath.startsWith(runPrefix)
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  if (ctx.agentName.length === 0 || ctx.agentName.length > 256 || ctx.agentName.includes('\0')) {
    return executionIdentityFailure('execution-identity-mismatch')
  }

  const selectedModel = parseSelectedModel(ctx.model)
  const systemStoreParent = join(ctx.appHome, 'opencode-stores', 'system-ephemeral')
  // Settle platform-owned sibling ancestors before the source mtime/ctime
  // fence. Per-invocation writes below these roots cannot then look like a
  // model-controlled project discovery race.
  await Promise.all([
    assertAbsolutePrivateDirectory(ctx.runDir),
    assertAbsolutePrivateDirectory(systemStoreParent),
  ])
  const sourceBefore = await scanOpencodeProjectSurface(ctx.worktreePath)
  const canonicalWorktree = sourceBefore.canonicalWorktree
  if (
    canonicalWorktree === systemStoreParent ||
    canonicalWorktree.startsWith(`${systemStoreParent}/`)
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  const random = dependencies.random ?? randomBytes
  const invocationId = `s_${random(32).toString('base64url')}`
  const storeRoot = join(systemStoreParent, invocationId)
  const sealRoot = join(ctx.runDir, 'opencode-system-seal')
  const binaryPath = join(sealRoot, 'bin', 'opencode')
  const manifestPath = join(ctx.runDir, 'opencode-verified-manifest.json')
  const fffProbeRoot = join(ctx.runDir, 'opencode-fff-probe')
  let succeeded = false

  try {
    const core = await buildVerifiedOpencodePlan({
      platform,
      arch,
      sandbox,
      appHome: ctx.appHome,
      command,
      version: PINNED_OPENCODE_VERSION,
      storeRoot,
      binaryPath,
      fffProbeRoot,
      random,
      dependencies: {
        ...(dependencies.snapshotBinary === undefined
          ? {}
          : { snapshotBinary: dependencies.snapshotBinary }),
        ...(dependencies.requireBwrap === undefined
          ? {}
          : { requireBwrap: dependencies.requireBwrap }),
        ...(dependencies.officialBuild === undefined
          ? {}
          : { officialBuild: dependencies.officialBuild }),
      },
    })
    const { layout, officialBuild: build, fffCapability } = core
    const controlledConfig = buildControlledOpencodeConfig({
      name: ctx.agentName,
      prompt: ctx.systemPrompt,
      description: 'agent-workflow verified system invocation',
      model: `${selectedModel.providerID}/${selectedModel.modelID}`,
      options: {},
      userPermission: {},
      toolOutputPattern: join(layout.xdgData, 'opencode', 'tool-output', '*'),
      shellPath: '/bin/false',
      allowShell: false,
      mcp: {},
    })
    const sourceEnv: Record<string, string | undefined> = {
      ...(dependencies.sourceEnv ?? process.env),
      ...(ctx.gitUserName == null ? {} : { GIT_AUTHOR_NAME: ctx.gitUserName }),
      ...(ctx.gitUserEmail == null ? {} : { GIT_AUTHOR_EMAIL: ctx.gitUserEmail }),
      ...(ctx.gitUserName == null ? {} : { GIT_COMMITTER_NAME: ctx.gitUserName }),
      ...(ctx.gitUserEmail == null ? {} : { GIT_COMMITTER_EMAIL: ctx.gitUserEmail }),
    }
    const auth = buildStrictProviderAuth(selectedModel.providerID, sourceEnv)
    const serverEnv = buildHermeticServerEnv({
      layout,
      providerID: selectedModel.providerID,
      auth,
      config: controlledConfig,
      sourceEnv,
    })
    serverEnv.PWD = canonicalWorktree

    const sessionTitle = `agent-workflow:rfc224:system:${invocationId}`
    const sessionContractDigest = identityDigest({
      directory: canonicalWorktree,
      path: '',
      title: sessionTitle,
      agent: ctx.agentName,
      model: selectedModel,
      permission: ROOT_SESSION_PERMISSION_RULES,
      parentID: null,
      workspaceID: null,
      share: null,
      revert: null,
      metadata: null,
      version: PINNED_OPENCODE_VERSION,
    })
    const currentIdentityDigest = identityDigest({
      codec: 1,
      config: controlledConfig,
      agent: ctx.agentName,
      model: selectedModel,
      officialBuildDigest: build.digest,
    })
    const manifest: VerifiedLaunchManifest = {
      codec: 1,
      version: PINNED_OPENCODE_VERSION,
      binaryPath,
      officialBuildDigest: build.digest,
      worktreePath: canonicalWorktree,
      runRoot: ctx.runDir,
      sessionDbPath: layout.sessionDbPath,
      sessionStoreKey: invocationId,
      storeKind: 'system-ephemeral',
      serverEnv,
      expectedConfig: controlledConfig,
      selectedAgent: ctx.agentName,
      selectedModel,
      prompt: ctx.prompt,
      sourceFingerprintDigest: sourceBefore.digest,
      mode: 'new',
      invocationId,
      sessionTitle,
      sessionContractDigest,
      identityDigest: currentIdentityDigest,
      fffCapabilityCodec: fffCapability.codec,
      fffProbe: fffCapability.probe,
      bootstrapTimeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    }
    await writeVerifiedLaunchManifest(manifestPath, manifest)
    const sourceAfter = await scanOpencodeProjectSurface(canonicalWorktree)
    assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
    succeeded = true

    return {
      cmd: verifiedLauncherCommand(manifestPath),
      env: {},
      stdin: { mode: 'ignore' },
      readOnlySubtrees: [sealRoot, ...layout.configRoots, ...fffCapability.readOnlySubtrees],
      sessionStore: {
        root: storeRoot,
        dbPath: layout.sessionDbPath,
        persistent: false,
      },
      control: { kind: 'none' },
      diagnostics: {
        verifiedIdentity: true,
        inlineModel: `${selectedModel.providerID}/${selectedModel.modelID}`,
        inlineVariant: null,
        mcpCount: 0,
        pluginCount: 0,
        systemEphemeral: true,
      },
      cleanup: async () => {
        await assertOpencodeStoreUnlocked(layout.sessionDbPath)
        await rm(manifestPath, { force: true }).catch(() => {})
        await removeSealedTree(fffProbeRoot).catch(() => {})
        await removeSealedTree(sealRoot).catch(() => {})
        await removeHermeticOpencodeLayout(storeRoot)
      },
    }
  } finally {
    if (!succeeded) {
      await rm(manifestPath, { force: true }).catch(() => {})
      await removeSealedTree(fffProbeRoot).catch(() => {})
      await removeSealedTree(sealRoot).catch(() => {})
      await removeHermeticOpencodeLayout(storeRoot).catch(() => {})
    }
  }
}
