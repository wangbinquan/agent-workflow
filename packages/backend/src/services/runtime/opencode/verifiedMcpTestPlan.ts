// RFC-238 — independent verified OpenCode plan for the MCP playground.
//
// This path shares RFC-224/227's byte-frozen server, same-instance direct API,
// containment and strict session comparator, while using its own persistent
// store kind and owner/control identity. It never manufactures task/node rows.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { McpTestSpawnContext, McpTestSpawnPlan } from '../types'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  deriveHermeticOpencodeLayout,
  resolveStrictProviderAuth,
} from './hermetic'
import { inspectRuntimeOpencodeBinary, type snapshotRuntimeOpencodeBinary } from './runtimeBinary'
import { assertSourceFingerprintUnchanged, scanOpencodeProjectSurface } from './sourceGuard'
import { identityDigest, type IdentityJson } from './executionIdentity'
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
import {
  buildVerifiedOpencodePlan,
  type VerifiedOpencodePlanDependencies,
} from './verifiedPlanCore'
import { runtimeContainmentAdmissionFromPrepared } from './containment'
import { removeSealedTree } from './sealedInputs'

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000

export interface VerifiedMcpTestPlanDependencies extends VerifiedOpencodePlanDependencies {
  random?: (size: number) => Buffer
  inspectBinary?: typeof inspectRuntimeOpencodeBinary
  snapshotBinary?: typeof snapshotRuntimeOpencodeBinary
  sourceEnv?: Readonly<Record<string, string | undefined>>
}

