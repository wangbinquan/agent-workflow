// RFC-224 — verified OpenCode plan for framework system agents.
//
// System invocations share the exact byte-frozen binary, hermetic-config,
// same-instance and direct-API launcher boundary used by business runs. Their
// only intentional differences are an all-tools-denied agent, no resume/control
// handshake, and a per-invocation store that is removed after capture.

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SpawnPlan, SystemAgentSpawnContext } from '../types'
import {
  SYSTEM_READ_ONLY_TOOLS,
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  removeHermeticOpencodeLayout,
} from './hermetic'
import {
  inheritsMachineOpencodeConfig,
  resolveProviderCredential,
  type MachineConfigDependencies,
} from './machineConfig'
import type { snapshotRuntimeOpencodeBinary } from './runtimeBinary'
import { assertSourceFingerprintUnchanged, scanOpencodeProjectSurface } from './sourceGuard'
import { removeSealedTree } from './sealedInputs'
import { identityDigest } from './executionIdentity'
import { executionIdentityFailure } from './failure'
import {
  OPENCODE_DIRECT_PROTOCOL_CODEC,
  ROOT_SESSION_PERMISSION_RULES,
  type SelectedModel,
} from './directApiSchemas'
import {
  VERIFIED_LAUNCH_MANIFEST_CODEC,
  verifiedLauncherCommand,
  writeVerifiedLaunchManifest,
  type VerifiedLaunchManifest,
} from './verifiedManifest'
import { assertOpencodeStoreUnlocked } from './storeHygiene'
import { sealDirectoryOwnerOnly } from '@/util/win32Acl'
import { buildVerifiedOpencodePlan } from './verifiedPlanCore'
import { runtimeContainmentAdmissionFromPrepared } from './containment'
import { disabledShellCommandForHost, EXECUTABLE_SUFFIX_FOR_HOST } from '@/util/platformExec'

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000

export interface VerifiedSystemPlanDependencies {
  random?: (size: number) => Buffer
  snapshotBinary?: typeof snapshotRuntimeOpencodeBinary
  sourceEnv?: Readonly<Record<string, string | undefined>>
  /** RFC-256 — inject the daemon config that carries the inheritance switch. */
  machineConfig?: MachineConfigDependencies
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
    // RFC-254 T40b: seal to owner+TCB so the system manifest written into this dir
    // proves private on win32 (mode above is synthesized there).
    // `sealDirectoryOwnerOnly` is a no-op off win32, so the host-platform branch
    // lives in that helper — this guarded module never reads the platform global
    // directly (T11c).
    if (!(await sealDirectoryOwnerOnly(path)).trusted) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
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
  const preparedContainment =
    ctx.containment ?? executionIdentityFailure('execution-identity-containment-required')
  const admissionReceipt = preparedContainment.receipt
  const admissionDecision = admissionReceipt.decision
  if (admissionDecision === 'blocked') {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  const admission = runtimeContainmentAdmissionFromPrepared(preparedContainment)
  const { sandbox } = admission
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
  const binaryPath = join(sealRoot, 'bin', `opencode${EXECUTABLE_SUFFIX_FOR_HOST}`)
  const manifestPath = join(ctx.runDir, 'opencode-verified-manifest.json')
  const fffProbeRoot = join(ctx.runDir, 'opencode-fff-probe')
  let succeeded = false

  try {
    const core = await buildVerifiedOpencodePlan({
      admission,
      appHome: ctx.appHome,
      command,
      storeRoot,
      binaryPath,
      fffProbeRoot,
      random,
      dependencies: {
        ...(dependencies.snapshotBinary === undefined
          ? {}
          : { snapshotBinary: dependencies.snapshotBinary }),
      },
    })
    const { layout, binaryIdentity, containment, childProvider, fffCapability } = core
    // RFC-234 §1.1 — materialize the frozen system permission profile. Unknown
    // values are an identity failure (fail closed), and 'intent-read-v1' flips
    // ONLY the closed read-only subset; bash stays denied via allowShell.
    const profile = ctx.systemPermissionProfile ?? 'all-deny'
    if (profile !== 'all-deny' && profile !== 'intent-read-v1') {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const sourceEnv: Record<string, string | undefined> = {
      ...(dependencies.sourceEnv ?? process.env),
      ...(ctx.gitUserName == null ? {} : { GIT_AUTHOR_NAME: ctx.gitUserName }),
      ...(ctx.gitUserEmail == null ? {} : { GIT_AUTHOR_EMAIL: ctx.gitUserEmail }),
      ...(ctx.gitUserName == null ? {} : { GIT_COMMITTER_NAME: ctx.gitUserName }),
      ...(ctx.gitUserEmail == null ? {} : { GIT_COMMITTER_EMAIL: ctx.gitUserEmail }),
    }
    // RFC-255: resolved BEFORE the config is built — a custom gateway
    // contributes a `provider` section to it, and a disabled one fails here
    // instead of falling through to the generic credential channels.
    const credential = await resolveProviderCredential(
      selectedModel.providerID,
      sourceEnv,
      dependencies.machineConfig,
    )
    const auth = credential.auth
    const controlledConfig = buildControlledOpencodeConfig({
      name: ctx.agentName,
      prompt: ctx.systemPrompt,
      description: 'agent-workflow verified system invocation',
      model: `${selectedModel.providerID}/${selectedModel.modelID}`,
      options: {},
      userPermission: {},
      toolOutputPattern: join(layout.xdgData, 'opencode', 'tool-output', '*'),
      // RFC-254 T11b: the "present but immediately failing" command; Windows
      // has no /bin/false (see disabledShellCommand).
      shellPath: disabledShellCommandForHost(),
      allowShell: false,
      mcp: {},
      ...(profile === 'intent-read-v1' ? { allowedReadOnlyTools: SYSTEM_READ_ONLY_TOOLS } : {}),
    })
    const serverEnv = buildHermeticServerEnv({
      layout,
      providerID: selectedModel.providerID,
      auth,
      config: controlledConfig,
      sourceEnv,
      inheritMachineConfig: inheritsMachineOpencodeConfig(dependencies.machineConfig),
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
    })
    const currentIdentityDigest = identityDigest({
      codec: 1,
      config: controlledConfig,
      agent: ctx.agentName,
      model: selectedModel,
      binaryDigest: binaryIdentity.digest,
    })
    const manifest: VerifiedLaunchManifest = {
      codec: VERIFIED_LAUNCH_MANIFEST_CODEC,
      protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
      binaryPath,
      binaryDigest: binaryIdentity.digest,
      containmentAdmission: {
        ...admissionReceipt,
        requiredCapabilities: [...admissionReceipt.requiredCapabilities],
        capabilities: { ...admissionReceipt.capabilities },
        reasonCodes: [...admissionReceipt.reasonCodes],
        decision: admissionDecision,
      },
      containmentTopology: preparedContainment.topology,
      containment,
      childProvider,
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
      ...(fffCapability === null
        ? {}
        : {
            fffCapabilityCodec: fffCapability.codec,
            fffProbe: fffCapability.probe,
          }),
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
      sandboxTopology: preparedContainment.spawnTopology,
      readOnlySubtrees: [sealRoot, ...layout.configRoots, ...core.readOnlySubtrees],
      sessionStore: {
        root: storeRoot,
        dbPath: layout.sessionDbPath,
        persistent: false,
      },
      control: { kind: 'none' },
      diagnostics: {
        verifiedIdentity: true,
        containmentProviderId: containment.providerId,
        containmentMode: containment.mode,
        containmentCapabilities: containment.capabilities,
        containmentDegradedReasons: containment.degradedReasons,
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
