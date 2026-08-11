// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.

import type {
  AgentInjectionSpecV1,
  AgentSpawnContext,
  AgentSpawnPlan,
  BusinessNodeSpawnContext,
  DistillSessionCaptureContext,
  InventoryReadContext,
  NormalizedEvent,
  ProbeOpts,
  RenderedInjectionV1,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  SessionCaptureContext,
  SpawnPlan,
  SystemAgentSessionSweepContext,
  SystemAgentSpawnContext,
  ListModelsOpts,
} from '../types'
import {
  declarePlugins,
  declareSkills,
  declareSubagents,
  emptyDeclaredManifest,
  renderOpencodeAgentEntry,
  renderOpencodeMcpInjection,
  weaveMemoryBlock,
} from '@/services/execution/agentInjection'
import type { InventorySnapshot } from '@agent-workflow/shared'
import type { LivePollOptions, LivePollerHandle } from './subagentLiveCapture'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { observeSystemEvent, parseEvent } from './events'
import { buildOpencodeSpawn } from './spawn'
import { buildInlineConfig } from './inlineConfig'
import { selectShippedPlugins } from './pluginSpec'
import type { BoundaryCtx } from '@/services/execution/workspaceBoundary'
import { machineSkillRoots, opencodeDataDir } from './boundary'
import { pickRuntimeHead } from '../head'
import { toBusinessCtx, toSystemCtx } from '../spawnCtx'
import { stageSkills } from '../stageSkills'
import { probeOpencode } from './util'
import { gitMetaDirsFor } from '@/util/git'
import { getOpencodeBinaryVersion } from './versionRegistry'
import { listOpencodeModelsNatural } from './models'
import { captureChildSessions, captureOpencodeSessionsToSink } from './sessionCapture'
import { readSnapshotFromRunDir } from './inventory'
import { startLiveSubagentCapture } from './subagentLiveCapture'
import { materializeInventoryPlugin } from './plugin'
import { captureDistillJobSession } from './distillSessionCapture'

/** RFC-282 — the declaration render, driver-internal assembly (was the
 * RuntimeDriver.renderInjection contract method; the contract now has ONE
 * assembly method and this is a building block of it). */
export function renderOpencodeInjection(spec: AgentInjectionSpecV1): RenderedInjectionV1 {
  const { entries, declared } = renderOpencodeMcpInjection(spec.mcps)
  declared.skills = declareSkills(spec.skills ?? [])
  declared.subagents = declareSubagents(spec.agent?.name ?? '', spec.dependents ?? [])
  declared.plugins = declarePlugins(spec.plugins ?? [])
  // RFC-280 T3: the inventory reports plugin SPECIFIERS (file:// paths), not
  // platform names — the plugins face cannot be diffed and must read as
  // "cannot verify", never as "verified" (design §2.3).
  if (declared.plugins.length > 0) declared.unobservable = ['plugins']
  return { mcpEntries: entries, declared }
}

/** RFC-282 — persona-only assembly body (was the legacy system
 * RuntimeDriver.buildSpawn); reached only through the unified buildSpawn. */