function parseSelectedModel(
  model: string | null | undefined,
  variant: string | null | undefined,
): SelectedModel {
  if (typeof model !== 'string') {
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  const slash = model.indexOf('/')
  if (
    slash <= 0 ||
    slash === model.length - 1 ||
    model.includes('\0') ||
    (typeof variant === 'string' && (variant.length === 0 || variant.includes('\0')))
  ) {
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
    ...(variant == null ? {} : { variant }),
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await chmod(path, 0o700)
}

function storeKeyFor(sessionId: string): string {
  return `m_${createHash('sha256').update(sessionId, 'utf8').digest('base64url')}`
}

export function opencodeMcpTestSessionStore(input: { appHome: string; sessionId: string }): {
  key: string
  root: string
} {
  const key = storeKeyFor(input.sessionId)
  return {
    key,
    root: join(input.appHome, 'opencode-stores', 'mcp-test', key),
  }
}

function mcpTestIdentity(input: {
  testSessionId: string
  sessionStoreKey: string
  agent: string
  model: SelectedModel
  temperature: number | null
  steps: number | null
  binaryDigest: string
  mcpExecutionDigest: string
}): string {
  return identityDigest({
    codec: 1,
    storeKind: 'mcp-test',
    testSessionId: input.testSessionId,
    sessionStoreKey: input.sessionStoreKey,
    agent: input.agent,
    model: input.model,
    temperature: input.temperature,
    steps: input.steps,
    binaryDigest: input.binaryDigest,
    mcpExecutionDigest: input.mcpExecutionDigest,
  })
}

export async function buildVerifiedOpencodeMcpTestPlan(
  ctx: McpTestSpawnContext,
  command: readonly string[],
  dependencies: VerifiedMcpTestPlanDependencies = {},
): Promise<McpTestSpawnPlan> {
  if (ctx.nativeSessionId !== undefined) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }
  const preparedContainment =
    ctx.containment ?? executionIdentityFailure('execution-identity-containment-required')
  if (preparedContainment.receipt.decision === 'blocked') {
    return executionIdentityFailure('execution-identity-bootstrap-failed')
  }
  const admission = runtimeContainmentAdmissionFromPrepared(preparedContainment)
  if (
    !isAbsolute(ctx.appHome) ||
    resolve(ctx.appHome) !== ctx.appHome ||
    ctx.appHome !== admission.sandbox.appHome ||
    !isAbsolute(ctx.worktreePath) ||
    resolve(ctx.worktreePath) !== ctx.worktreePath ||
    !isAbsolute(ctx.runDir) ||
    resolve(ctx.runDir) !== ctx.runDir
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const control =
    ctx.opencodeControl ?? executionIdentityFailure('execution-identity-control-failed')
  if (
    !/^[A-Za-z0-9_-]{32,128}$/.test(control.nonce) ||
    !/^[0-9a-f]{64}$/.test(control.leaseNonceDigest)
  ) {
    return executionIdentityFailure('execution-identity-control-failed')
  }
  const mode = ctx.resumeSessionId === undefined ? 'new' : 'resume'
  if (
    (mode === 'new' && control.kind !== 'new') ||
    (mode === 'resume' &&
      (control.kind !== 'resume' || control.expectedSessionId !== ctx.resumeSessionId))
  ) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }

  const selectedModel = parseSelectedModel(ctx.model, ctx.variant)
  const selectedSteps = ctx.steps ?? ctx.maxSteps ?? null
  const store = opencodeMcpTestSessionStore({ appHome: ctx.appHome, sessionId: ctx.sessionId })
  if (ctx.sessionStoreRoot !== store.root) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const sealRoot = join(ctx.runDir, 'opencode-mcp-test-seal')
  const binaryPath = join(sealRoot, 'bin', 'opencode')
  const manifestPath = join(ctx.runDir, 'opencode-verified-manifest.json')
  const ackPath = join(ctx.runDir, 'opencode-control.ack')
  const fffProbeRoot = join(ctx.runDir, 'opencode-fff-probe')
  const plannedLayout = deriveHermeticOpencodeLayout(store.root)
  const sourceBefore = await scanOpencodeProjectSurface(ctx.worktreePath)
  const canonicalWorktree = sourceBefore.canonicalWorktree
  const buildDigest = (await (dependencies.inspectBinary ?? inspectRuntimeOpencodeBinary)(command))
    .digest
  const title = `agent-workflow:rfc238:mcp-test:${ctx.sessionId}`
  const sessionContractDigest = identityDigest({
    directory: canonicalWorktree,
    path: '',
    title,
    agent: ctx.agentName,
    model: selectedModel,
    permission: ROOT_SESSION_PERMISSION_RULES,
    parentID: null,
    workspaceID: null,
    share: null,
    revert: null,
    metadata: null,
  })
  const ownerIdentityDigest = mcpTestIdentity({
    testSessionId: ctx.sessionId,
    sessionStoreKey: store.key,
    agent: ctx.agentName,
    model: selectedModel,
    temperature: ctx.temperature ?? null,
    steps: selectedSteps,
    binaryDigest: buildDigest,
    mcpExecutionDigest: ctx.executionMaterial.executionDigest,
  })
  if (
    control.kind === 'resume' &&
    (control.expectedIdentityDigest !== ownerIdentityDigest ||
      control.expectedRuntimeBinaryDigest !== buildDigest ||
      control.expectedSessionContractDigest !== sessionContractDigest ||
      control.expectedSessionStoreKey !== store.key ||
      control.expectedProtocolCodec !== OPENCODE_DIRECT_PROTOCOL_CODEC)
  ) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }

  await Promise.all([
    ensurePrivateDirectory(ctx.runDir),
    ensurePrivateDirectory(join(ctx.appHome, 'opencode-stores', 'mcp-test')),
  ])
  const mcpPattern = `${ctx.executionMaterial.runtimeKey}_*`
  const controlledConfig = buildControlledOpencodeConfig({
    name: ctx.agentName,
    prompt: ctx.systemPrompt,
    description: 'Private MCP runtime capability test',
    model: `${selectedModel.providerID}/${selectedModel.modelID}`,
    variant: selectedModel.variant,
    temperature: ctx.temperature,
    steps: selectedSteps,
    options: {},
    userPermission: {
      '*': 'deny',
      [mcpPattern]: 'allow',
    },
    toolOutputPattern: join(plannedLayout.xdgData, 'opencode', 'tool-output', '*'),
    shellPath: '/bin/false',
    allowShell: false,
    mcp: {
      [ctx.executionMaterial.runtimeKey]: ctx.executionMaterial.opencodeEntry as IdentityJson,
    },
  })
  const sourceEnv = dependencies.sourceEnv ?? process.env
  const auth = await resolveStrictProviderAuth(selectedModel.providerID, sourceEnv)
  const random = dependencies.random ?? randomBytes
  const serverEnv = buildHermeticServerEnv({
    layout: plannedLayout,
    providerID: selectedModel.providerID,
    auth,
    config: controlledConfig,
    username: `aw-${random(12).toString('base64url')}`,
    password: random(32).toString('base64url'),
    sourceEnv,
  })
  serverEnv.PWD = canonicalWorktree

  let succeeded = false
  try {
    const core = await buildVerifiedOpencodePlan({
      admission,
      appHome: ctx.appHome,
      command,
      storeRoot: store.root,
      binaryPath,
      fffProbeRoot,
      expectedBinaryDigest: buildDigest,
      random,
      dependencies: {
        ...(dependencies.snapshotBinary === undefined
          ? {}
          : { snapshotBinary: dependencies.snapshotBinary }),
      },
    })
    if (identityDigest(core.layout) !== identityDigest(plannedLayout)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const sourceAfter = await scanOpencodeProjectSurface(canonicalWorktree)
    assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
    const manifest: VerifiedLaunchManifest = {
      codec: VERIFIED_LAUNCH_MANIFEST_CODEC,
      protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
      binaryPath,
      binaryDigest: buildDigest,
      containmentAdmission: {
        ...preparedContainment.receipt,
        requiredCapabilities: [...preparedContainment.receipt.requiredCapabilities],
        capabilities: { ...preparedContainment.receipt.capabilities },
        reasonCodes: [...preparedContainment.receipt.reasonCodes],
        decision: preparedContainment.receipt.decision,
      },
      containmentTopology: preparedContainment.topology,
      containment: core.containment,
      childProvider: core.childProvider,
      worktreePath: canonicalWorktree,
      runRoot: ctx.runDir,
      sessionDbPath: plannedLayout.sessionDbPath,
      sessionStoreKey: store.key,
      storeKind: 'mcp-test',
      serverEnv,
      expectedConfig: controlledConfig,
      selectedAgent: ctx.agentName,
      selectedModel,
      prompt: ctx.prompt,
      sourceFingerprintDigest: sourceBefore.digest,
      mode,
      testSessionId: ctx.sessionId,
      createdTurnId: control.createdTurnId,
      turnId: ctx.turnId,
      ...(control.kind === 'resume'
        ? {
            expectedSessionId: control.expectedSessionId,
            expectedProjectId: control.expectedProjectId,
          }
        : {}),
      sessionTitle: title,
      sessionContractDigest,
      identityDigest: ownerIdentityDigest,
      mcpExecutionDigest: ctx.executionMaterial.executionDigest,
      controlAckPath: ackPath,
      leaseNonce: control.nonce,
      leaseNonceDigest: control.leaseNonceDigest,
      ...(core.fffCapability === null
        ? {}
        : {
            fffCapabilityCodec: core.fffCapability.codec,
            fffProbe: core.fffCapability.probe,
          }),
      bootstrapTimeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    }
    await writeVerifiedLaunchManifest(manifestPath, manifest)
    succeeded = true
    return {
      cmd: verifiedLauncherCommand(manifestPath),
      env: {},
      stdin: { mode: 'ignore' },
      sandboxTopology: preparedContainment.spawnTopology,
      readOnlySubtrees: [
        sealRoot,
        ctx.executionMaterial.root,
        ...core.layout.configRoots,
        ...core.readOnlySubtrees,
      ],
      sessionStore: {
        root: store.root,
        dbPath: core.layout.sessionDbPath,
        persistent: true,
      },
      control: {
        kind: 'opencode-mcp-test',
        mode,
        nonce: control.nonce,
        leaseNonceDigest: control.leaseNonceDigest,
        ackPath,
        testSessionId: ctx.sessionId,
        turnId: ctx.turnId,
        createdTurnId: control.createdTurnId,
        ...(control.kind === 'resume' ? { expectedSessionId: control.expectedSessionId } : {}),
        identityDigest: ownerIdentityDigest,
        runtimeBinaryDigest: buildDigest,
        protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
        sessionContractDigest,
        sessionStoreKey: store.key,
      },
      identity: {
        codec: 'mcp-test-plan-identity-v1',
        runtimeBinaryDigest: buildDigest,
        mcpExecutionDigest: ctx.executionMaterial.executionDigest,
        sessionContractDigest,
        rawCommandDigest: identityDigest({
          codec: 1,
          protocol: 'opencode',
          runtimeBinaryDigest: buildDigest,
        }),
      },
      preSpawnVerify: () => ctx.executionMaterial.preSpawnVerify(),
      diagnostics: {
        verifiedIdentity: true,
        mcpTestCodec: 'mcp-test-v1',
        mcpCount: 1,
        mcpKeys: [ctx.executionMaterial.runtimeKey],
        nativeSessionMode: mode,
      },
      cleanup: async () => {
        await assertOpencodeStoreUnlocked(core.layout.sessionDbPath)
        await rm(manifestPath, { force: true }).catch(() => {})
        await rm(ackPath, { force: true }).catch(() => {})
        await removeSealedTree(fffProbeRoot).catch(() => {})
        await removeSealedTree(sealRoot).catch(() => {})
        await rm(ctx.runDir, { recursive: true, force: true })
      },
    }
  } finally {
    if (!succeeded) {
      await rm(manifestPath, { force: true }).catch(() => {})
      await rm(ackPath, { force: true }).catch(() => {})
      await removeSealedTree(fffProbeRoot).catch(() => {})
      await removeSealedTree(sealRoot).catch(() => {})
      await rm(ctx.runDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
