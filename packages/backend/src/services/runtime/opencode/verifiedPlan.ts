// RFC-224 — parent-side verified OpenCode plan assembly. Production execution
// enters the hidden direct-API launcher; the legacy CLI builder remains only
// behind explicit test dependency injection.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BusinessNodeSpawnContext, SpawnPlan } from '../types'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  deriveHermeticOpencodeLayout,
  removeHermeticOpencodeLayout,
  resolveStrictProviderAuth,
  type HermeticOpencodeLayout,
} from './hermetic'
import { inspectRuntimeOpencodeBinary, snapshotRuntimeOpencodeBinary } from './runtimeBinary'
import {
  assertSourceFingerprintUnchanged,
  readFrozenInstruction,
  scanOpencodeProjectSurface,
} from './sourceGuard'
import {
  inspectManagedSkillTree,
  removeSealedTree,
  snapshotManagedSkillTree,
  type ManagedSkillTreeInspection,
} from './sealedInputs'
import {
  materializeNetlessWrapper,
  sanitizeNetlessEnvironment,
  type NetlessSubprocessManifest,
} from './sealedSubprocess'
import {
  runtimeContainmentAdmissionFromPrepared,
  type RuntimeChildProviderPlan,
} from './containment'
import {
  businessOpencodeIdentityDigest,
  identityDigest,
  type IdentityJson,
} from './executionIdentity'
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
import { isProductionOpencodeCommand } from '@/util/opencode'
import { runGit } from '@/util/git'
import { assertOpencodeStoreUnlocked } from './storeHygiene'
import { buildVerifiedInventoryPlan } from './verifiedInventory'
import {
  buildVerifiedOpencodePlan,
  type VerifiedOpencodePlanDependencies,
} from './verifiedPlanCore'

const STORE_KEY_RE = /^[A-Za-z0-9_-]{16,160}$/
const SAFE_MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000

function parseSelectedModel(
  model: string | null | undefined,
  variant: string | null,
): SelectedModel {
  if (typeof model !== 'string') {
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1 || model.includes('\0')) {
    // Model IDs may themselves contain slashes; only the first slash splits
    // provider from model.
    return executionIdentityFailure('execution-identity-model-unresolved')
  }
  const selected: SelectedModel = {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
  if (variant !== null && variant !== '') selected.variant = variant
  return selected
}

function safeStoreKey(value: string): string {
  if (!STORE_KEY_RE.test(value)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return value
}

function safeAbsoluteHome(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value) || resolve(value) !== value) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return value
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function assertRegisteredGitWorktree(canonicalRepo: string): Promise<void> {
  const listed = await runGit(canonicalRepo, ['worktree', 'list', '--porcelain', '-z'])
  if (listed.exitCode !== 0) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  for (const record of listed.stdout.split('\0')) {
    if (!record.startsWith('worktree ')) continue
    const registeredPath = record.slice('worktree '.length)
    if (
      !isAbsolute(registeredPath) ||
      resolve(registeredPath) !== registeredPath ||
      registeredPath.includes('\0')
    ) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const metadata = await lstat(registeredPath).catch(() => null)
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) continue
    if ((await realpath(registeredPath)) === canonicalRepo) return
  }
  // A `.git` pointer is writable from the worktree. Never turn an arbitrary
  // valid repository named by that pointer into a writable allow-back: the
  // common dir must also register this exact canonical worktree.
  return executionIdentityFailure('execution-identity-store-unsafe')
}

/**
 * Resolve only daemon-owned Git metadata projections. The child sandbox
 * already exposes each worktree's files, but linked worktrees keep objects,
 * refs, index and config in an external common dir hidden by the appHome/HOME
 * masks. Asking Git avoids parsing attacker-controlled `.git` pointer text,
 * and canonicalization prevents a symlinked broad subtree from becoming an
 * accidental allow-back.
 */
