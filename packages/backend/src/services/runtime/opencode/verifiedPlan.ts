// RFC-224 — parent-side verified OpenCode plan assembly. Production execution
// enters the hidden direct-API launcher; the legacy CLI builder remains only
// behind explicit test dependency injection.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readConfig } from '@/config'
import { Paths } from '@/util/paths'
import type { BusinessNodeSpawnContext, SpawnPlan } from '../types'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  deriveHermeticOpencodeLayout,
  machineConfigDeclaredPluginCount,
  removeHermeticOpencodeLayout,
  type HermeticOpencodeLayout,
} from './hermetic'
import { pluginFileSpec, selectShippedPlugins } from './pluginSpec'
import {
  inheritsMachineOpencodeConfig,
  resolveProviderCredential,
  type CustomProviderPlanDependencies,
} from './customProvider'
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
  netlessInvocationCommand,
  sanitizeMcpAuthoredEnvironment,
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
  canonicalExecutable,
  resolveInterpreterChain,
  resolveNetlessGitCommonDirs,
} from '../netlessProjection'
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
import { assertOpencodeStoreUnlocked } from './storeHygiene'
import { buildVerifiedInventoryPlan } from './verifiedInventory'
import { platformHomeEnvForHost, EXECUTABLE_SUFFIX_FOR_HOST } from '@/util/platformExec'
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

/**
 * RFC-242 — the Git projection, the `contained` predicate and the private
 * directory fence now live in ONE runtime-neutral module (`netlessProjection`)
 * shared with the Claude local-MCP fence. The duplicate that used to sit in
 * `claudeCode/netlessMcp.ts` had silently dropped three of the checks below,
 * which is exactly the drift a second copy invites.
 */
async function resolveGitCommonDirs(
  repoWorktreePaths: readonly string[] | undefined,
  canonicalPrimaryWorktree: string,
): Promise<string[]> {
  return resolveNetlessGitCommonDirs({
    repoWorktreePaths,
    primaryWorktree: canonicalPrimaryWorktree,
    // A verified OpenCode business plan always runs in a real repository; a
    // worktree Git cannot describe is a source-integrity failure, not a
    // capability to drop.
    undescribableRepo: 'fail-closed',
  })
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
  /** Administrator-declared toolchain DIRECTORIES, exposed read-only. */
  readOnlyDirs: string[]
  path: string
}