export async function assembleOpencodePersonaSpawn(
  ctx: SystemAgentSpawnContext,
): Promise<SpawnPlan> {
  const envBin = process.env.AGENT_WORKFLOW_OPENCODE_BIN
  const head =
    ctx.opencodeCmd !== undefined && ctx.opencodeCmd.length > 0
      ? [...ctx.opencodeCmd]
      : ctx.runtimeBinary != null && ctx.runtimeBinary !== ''
        ? [ctx.runtimeBinary]
        : envBin != null && envBin !== ''
          ? [envBin]
          : ['opencode']
  const personaEntry = renderOpencodeAgentEntry(
    {
      name: ctx.agentName,
      description: '',
      bodyMd: ctx.systemPrompt,
      permission: {},
      outputs: [],
    } as unknown as Parameters<typeof renderOpencodeAgentEntry>[0],
    {
      model: ctx.model != null && ctx.model !== '' ? ctx.model : null,
      variant: ctx.variant ?? null,
      temperature: ctx.temperature ?? null,
      steps: ctx.steps ?? null,
      maxSteps: ctx.maxSteps ?? null,
      isSandbox: ctx.isSandbox === true,
    },
  )
  const inlineConfig: {
    agent: Record<string, Record<string, unknown>>
    mcp?: Record<string, Record<string, unknown>>
    plugin?: Array<string | [string, Record<string, unknown>]>
  } = { agent: { [ctx.agentName]: personaEntry } }
  if (ctx.mcpInjection !== undefined && ctx.mcpInjection.mcpEntries !== null) {
    inlineConfig.mcp = ctx.mcpInjection.mcpEntries
  }
  // RFC-154 config-dir profile (playground threads the runtime row's frozen
  // leaf/env; pre-RFC-280 system callers omit both → byte-identical spawn).
  const runConfigDir =
    ctx.configDirName != null && ctx.configDirName !== ''
      ? join(ctx.runDir, ctx.configDirName)
      : ctx.runDir
  if (runConfigDir !== ctx.runDir) mkdirSync(runConfigDir, { recursive: true, mode: 0o700 })
  // RFC-280 T6 (P1-4): the playground's observation source. Materialization
  // failure is fatal HERE (unlike the business best-effort path) — a strict
  // consumer would otherwise run blind and fail-open.
  let inventoryOutPath: string | undefined
  if (ctx.wantsInventory === true) {
    mkdirSync(ctx.runDir, { recursive: true })
    const pluginPath = await materializeInventoryPlugin(ctx.runDir)
    inlineConfig.plugin = [`file://${pluginPath}`]
    inventoryOutPath = join(ctx.runDir, 'inventory.json')
  }
  // RFC-143 PR-4: the AGENT_WORKFLOW_OPENCODE_BIN env override (previously a
  // `protocol === 'opencode'` branch in memoryDistiller) is internalized here:
  // a system-agent run with NO explicit binary falls back to it before the
  // built-in `opencode` head. Callers that pass a binary (smoke probes, custom
  // forks) are unaffected. claude has no analogous override.
  const { cmd, env } = buildOpencodeSpawn({
    opencodeCmd: head,
    // A known pre-1.18 binary receives the old spelling; an unprobed current
    // binary defaults to `--auto` in buildOpencodeSpawn.
    binaryVersion: getOpencodeBinaryVersion(head[0] ?? 'opencode'),
    agentName: ctx.agentName,
    prompt: ctx.prompt,
    worktreePath: ctx.worktreePath,
    runDir: runConfigDir,
    ...(ctx.configDirEnv != null && ctx.configDirEnv !== ''
      ? { configDirEnv: ctx.configDirEnv }
      : {}),
    inlineConfigSerialized: JSON.stringify(inlineConfig),
    ...(inventoryOutPath !== undefined ? { inventoryOutPath } : {}),
    ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
      ? { resumeSessionId: ctx.resumeSessionId }
      : {}),
    gitUserName: ctx.gitUserName ?? null,
    gitUserEmail: ctx.gitUserEmail ?? null,
  })
  return { cmd, env, stdin: { mode: 'ignore' } }
}

/** RFC-282 — business assembly body (was RuntimeDriver.buildBusinessSpawn);
 * reached only through the unified buildSpawn. */