async function resolveGitCommonDirs(
  repoWorktreePaths: readonly string[] | undefined,
  canonicalPrimaryWorktree: string,
): Promise<string[]> {
  // Direct unit callers predating the runner-owned topology keep the historical
  // non-Git fixture path. Production runner calls always provide this field.
  if (repoWorktreePaths === undefined) return []
  if (repoWorktreePaths.length === 0 || repoWorktreePaths.length > 64) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }

  const canonicalRepos: string[] = []
  const commonDirs: string[] = []
  for (const repoPath of repoWorktreePaths) {
    if (!isAbsolute(repoPath) || resolve(repoPath) !== repoPath || repoPath.includes('\0')) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const metadata = await lstat(repoPath).catch(() => null)
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const canonicalRepo = await realpath(repoPath)
    canonicalRepos.push(canonicalRepo)

    const common = await runGit(canonicalRepo, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const reportedCommonDir = common.stdout.trim()
    if (
      common.exitCode !== 0 ||
      !isAbsolute(reportedCommonDir) ||
      resolve(reportedCommonDir) !== reportedCommonDir ||
      reportedCommonDir.includes('\0')
    ) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const commonMetadata = await lstat(reportedCommonDir).catch(() => null)
    if (
      commonMetadata === null ||
      commonMetadata.isSymbolicLink() ||
      !commonMetadata.isDirectory()
    ) {
      return executionIdentityFailure('execution-identity-source-changed')
    }
    const canonicalCommonDir = await realpath(reportedCommonDir)
    if (canonicalCommonDir !== reportedCommonDir) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    if (!contained(canonicalRepo, canonicalCommonDir)) {
      await assertRegisteredGitWorktree(canonicalRepo)
    }
    commonDirs.push(canonicalCommonDir)
  }
  if (!canonicalRepos.includes(canonicalPrimaryWorktree)) {
    return executionIdentityFailure('execution-identity-source-changed')
  }

  return [
    ...new Set(
      commonDirs.filter(
        (commonDir) => !canonicalRepos.some((repoPath) => contained(repoPath, commonDir)),
      ),
    ),
  ].sort()
}

function shaName(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function appendFrozenBlock(
  base: string,
  kind: string,
  name: string,
  digest: string,
  body: string,
): string {
  return (
    `${base}\n\n<aw-frozen-${kind} name=${JSON.stringify(name)} ` +
    `sha256=${JSON.stringify(digest)}>\n${body}\n</aw-frozen-${kind}>`
  )
}

async function ensurePrivateRunRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  await chmod(path, 0o700)
}

const FIXED_NETLESS_PATH = '/usr/bin:/bin'

interface BusinessToolchainSnapshot {
  executablePaths: string[]
  path: string
}

export interface VerifiedBusinessPlanDependencies extends VerifiedOpencodePlanDependencies {
  /** Resolve optional model-facing tools without trusting the child environment's PATH. */
  resolveToolchainBinary?: (token: string) => string | null
  /** Freeze a resolved tool into the private per-run seal before exposing it. */
  snapshotToolchainBinary?: typeof snapshotRuntimeOpencodeBinary
}

/**
 * The verified OpenCode server intentionally receives a minimal fixed PATH.
 * Model-invoked build/test commands need one additional tool that the product
 * itself depends on: Bun. Expose a byte-frozen per-run copy instead of the
 * daemon's mutable user-home installation. Missing Bun remains non-fatal so a
 * compiled deployment can still run workflows that do not require it.
 */
async function snapshotBusinessToolchain(
  sealRoot: string,
  dependencies: VerifiedBusinessPlanDependencies,
): Promise<BusinessToolchainSnapshot | null> {
  const resolveToolchainBinary =
    dependencies.resolveToolchainBinary ?? ((token: string) => Bun.which(token))
  const sourcePath = resolveToolchainBinary('bun')
  if (sourcePath === null) return null

  const snapshotPath = join(sealRoot, 'toolchain', 'bun')
  try {
    const snapshot = await (dependencies.snapshotToolchainBinary ?? snapshotRuntimeOpencodeBinary)({
      command: [sourcePath],
      snapshotPath,
    })
    if (snapshot.snapshotPath !== snapshotPath || !/^[0-9a-f]{64}$/.test(snapshot.digest)) {
      return null
    }
  } catch {
    return null
  }
  return {
    executablePaths: [snapshotPath],
    path: `${dirname(snapshotPath)}:${FIXED_NETLESS_PATH}`,
  }
}

function netlessBaseEnv(
  layout: HermeticOpencodeLayout,
  source: Readonly<Record<string, string | undefined>>,
  toolchainPath = FIXED_NETLESS_PATH,
): Record<string, string> {
  return sanitizeNetlessEnvironment({
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    TERM: source.TERM,
    TZ: source.TZ,
    GIT_AUTHOR_NAME: source.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: source.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: source.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: source.GIT_COMMITTER_EMAIL,
    PATH: toolchainPath,
    HOME: layout.home,
    TMPDIR: layout.tmp,
    PWD: layout.root,
  })
}