export interface VerifiedBusinessPlanDependencies extends VerifiedOpencodePlanDependencies {
  /** Resolve optional model-facing tools without trusting the child environment's PATH. */
  resolveToolchainBinary?: (token: string) => string | null
  /** Freeze a resolved tool into the private per-run seal before exposing it. */
  snapshotToolchainBinary?: typeof snapshotRuntimeOpencodeBinary
  /**
   * Test seam for the administrator-declared toolchain directories. Production
   * reads the real daemon config (same shape as RFC-255's provider seam).
   */
  loadBusinessToolchainPaths?: () => readonly string[]
  /** RFC-255 — inject the daemon config / secret key for custom providers. */
  customProvider?: CustomProviderPlanDependencies
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
  const executablePaths: string[] = []
  const pathEntries: string[] = []
  if (sourcePath !== null) {
    const snapshotPath = join(sealRoot, 'toolchain', 'bun')
    try {
      const snapshot = await (
        dependencies.snapshotToolchainBinary ?? snapshotRuntimeOpencodeBinary
      )({ command: [sourcePath], snapshotPath })
      if (snapshot.snapshotPath === snapshotPath && /^[0-9a-f]{64}$/.test(snapshot.digest)) {
        executablePaths.push(snapshotPath)
        pathEntries.push(dirname(snapshotPath))
      }
    } catch {
      // Missing/unsealable Bun stays non-fatal (a compiled deployment may not
      // ship it); the administrator toolchain below is independent of it.
    }
  }
  // 2026-08-04 audit: without this the fenced child's PATH is `/usr/bin:/bin`
  // plus the sealed Bun, so `node` / `npm` / `cargo` / any version-manager shim
  // are absent and the model gets a bare 127. These directories are exposed
  // read-only and only because an administrator listed them.
  const readOnlyDirs: string[] = []
  const declared =
    // `readConfig`, never `loadConfig`: the latter MATERIALIZES a defaults file
    // when none exists, and this runs on every business spawn — a plan builder
    // must not create `~/.agent-workflow/config.json` as a side effect. (The
    // full suite caught it: the write leaked across test files sharing appHome.)
    dependencies.loadBusinessToolchainPaths?.() ??
    readConfig(Paths.config)?.businessToolchainPaths ??
    []
  for (const entry of declared) {
    // Re-check at spawn time: the schema validated the SHAPE when it was
    // written, but the directory can disappear afterwards, and binding a
    // missing source aborts the whole child spawn.
    if (!isAbsolute(entry) || resolve(entry) !== entry) continue
    let real: string
    try {
      const metadata = await lstat(entry)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue
      real = await realpath(entry)
    } catch {
      continue
    }
    if (readOnlyDirs.includes(real)) continue
    readOnlyDirs.push(real)
    pathEntries.push(real)
  }
  if (executablePaths.length === 0 && readOnlyDirs.length === 0) return null
  return {
    executablePaths,
    readOnlyDirs,
    path: [...pathEntries, FIXED_NETLESS_PATH].join(':'),
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
  /** The `#!` chain the executable needs at exec time (RFC-242 shape). */
  interpreters: readonly string[]
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
  input: {
    sealRoot: string
    /** Daemon env — the only sane PATH for resolving a bare command token. */
    sourceEnv: Readonly<Record<string, string | undefined>>
    /** Base for a worktree-relative command token (the cwd it will run in). */
    canonicalWorktree: string
  },
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
    if (command.length === 0 || command.some((entry) => entry.length === 0)) {
      return executionIdentityFailure('execution-identity-mismatch')
    }
    // 2026-08-04 audit: this used to REJECT any non-absolute command head, so
    // the officially documented MCP shape (`npx -y @modelcontextprotocol/…`)
    // saved fine and then failed EVERY run with an unreadable
    // `execution-identity-mismatch`; and binding only the launcher's own inode
    // made an absolute `#!/usr/bin/env node` launcher exit 127 inside the fence
    // (opencode logged the server as failed and the node still "finished",
    // silently missing its tools). RFC-242 already solved both for Claude —
    // share that resolution instead of keeping a weaker second variant.
    const executable = await canonicalExecutable(
      command[0]!,
      input.sourceEnv,
      input.canonicalWorktree,
    )
    const interpreters = await resolveInterpreterChain(executable, input.sourceEnv)
    const args = command.slice(1)
    // Reject dangerous MCP-authored env before an owner mismatch can touch
    // the persistent store. The full semantic descriptor becomes the stable
    // wrapper suffix, so resume identity changes for executable/argv/env/
    // timeout without depending on this attempt's runRoot.
    // RFC-242: MCP-authored env follows the MCP rule. The daemon-env allowlist
    // this used to call SILENTLY DROPPED any name it did not recognize, so a
    // server configured with `token`/`apiKey` started without its credential
    // and failed in a way no log explained.
    const configuredEnv = sanitizeMcpAuthoredEnvironment(mcp.config.env ?? {}, mcp.name)
    const wrapperIdentity = identityDigest({
      codec: 1,
      name: mcp.name,
      executable,
      interpreters,
      args,
      configuredEnv,
      timeoutMs: mcp.config.timeoutMs ?? null,
    })
    const wrapperDir = join(input.sealRoot, 'mcp', wrapperIdentity)
    const wrapperPath = join(wrapperDir, 'run')
    const wrapperManifestPath = join(wrapperDir, 'netless.json')
    localWrappers.push({
      executable,
      interpreters,
      args,
      wrapperPath,
      wrapperManifestPath,
      configuredEnv,
    })
    result[mcp.name] = {
      type: 'local',
      enabled: true,
      // RFC-254 T14b: shape comes from the shared helper, so the config block
      // and the materializer cannot drift apart across platforms.
      command: netlessInvocationCommand(wrapperPath, wrapperManifestPath),
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
      // The interpreters' directories must be reachable too — same reason the
      // Claude fence assembles its PATH this way.
      PATH: [
        ...new Set(wrapper.interpreters.map((entry) => dirname(entry))),
        input.toolchain?.path ?? FIXED_NETLESS_PATH,
      ].join(':'),
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
          ...(input.toolchain?.readOnlyDirs ?? []),
          wrapper.executable,
          // Without the interpreters the fence exposes only the launcher's own
          // inode, and an `#!/usr/bin/env node` launcher exits 127 inside it.
          ...wrapper.interpreters,
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
  // RFC-251 removed the plugin and dependent-agent rejections that stood here.
  // Both are now assembled into the controlled config instead: plugins via
  // `buildPluginSpecArray`, the dependsOn closure via the agent registry.
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
  const binaryPath = join(sealRoot, 'bin', `opencode${EXECUTABLE_SUFFIX_FOR_HOST}`)
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
  // RFC-251 §10.3: `ctx.skills` is the dependsOn closure UNION (scheduler
  // `resolveClosureSkills`), but only the root persona used to receive the
  // frozen SKILL.md blocks — a closure member got a bare `bodyMd` while the
  // `skill` tool is denied, so the agent that actually does the audit could not
  // see the audit skill it declared. Index the frozen blocks by skill id so
  // each member can be given back exactly the ones IT declared.
  const frozenSkillBlockById = new Map<string, { name: string; digest: string; markdown: string }>()
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
    frozenSkillBlockById.set(skill.skillId, {
      name: skill.name,
      digest: inspection.treeDigest,
      markdown: inspection.skillMarkdown,
    })
  }

  // RFC-254 T11b: Windows populates USERPROFILE, not HOME. Reading HOME alone
  // makes every verified plan fail to assemble on a stock Windows install.
  const realHome = safeAbsoluteHome(platformHomeEnvForHost())
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
  const plannedMcp = await planMcpConfig(ctx, { sealRoot, sourceEnv, canonicalWorktree })
  // RFC-251: the exact plugin records that reach OpenCode (enabled-filtered,
  // id-deduped). Inventory and diagnostics describe THIS set, so they cannot
  // drift from what the controlled config actually ships.
  const shippedPlugins = selectShippedPlugins(ctx.plugins)
  // RFC-251: each selected plugin's private install root (`plugins/<id>`, see
  // pluginInstaller). Only rows whose cachedPath actually lives under that root
  // need a bind — a `file:` spec resolves outside appHome and is already
  // visible through the `--bind / /` base mount.
  const pluginReadOnlyRoots = [
    ...new Set(
      shippedPlugins
        .map((plugin) => join(appHome, 'plugins', plugin.id))
        .filter((root, index) => {
          const cached = shippedPlugins[index]!.cachedPath
          return cached === root || cached.startsWith(`${root}/`)
        }),
    ),
  ]
  // RFC-251: every closure member resolves its OWN runtime profile — a missing
  // or malformed model fails loudly here rather than silently inheriting the
  // root's. Members keep their raw `bodyMd`: the output-envelope protocol block
  // belongs to the node's selected agent, not to agents it delegates to (same
  // split the legacy inline path uses in `buildInlineAgentEntry`).
  const controlledDependents = ctx.dependents.map((dep) => {
    const depProfile = ctx.resolvedParamsByAgent.get(dep.name)
    const depModel = parseSelectedModel(depProfile?.model, depProfile?.variant ?? null)
    // RFC-251 §10.3: give the member back the frozen SKILL.md blocks for the
    // skills IT declared. The root keeps receiving the whole union (unchanged —
    // narrowing that is a separate product decision), so this is additive.
    let depPrompt = dep.bodyMd
    for (const ref of dep.skills) {
      // Only `managed` reaches the verified path at all (repo/global skills are
      // rejected upstream), so a non-managed ref here means the member declared
      // something this path never sealed.
      if (ref.kind !== 'managed') {
        return executionIdentityFailure('execution-identity-skill-mismatch')
      }
      const block = frozenSkillBlockById.get(ref.skillId)
      // The scheduler unions every member's skills into ctx.skills, so a miss is
      // a real closure/seal inconsistency — fail closed rather than silently
      // handing the member a prompt without the skill it asked for.
      if (block === undefined) {
        return executionIdentityFailure('execution-identity-skill-mismatch')
      }
      depPrompt = appendFrozenBlock(depPrompt, 'skill', block.name, block.digest, block.markdown)
    }
    return {
      name: dep.name,
      prompt: depPrompt,
      description: dep.description,
      model: `${depModel.providerID}/${depModel.modelID}`,
      variant: depModel.variant,
      temperature: depProfile?.temperature,
      steps: depProfile?.steps ?? depProfile?.maxSteps,
      options: { outputs: dep.outputs as unknown as IdentityJson },
      userPermission: dep.permission as Record<string, IdentityJson>,
      allowShell: dep.permission.bash !== 'deny',
    }
  })
  const inheritMachineConfig = inheritsMachineOpencodeConfig(dependencies.customProvider)
  // RFC-255: resolved BEFORE the config is built — a custom gateway contributes
  // a `provider` section to that config, and a disabled one must fail here
  // rather than fall through to the generic credential channels.
  const credential = await resolveProviderCredential(
    selectedModel.providerID,
    sourceEnv,
    dependencies.customProvider,
  )
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
    // RFC-251: the resolved plugin closure (union over dependsOn) reaches the
    // controlled config again. buildHermeticServerEnv derives OPENCODE_PURE
    // from the result, so a non-empty selection also turns that flag off.
    plugins: ctx.plugins,
    dependents: controlledDependents,
    customProvider: credential.customProvider,
  })
  const auth = credential.auth
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
    inheritMachineConfig,
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
        bindReadOnly: [
          ...new Set([
            ...frozenSkillPaths,
            ...(toolchain?.executablePaths ?? []),
            ...(toolchain?.readOnlyDirs ?? []),
          ]),
        ],
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
        // RFC-251: the sealed file:// specifiers actually shipped, paired with
        // the record's sourceKind — never the user-supplied npm/git spec.
        plugins: shippedPlugins.map((plugin) => ({
          specifier: pluginFileSpec(plugin),
          source: plugin.sourceKind,
        })),
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
      // RFC-251 (Codex impl-gate #4, confirmed on real Linux/bubblewrap 0.11.0):
      // the linux sandbox denies the WHOLE appHome with a tmpfs and binds back
      // only what a run needs, so the plugin cache did not exist inside the
      // namespace at all and every `file://<cachedPath>` import got ENOENT.
      // Bind back exactly the SELECTED plugins' private install roots, and only
      // read-only — the model must never be able to rewrite plugin code.
      readOnlyAllowSubtrees: pluginReadOnlyRoots,
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
        // RFC-256: the operator's own OpenCode config is readable again, but
        // plugins declared there are still not loaded. Report the count so that
        // limit is visible in the run log instead of looking like a silent
        // no-op (0 when inheritance is off or nothing is declared).
        machineConfigIgnoredPlugins: inheritMachineConfig
          ? machineConfigDeclaredPluginCount(
              join(safeAbsoluteHome(sourceEnv.HOME), '.config', 'opencode'),
            )
          : 0,
        mcpCount: Object.keys(plannedMcp.config).length,
        // RFC-251: report the encoded selection, not a structural zero.
        pluginCount: shippedPlugins.length,
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