export async function assembleOpencodeBusinessSpawn(
  ctx: BusinessNodeSpawnContext,
): Promise<SpawnPlan> {
  const businessHead = pickRuntimeHead(ctx.runtimeBinary, ctx.opencodeCmd)
  // RFC-154: stage framework skills into THIS runtime's config dir (leaf name
  // from the frozen profile; was the runner's runtime-blind `.opencode`
  // preamble). Strict mode: a staging failure fails the spawn (runner §6 maps
  // the throw to runtime-spawn-failed) — a silently missing skill is worse.
  const runDir = join(ctx.runRoot, ctx.configDir.name)
  stageSkills(runDir, ctx.skills, ctx.log)

  // RFC-281 T1: task workspace boundary. Re-allow set = this task's mounts +
  // the run config dir (staged skills live under <runDir>/skills, already
  // covered by runDir) + opencode's tmp. composeOpencodeBoundary denies
  // everything else outside cwd, and `--auto` cannot flip a deny (design §5
  // E2/E4). System persona spawns (renderOpencodeAgentEntry above) get NO
  // boundary — RFC-281 §3 keeps the system surface unfenced in v1.
  // 每个 mount 的 git 元数据目录。opencode 的 `git` 走 bash、不经
  // external_directory（实测 commit 全链通过），但**文件工具**读
  // `.git/config`、`.git/HEAD` 这类会被判定为越界 —— agent 排查分支/远端配置
  // 时会撞上。放行它们与放行 worktree 本身同级（都是本任务的 git 数据）。
  // `?? []`：taskMounts 生产必填，但缺它绝不能让整个 spawn 崩掉（§0）——
  // 少一条放行只是少一层边界，抛异常却是节点直接起不来。
  const gitMetaDirs = (
    await Promise.all((ctx.taskMounts ?? []).map((m) => gitMetaDirsFor(m)))
  ).flat()
  const boundaryCtx: BoundaryCtx = {
    taskMounts: ctx.taskMounts,
    gitMetaDirs,
    runDir,
    // 平台 stage 的技能 + opencode 自己会发现的机器级技能根（实现门 P1-2：
    // deny 基线会遮蔽 opencode 默认白名单里的 skill.dirs()，不补回来就会
    // 出现「SKILL.md 进了 prompt，但按它读同目录脚本被拒」的半残状态）。
    stagedSkillDirs: [join(runDir, 'skills'), ...machineSkillRoots()],
    // opencode's own scratch areas, read from ITS source (packages/core/src/
    // global.ts:11,15 @1.18.16) rather than guessed:
    //   Path.tmp  = os.tmpdir()/opencode
    //   Path.data = xdgData/opencode   → tool-output/ holds truncated tool
    //                                    payloads the agent then reads back
    // opencode re-adds the tool-output glob itself at the end of its permission
    // assembly, but relying on that leaves the boundary hostage to upstream
    // ordering — list both explicitly.
    // 业务误伤检视 P1-2：deny 基线遮蔽了 opencode 默认白名单后，**通用系统临时
    // 目录**也一并被拒 —— agent 的 `mkdir -p /tmp/build`、`cp x /tmp/`、
    // `cat /tmp/prev.json`、write 工具写 `/tmp/plan.md` 全部 DeniedError（这些
    // 在 RFC-281 之前经 ask + --auto 放行）。临时目录不是「另一个任务的工作
    // 区」，放行它不违背本 RFC 目标，而不放行会让写死 /tmp 的存量 agent 直接
    // 失效（§0）。
    tmpGlobs: [
      `${tmpdir()}/*`,
      `${join(tmpdir(), 'opencode')}/*`,
      `${opencodeDataDir()}/tool-output/*`,
    ],
  }

  // RFC-022/028/031: primary + closure dependents + mcp + plugin entries.
  // RFC-281 T1: boundaryCtx re-composes every entry's external_directory +
  // emits the top-level boundary for opencode's native subagents.
  const inlineConfig = buildInlineConfig(
    ctx.agent,
    ctx.resolvedParamsByAgent,
    ctx.dependents,
    ctx.mcps,
    ctx.plugins,
    boundaryCtx,
  )

  // RFC-029: wire the inventory dump plugin (business gate — agent kind +
  // not a followup — is precomputed by the runner as `wantsInventory`; that
  // opencode is the runtime that HAS this capability is embodied right here).
  let inventoryOutPath: string | undefined
  if (ctx.wantsInventory) {
    try {
      mkdirSync(ctx.runRoot, { recursive: true })
      // materializeInventoryPlugin handles both dev (source tree) and
      // single-binary (embed table) layouts — see opencode-plugin/index.ts.
      const pluginPath = await materializeInventoryPlugin(ctx.runRoot)
      const fileSpec: string | [string, Record<string, unknown>] = `file://${pluginPath}`
      inlineConfig.plugin = [...(inlineConfig.plugin ?? []), fileSpec]
      inventoryOutPath = join(ctx.runRoot, 'inventory.json')
    } catch (err) {
      // Non-fatal: if we can't materialize the plugin (disk full / permission
      // denied / asset missing in binary mode), the run continues without
      // inventory capture and the post-exit read lands on `plugin-load-failed`.
      ctx.log.warn('inventory-plugin-materialize-failed', {
        nodeRunId: ctx.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // RFC-041: weave the injected memory block into the primary agent's inline
  // prompt (the runner resolved the block; HOW it reaches the model is ours).
  if (ctx.injectedMemoryBlock !== null) {
    const primary = inlineConfig.agent[ctx.agent.name]
    if (primary !== undefined && typeof primary.prompt === 'string') {
      primary.prompt = weaveMemoryBlock(primary.prompt, ctx.injectedMemoryBlock)
    }
  }

  // RFC-022 §design B6: warn (don't fail) when the serialized config crosses
  // the soft cap. Real OS env-var ceilings are well above this; the warning
  // helps catch authors stuffing massive bodies into every dependent agent
  // OR cramming many MCP servers' env / headers maps.
  const serializedInline = JSON.stringify(inlineConfig)
  if (serializedInline.length > 32 * 1024) {
    ctx.log.warn('inline-config-large', {
      bytes: serializedInline.length,
      agents: Object.keys(inlineConfig.agent),
      mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
    })
  }

  // RFC-112: a custom opencode fork's binary wins; else the RFC-111 head
  // (production config.opencodePath via resolveOpencodeCmd, or a test mock)
  // — byte-for-byte unchanged for built-ins.
  const { cmd, env } = buildOpencodeSpawn({
    opencodeCmd: businessHead,
    // Key = head[0] exactly as spawned and as explicit probes record it.
    binaryVersion: getOpencodeBinaryVersion(businessHead?.[0] ?? 'opencode'),
    agentName: ctx.agent.name,
    prompt: ctx.prompt,
    resumeSessionId: ctx.resumeSessionId,
    worktreePath: ctx.worktreePath,
    runDir,
    configDirEnv: ctx.configDir.env, // RFC-154: frozen env-var name
    inlineConfigSerialized: serializedInline,
    inventoryOutPath,
    gitUserName: ctx.gitUserName,
    gitUserEmail: ctx.gitUserEmail,
  })
  // §4.4: what actually landed in the inline JSON, for the runner's
  // `spawning agent runtime` diagnostic line (same fields it used to derive).
  const primaryInline = inlineConfig.agent[ctx.agent.name] as Record<string, unknown> | undefined
  return {
    cmd,
    env,
    diagnostics: {
      inlineModel: primaryInline?.model ?? null,
      inlineVariant: primaryInline?.variant ?? null,
      inlineTemperature: primaryInline?.temperature ?? null,
      mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
      mcpKeys: inlineConfig.mcp ? Object.keys(inlineConfig.mcp) : [],
      // RFC-251/RFC-282 B4: diagnostics describe exactly the SHIPPED set
      // (enabled + id-deduped), not a parallel re-derivation that drifts.
      pluginCount: selectShippedPlugins(ctx.plugins).length,
      pluginNames: selectShippedPlugins(ctx.plugins).map((p) => p.name),
    },
  }
}

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  // RFC-282 A3 — static declaration, values copied from today's behavior:
  // inventory file written by the dump plugin per FRESH run (followups have
  // nothing to read — RFC-280 实现门 P2-E), faces per renderInjection below
  // (plugins injected but key-domain-mismatched ⇒ unobservable; tools/
  // droppedParams never produced ⇒ unsupported).
  capabilities: {
    startupObservation: 'inventory-file',
    observationRequiresFreshRun: true,
    declarationFaces: {
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unobservable',
      tools: 'unsupported',
      droppedParams: 'unsupported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    },
  },
  minVersion: null,
  // RFC-280 T6 — playground session strategy (opencode: no pre-allocated id;
  // resume rides the captured session id).
  createMcpTestNativeSessionId: () => null,
  mcpTestSessionReference: ({ nativeSessionId }) =>
    nativeSessionId === null ? {} : { resumeSessionId: nativeSessionId },
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  observeSystemEvent,
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions
  // (byte-for-byte behavior); later PRs move call sites onto these.
  defaultBinary(config: RuntimeBinaryConfig): string[] {
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeOpencode(binary, opts)
  },
  // RFC-276: model discovery uses the registered binary in the operator's
  // natural cwd/environment and therefore sees the same providers and auth as
  // an ordinary OpenCode invocation.
  async listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return listOpencodeModelsNatural(binary, opts)
  },
  async captureSessions(ctx: SessionCaptureContext): Promise<void> {
    await captureChildSessions({
      rootSessionId: ctx.rootSessionId,
      nodeRunId: ctx.nodeRunId,
      taskId: ctx.taskId,
      db: ctx.db,
      log: ctx.log,
      ...(ctx.alreadyInsertedPartIds !== undefined
        ? { alreadyInsertedPartIds: ctx.alreadyInsertedPartIds }
        : {}),
      ...(ctx.opencodeDbPath !== undefined ? { opencodeDbPath: ctx.opencodeDbPath } : {}),
    })
  },
  async captureDistillSession(ctx: DistillSessionCaptureContext): Promise<void> {
    await captureDistillJobSession(ctx)
  },
  // RFC-282 B1a — the unified assembly facade: ONE call returns plan +
  // declared manifest (declaration is a by-product of assembly, 决策 2/9).
  // Byte parity with the legacy paths is the contract; the parity suite
  // (rfc282-b1a) is live while both paths exist.
  async buildSpawn(ctx: AgentSpawnContext): Promise<AgentSpawnPlan> {
    // §7-9 — the declared render keeps its own degrade path: a (defensive-
    // only) render failure downgrades the manifest to empty + warn instead of
    // failing the node; the assembly below re-renders internally and remains
    // the spawn-failing path, exactly as before the unification.
    // ⚠️ 实现门 P3-5 — on the SYSTEM face `rendered` is also the actual MCP
    // injection (toSystemCtx): if a future render gains a throwing validation,
    // this degrade would turn the playground's fail-closed into a silent
    // no-MCP run. Add a system-face carve-out here before adding such a throw.
    let rendered: RenderedInjectionV1
    try {
      rendered = renderOpencodeInjection(ctx.injection)
    } catch (err) {
      ctx.log.warn('startup-declaration-failed', {
        nodeRunId: ctx.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
      rendered = { mcpEntries: null, declared: emptyDeclaredManifest() }
    }
    const head = ctx.binaryOverride !== undefined ? { opencodeCmd: [...ctx.binaryOverride] } : {}
    if (ctx.taskMounts === undefined) {
      const plan = await assembleOpencodePersonaSpawn(toSystemCtx(ctx, rendered, head))
      return { ...plan, declared: rendered.declared }
    }
    const plan = await assembleOpencodeBusinessSpawn(toBusinessCtx(ctx, head))
    return { ...plan, declared: rendered.declared }
  },
  // —— optional capabilities (opencode implements; claude omits) ——
  async readInventory(ctx: InventoryReadContext): Promise<InventorySnapshot | null> {
    return readSnapshotFromRunDir({
      runDir: ctx.runRoot,
      nodeKind: ctx.nodeKind,
      pureMode: process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
    })
  },
  startLiveCapture(ctx: LivePollOptions): LivePollerHandle {
    return startLiveSubagentCapture(ctx)
  },
  // RFC-237 — post-exit child-session sweep for SYSTEM agents (moved verbatim
  // from the `driver.kind === 'opencode'` branch in systemAgentRun.ts).
  async captureSessionsToSink(ctx: SystemAgentSessionSweepContext) {
    return captureOpencodeSessionsToSink({
      rootSessionId: ctx.rootSessionId,
      sink: ctx.sink,
      log: ctx.log,
    })
  },
}