interface PlannedLocalMcpWrapper {
  executable: string
  args: readonly string[]
  wrapperPath: string
  wrapperManifestPath: string
  configuredEnv: Readonly<Record<string, string>>
}

interface PlannedMcpConfig {
  config: Record<string, IdentityJson>
  localWrappers: readonly PlannedLocalMcpWrapper[]
}

/**
 * Resolve the MCP identity without writing wrappers. Wrapper paths are
 * deterministic members of the run seal, so they can participate in an owner
 * digest before that seal exists.
 */
async function planMcpConfig(
  ctx: BusinessNodeSpawnContext,
  input: { sealRoot: string },
): Promise<PlannedMcpConfig> {
  const result: Record<string, IdentityJson> = Object.create(null) as Record<string, IdentityJson>
  const localWrappers: PlannedLocalMcpWrapper[] = []
  for (const mcp of ctx.mcps) {
    if (mcp.enabled === false) continue
    if (!SAFE_MCP_NAME_RE.test(mcp.name) || Object.hasOwn(result, mcp.name)) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    if (mcp.type === 'remote') {
      result[mcp.name] = {
        type: 'remote',
        enabled: true,
        url: mcp.config.url,
        ...(mcp.config.headers === undefined ? {} : { headers: mcp.config.headers }),
        ...(mcp.config.oauth === undefined ? {} : { oauth: mcp.config.oauth }),
        ...(mcp.config.timeoutMs === undefined ? {} : { timeout: mcp.config.timeoutMs }),
      } as IdentityJson
      continue
    }

    const command = mcp.config.command
    if (
      command.length === 0 ||
      command.some((entry) => entry.length === 0 || entry.includes('\0')) ||
      !isAbsolute(command[0]!)
    ) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const executable = await realpath(command[0]!)
    const executableMetadata = await lstat(executable)
    if (executableMetadata.isSymbolicLink() || !executableMetadata.isFile()) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    const args = command.slice(1)
    // Reject dangerous MCP-authored env before an owner mismatch can touch
    // the persistent store. The full semantic descriptor becomes the stable
    // wrapper suffix, so resume identity changes for executable/argv/env/
    // timeout without depending on this attempt's runRoot.
    const configuredEnv = sanitizeNetlessEnvironment(mcp.config.env ?? {})
    const wrapperIdentity = identityDigest({
      codec: 1,
      name: mcp.name,
      executable,
      args,
      configuredEnv,
      timeoutMs: mcp.config.timeoutMs ?? null,
    })
    const wrapperDir = join(input.sealRoot, 'mcp', wrapperIdentity)
    const wrapperPath = join(wrapperDir, 'run')
    const wrapperManifestPath = join(wrapperDir, 'netless.json')
    localWrappers.push({
      executable,
      args,
      wrapperPath,
      wrapperManifestPath,
      configuredEnv,
    })
    result[mcp.name] = {
      type: 'local',
      enabled: true,
      command: [wrapperPath],
      ...(mcp.config.timeoutMs === undefined ? {} : { timeout: mcp.config.timeoutMs }),
    }
  }
  return { config: result, localWrappers }
}

async function materializeMcpWrappers(input: {
  planned: PlannedMcpConfig
  childProvider: RuntimeChildProviderPlan
  layout: HermeticOpencodeLayout
  appHome: string
  realHome: string
  scratchPath: string
  worktreePath: string
  frozenSkillPaths: readonly string[]
  sourceEnv: Readonly<Record<string, string | undefined>>
  gitCommonDirs: readonly string[]
  toolchain: BusinessToolchainSnapshot | null
}): Promise<void> {
  for (const wrapper of input.planned.localWrappers) {
    // The daemon environment is not an MCP configuration surface: inherit only
    // the small, explicit base assembled above. MCP-authored env was checked in
    // the read-only planning phase.
    const mcpEnv = {
      ...netlessBaseEnv(input.layout, input.sourceEnv, input.toolchain?.path),
      ...wrapper.configuredEnv,
      PATH: input.toolchain?.path ?? FIXED_NETLESS_PATH,
      HOME: input.layout.home,
      TMPDIR: input.layout.tmp,
      PWD: input.worktreePath,
    }
    const wrapperManifest: NetlessSubprocessManifest = {
      codec: 1,
      mode: 'mcp',
      provider: input.childProvider,
      worktreePath: input.worktreePath,
      scratchPath: input.scratchPath,
      appHome: input.appHome,
      realHome: input.realHome,
      gitCommonDirs: [...input.gitCommonDirs],
      // Bind only the executable inode. Rebinding its whole parent after the
      // inner sandbox masks realHome/appHome could expose SSH, cloud, provider,
      // or daemon state beside an otherwise legitimate local MCP binary.
      bindReadOnly: [
        ...new Set([
          ...input.frozenSkillPaths,
          ...(input.toolchain?.executablePaths ?? []),
          wrapper.executable,
        ]),
      ],
      env: mcpEnv,
      command: [wrapper.executable, ...wrapper.args],
    }
    await materializeNetlessWrapper({
      wrapperPath: wrapper.wrapperPath,
      manifestPath: wrapper.wrapperManifestPath,
      manifest: wrapperManifest,
    })
  }
}

export function usesLegacyTestOpencodePath(ctx: BusinessNodeSpawnContext): boolean {
  return (
    ctx.testOnlyUnverifiedRuntime === true ||
    (ctx.opencodeCmd !== undefined && !isProductionOpencodeCommand(ctx.opencodeCmd))
  )
}

export async function buildVerifiedOpencodeBusinessPlan(
  ctx: BusinessNodeSpawnContext,
  command: readonly string[],
  dependencies: VerifiedBusinessPlanDependencies = {},
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
  if (ctx.dependents.length > 0) {
    return executionIdentityFailure('execution-identity-dependent-unsupported')
  }
  if (ctx.plugins.some((plugin) => plugin.enabled !== false)) {
    return executionIdentityFailure('execution-identity-plugin-unsupported')
  }
  if (ctx.skills.some((skill) => skill.sourceKind !== 'managed')) {
    return executionIdentityFailure('execution-identity-project-config-unsupported')
  }
  const appHome = ctx.appHome
  const taskId = ctx.taskId
  const nodeId = ctx.nodeId
  const nonce = ctx.opencodeControlNonce
  const nonceDigest = ctx.opencodeLeaseNonceDigest
  if (
    appHome === undefined ||
    !isAbsolute(appHome) ||
    resolve(appHome) !== appHome ||
    appHome !== sandbox.appHome ||
    taskId === undefined ||
    nodeId === undefined ||
    nonce === undefined ||
    nonceDigest === undefined ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(nonceDigest)
  ) {
    return executionIdentityFailure('execution-identity-control-failed')
  }

  const profile = ctx.resolvedParamsByAgent.get(ctx.agent.name)
  const selectedModel = parseSelectedModel(profile?.model, profile?.variant ?? null)
  const businessStoreParent = join(appHome, 'opencode-stores', 'business')
  const sourceBefore = await scanOpencodeProjectSurface(ctx.worktreePath)
  const canonicalWorktree = sourceBefore.canonicalWorktree
  const gitCommonDirs = await resolveGitCommonDirs(ctx.repoWorktreePaths, canonicalWorktree)
  if (
    canonicalWorktree === businessStoreParent ||
    canonicalWorktree.startsWith(`${businessStoreParent}/`)
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const mode = ctx.resumeSessionId === undefined ? 'new' : 'resume'
  const owner = ctx.opencodeResumeOwner
  if (
    (mode === 'resume' && (owner === undefined || owner.sessionId !== ctx.resumeSessionId)) ||
    (mode === 'new' && owner !== undefined)
  ) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }
  const storeKey = safeStoreKey(
    owner?.sessionStoreKey ?? `b_${randomBytes(32).toString('base64url')}`,
  )
  const storeRoot = join(appHome, 'opencode-stores', 'business', storeKey)
  const sealRoot = join(ctx.runRoot, 'opencode-identity-seal')
  const binaryPath = join(sealRoot, 'bin', 'opencode')
  const manifestPath = join(ctx.runRoot, 'opencode-verified-manifest.json')
  const fffProbeRoot = join(ctx.runRoot, 'opencode-fff-probe')
  const ackPath = join(ctx.runRoot, 'opencode-control.ack')
  const scratchPath = join(ctx.runRoot, 'opencode-scratch')
  const plannedLayout = deriveHermeticOpencodeLayout(storeRoot)
  const frozenSkillPaths: string[] = []
  const plannedSkills: Array<{
    name: string
    skillId: string
    sourcePath: string
    target: string
    contentVersion: number
    readContentVersion: () => Promise<number>
    inspection: ManagedSkillTreeInspection
  }> = []
  let persona = ctx.agent.bodyMd
  if (ctx.injectedMemoryBlock !== null) persona += `\n\n${ctx.injectedMemoryBlock}`

  const instructionPath = join(canonicalWorktree, 'AGENTS.md')
  const instructionStat = await lstat(instructionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (instructionStat !== null) {
    const instruction = await readFrozenInstruction(canonicalWorktree, instructionPath)
    persona = appendFrozenBlock(
      persona,
      'instruction',
      'AGENTS.md',
      instruction.digest,
      instruction.text,
    )
  }

  const skillTargets = new Set<string>()
  for (const skill of ctx.skills) {
    if (
      skill.sourcePath === undefined ||
      skill.skillId === undefined ||
      skill.contentVersion === undefined ||
      skill.readContentVersion === undefined
    ) {
      return executionIdentityFailure('execution-identity-skill-mismatch')
    }
    const target = join(sealRoot, 'skills', shaName(skill.skillId))
    if (skillTargets.has(target)) {
      return executionIdentityFailure('execution-identity-skill-mismatch')
    }
    skillTargets.add(target)
    const inspection = await inspectManagedSkillTree({
      sourcePath: skill.sourcePath,
      expectedContentVersion: skill.contentVersion,
      readContentVersion: skill.readContentVersion,
    })
    frozenSkillPaths.push(target)
    plannedSkills.push({
      name: skill.name,
      skillId: skill.skillId,
      sourcePath: skill.sourcePath,
      target,
      contentVersion: skill.contentVersion,
      readContentVersion: skill.readContentVersion,
      inspection,
    })
    persona = appendFrozenBlock(
      persona,
      'skill',
      skill.name,
      inspection.treeDigest,
      inspection.skillMarkdown,
    )
  }

  const realHome = safeAbsoluteHome(process.env.HOME)
  const shellDir = join(sealRoot, 'shell')
  const shellPath = join(shellDir, 'sh')
  const shellManifestPath = join(shellDir, 'netless.json')
  const sourceEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(ctx.gitUserName == null ? {} : { GIT_AUTHOR_NAME: ctx.gitUserName }),
    ...(ctx.gitUserEmail == null ? {} : { GIT_AUTHOR_EMAIL: ctx.gitUserEmail }),
    ...(ctx.gitUserName == null ? {} : { GIT_COMMITTER_NAME: ctx.gitUserName }),
    ...(ctx.gitUserEmail == null ? {} : { GIT_COMMITTER_EMAIL: ctx.gitUserEmail }),
  }
  const plannedMcp = await planMcpConfig(ctx, { sealRoot })
  const controlledConfig = buildControlledOpencodeConfig({
    name: ctx.agent.name,
    prompt: persona,
    description: ctx.agent.description,
    model: `${selectedModel.providerID}/${selectedModel.modelID}`,
    variant: selectedModel.variant,
    temperature: profile?.temperature,
    steps: profile?.steps ?? profile?.maxSteps,
    options: { outputs: ctx.agent.outputs as unknown as IdentityJson },
    userPermission: ctx.agent.permission as Record<string, IdentityJson>,
    toolOutputPattern: join(plannedLayout.xdgData, 'opencode', 'tool-output', '*'),
    shellPath,
    allowShell: ctx.agent.permission.bash !== 'deny',
    mcp: plannedMcp.config,
  })
  const auth = await resolveStrictProviderAuth(selectedModel.providerID, sourceEnv)
  const username = `aw-${randomBytes(12).toString('base64url')}`
  const password = randomBytes(32).toString('base64url')
  const serverEnv = buildHermeticServerEnv({
    layout: plannedLayout,
    providerID: selectedModel.providerID,
    auth,
    config: controlledConfig,
    username,
    password,
    sourceEnv,
  })
  serverEnv.PWD = canonicalWorktree
  const buildDigest = (await (dependencies.inspectBinary ?? inspectRuntimeOpencodeBinary)(command))
    .digest
  const createdNodeRunId = owner?.createdNodeRunId ?? ctx.nodeRunId
  const title = `agent-workflow:rfc224:${createdNodeRunId}`
  const sessionContractDigest = identityDigest({
    directory: canonicalWorktree,
    path: '',
    title,
    agent: ctx.agent.name,
    model: selectedModel,
    permission: ROOT_SESSION_PERMISSION_RULES,
    parentID: null,
    workspaceID: null,
    share: null,
    revert: null,
    metadata: null,
  })
  const currentIdentityDigest = businessOpencodeIdentityDigest({
    config: controlledConfig,
    agent: ctx.agent.name,
    model: selectedModel,
    binaryDigest: buildDigest,
    sealRoot,
  })

  // Resume owner rows are preclaimed by the runner. Compare every immutable
  // field that can be locally reconstructed before mkdir/chmod/store/layout or
  // wrapper materialization. The remaining owner-only identifiers are checked
  // for a valid frozen value and then rechecked by the launcher marker barrier.
  if (
    owner !== undefined &&
    (owner.sessionId !== ctx.resumeSessionId ||
      owner.taskId !== taskId ||
      owner.nodeId !== nodeId ||
      owner.createdNodeRunId !== createdNodeRunId ||
      owner.createdNodeRunId.length === 0 ||
      owner.identityDigest !== currentIdentityDigest ||
      owner.runtimeBinaryDigest !== buildDigest ||
      owner.protocolCodec !== OPENCODE_DIRECT_PROTOCOL_CODEC ||
      owner.sessionContractDigest !== sessionContractDigest ||
      owner.sessionStoreKey !== storeKey ||
      owner.projectId.length === 0)
  ) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }

  // A resume identity mismatch must be a read-only failure: only after every
  // immutable owner field is reconstructed and matched may the builder chmod
  // its run root, create scratch space, or touch the persistent-store parent.
  await Promise.all([ensurePrivateRunRoot(ctx.runRoot), ensurePrivateRunRoot(businessStoreParent)])
  await mkdir(scratchPath, { recursive: true, mode: 0o700 })

  let succeeded = false
  try {
    const core = await buildVerifiedOpencodePlan({
      admission,
      appHome,
      command,
      storeRoot,
      binaryPath,
      fffProbeRoot,
      expectedBinaryDigest: buildDigest,
      dependencies,
    })
    const { layout, containment, childProvider, fffCapability } = core
    const needsToolchain =
      ctx.agent.permission.bash !== 'deny' || plannedMcp.localWrappers.length > 0
    const toolchain = needsToolchain
      ? await snapshotBusinessToolchain(sealRoot, dependencies)
      : null
    if (needsToolchain && toolchain === null) {
      ctx.log.warn('business-toolchain-bun-unavailable', { nodeRunId: ctx.nodeRunId })
    }
    if (identityDigest(layout) !== identityDigest(plannedLayout)) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    for (const planned of plannedSkills) {
      const frozen = await snapshotManagedSkillTree({
        sourcePath: planned.sourcePath,
        snapshotPath: planned.target,
        expectedContentVersion: planned.contentVersion,
        readContentVersion: planned.readContentVersion,
      })
      if (
        frozen.treeDigest !== planned.inspection.treeDigest ||
        frozen.contentVersion !== planned.inspection.contentVersion ||
        frozen.skillMarkdown !== planned.inspection.skillMarkdown ||
        identityDigest(frozen.entries) !== identityDigest(planned.inspection.entries)
      ) {
        return executionIdentityFailure('execution-identity-skill-mismatch')
      }
    }
    await materializeNetlessWrapper({
      wrapperPath: shellPath,
      manifestPath: shellManifestPath,
      manifest: {
        codec: 1,
        mode: 'shell',
        provider: childProvider,
        worktreePath: canonicalWorktree,
        scratchPath,
        appHome,
        realHome,
        gitCommonDirs,
        bindReadOnly: [...new Set([...frozenSkillPaths, ...(toolchain?.executablePaths ?? [])])],
        env: {
          ...netlessBaseEnv(layout, sourceEnv, toolchain?.path),
          PWD: canonicalWorktree,
        },
        command: ['/bin/sh'],
      },
    })
    await materializeMcpWrappers({
      planned: plannedMcp,
      childProvider,
      layout,
      appHome,
      realHome,
      scratchPath,
      worktreePath: canonicalWorktree,
      frozenSkillPaths,
      sourceEnv,
      gitCommonDirs,
      toolchain,
    })
    const sourceAfter = await scanOpencodeProjectSurface(canonicalWorktree)
    assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
    const manifest: VerifiedLaunchManifest = {
      codec: VERIFIED_LAUNCH_MANIFEST_CODEC,
      protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
      binaryPath,
      binaryDigest: buildDigest,
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
      runRoot: ctx.runRoot,
      sessionDbPath: plannedLayout.sessionDbPath,
      sessionStoreKey: storeKey,
      storeKind: 'business',
      serverEnv,
      expectedConfig: controlledConfig,
      selectedAgent: ctx.agent.name,
      selectedModel,
      prompt: ctx.prompt,
      sourceFingerprintDigest: sourceBefore.digest,
      mode,
      ...(owner === undefined
        ? {}
        : {
            expectedSessionId: owner.sessionId,
            expectedProjectId: owner.projectId,
          }),
      createdNodeRunId,
      nodeRunId: ctx.nodeRunId,
      taskId,
      nodeId,
      sessionTitle: title,
      sessionContractDigest,
      identityDigest: currentIdentityDigest,
      ...(fffCapability === null
        ? {}
        : {
            fffCapabilityCodec: fffCapability.codec,
            fffProbe: fffCapability.probe,
          }),
      controlAckPath: ackPath,
      leaseNonce: nonce,
      leaseNonceDigest: nonceDigest,
      inventory: buildVerifiedInventoryPlan({
        enabled: ctx.wantsInventory,
        frozenSkills: plannedSkills.map((skill) => ({
          name: skill.name,
          skillId: skill.skillId,
          treeDigest: skill.inspection.treeDigest,
        })),
        mcps: ctx.mcps,
      }),
      bootstrapTimeoutMs: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    }
    await writeVerifiedLaunchManifest(manifestPath, manifest)
    const sandboxTopology = preparedContainment.spawnTopology
    succeeded = true
    return {
      cmd: verifiedLauncherCommand(manifestPath),
      env: {},
      stdin: { mode: 'ignore' },
      sandboxTopology,
      readOnlySubtrees: [sealRoot, ...layout.configRoots, ...core.readOnlySubtrees],
      sessionStore: { root: storeRoot, dbPath: layout.sessionDbPath, persistent: true },
      control: {
        kind: 'opencode-session',
        mode,
        nonce,
        leaseNonceDigest: nonceDigest,
        ackPath,
        ...(owner === undefined ? {} : { expectedSessionId: owner.sessionId }),
        identityDigest: currentIdentityDigest,
        runtimeBinaryDigest: buildDigest,
        protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
        sessionContractDigest,
        sessionStoreKey: storeKey,
        createdNodeRunId,
      },
      diagnostics: {
        verifiedIdentity: true,
        containmentProviderId: containment.providerId,
        containmentMode: containment.mode,
        containmentCapabilities: containment.capabilities,
        containmentDegradedReasons: containment.degradedReasons,
        runnerSandboxed:
          sandboxTopology === 'runner-outer' && containment.mode !== 'off' && containment.available,
        inlineModel: `${selectedModel.providerID}/${selectedModel.modelID}`,
        inlineVariant: selectedModel.variant ?? null,
        mcpCount: Object.keys(plannedMcp.config).length,
        pluginCount: 0,
      },
      cleanup: async () => {
        await assertOpencodeStoreUnlocked(layout.sessionDbPath)
        await rm(manifestPath, { force: true }).catch(() => {})
        await rm(ackPath, { force: true }).catch(() => {})
        await removeSealedTree(fffProbeRoot).catch(() => {})
        await removeSealedTree(sealRoot).catch(() => {})
      },
    }
  } finally {
    if (!succeeded) {
      await rm(manifestPath, { force: true }).catch(() => {})
      await rm(ackPath, { force: true }).catch(() => {})
      await removeSealedTree(fffProbeRoot).catch(() => {})
      await removeSealedTree(sealRoot).catch(() => {})
      if (mode === 'new') await removeHermeticOpencodeLayout(storeRoot).catch(() => {})
    }
  }
}
