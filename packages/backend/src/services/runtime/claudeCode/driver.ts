// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

import type { StartupInventory } from '../types'
import type {
  AgentInjectionSpecV1,
  AgentSpawnContext,
  AgentSpawnPlan,
  BusinessNodeSpawnContext,
  NormalizedEvent,
  ProbeOpts,
  RenderedInjectionV1,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  SessionCaptureContext,
  SpawnPlan,
  SystemAgentSpawnContext,
  ListModelsOpts,
} from '../types'
import {
  declarePlugins,
  declareSkills,
  declareSubagents,
  deriveClaudeDroppedParams,
  emptyDeclaredManifest,
  renderClaudeMcpInjection,
} from '@/services/execution/agentInjection'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import {
  parseEvent,
  observeSystemEvent,
  parseResultError,
  parseStartupInventory,
  parseUnusableMcpServers,
} from './events'
import { buildClaudeSpawn } from './spawn'
import { toClaudeAgents } from './inject'
import { pickRuntimeHead } from '../head'
import { toBusinessCtx, toSystemCtx } from '../spawnCtx'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'
import { claudeBusinessGate, claudeToolsValue } from './permissionMap'
import { gitMetaDirsFor } from '@/util/git'
import {
  claudeExpressibleAuthorDirs,
  claudeWriteBoundaryAvailability,
  scanSiblingTaskRoots,
  toolchainCacheDirs,
} from '@/services/execution/workspaceBoundary'
import {
  renderClaudeManagedSkillAttachments,
  stageClaudeWorktreeAgents,
  stageClaudeWorktreeSkills,
} from './config'

/** RFC-280 §7.1 — business-path MCP config lands on disk (0600), never argv. */
function writeBusinessMcpConfig(
  runRoot: string,
  claudeMcp: { mcpServers: Record<string, Record<string, unknown>> },
): string {
  mkdirSync(runRoot, { recursive: true })
  const file = join(runRoot, 'mcp-config.json')
  writeFileSync(file, JSON.stringify(claudeMcp), { mode: 0o600, flag: 'w' })
  return file
}

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  // RFC-282 A3 — static declaration, values copied from today's behavior:
  // init event fires on EVERY run (followups included); faces per
  // renderInjection below (plugins have no claude face ⇒ unsupported;
  // tools/droppedParams are real declared+observed faces here).
  capabilities: {
    startupObservation: 'init-event',
    observationRequiresFreshRun: false,
    declarationFaces: {
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unsupported',
      tools: 'supported',
      droppedParams: 'supported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    },
  },
  // 2026-08-04 — claude forks carry private flags (CodeAgent's
  // --skip-safe-check); the registry-validated extraArgs land at the argv tail.
  acceptsExtraArgs: true,
  // Claude CLI compatibility only; this capability does not provide platform
  // process isolation or any operating-system sandbox guarantee.
  acceptsSandboxCompatibilityMarker: true,
  minVersion: MIN_CLAUDE_CODE_VERSION,
  // RFC-280 T6 — playground session strategy (claude: pre-allocated UUID on
  // turn 1 via --session-id, resume thereafter).
  createMcpTestNativeSessionId: randomUUID,
  mcpTestSessionReference: ({ turnSeq, nativeSessionId }) => {
    if (nativeSessionId === null) throw new Error('mcp-test-native-session-missing')
    return turnSeq === 1 ? { nativeSessionId } : { resumeSessionId: nativeSessionId }
  },
  // RFC-280 T1/T2 — unified injection render. Declares every claude-visible
  // face plus what this runtime structurally lacks: selected plugins go to
  // `unsupported` (no plugin surface), and non-model profile params to
  // `droppedParams` (落差④ — the T3 warning face consumes both).
  renderInjection(spec: AgentInjectionSpecV1): RenderedInjectionV1 {
    const { entries, declared } = renderClaudeMcpInjection(spec.mcps)
    declared.skills = declareSkills(spec.skills ?? [])
    declared.subagents = declareSubagents(spec.agent?.name ?? '', spec.dependents ?? [])
    const gate = claudeBusinessGate(spec.agent?.permission)
    declared.tools = gate === null ? null : [...gate.tools]
    declared.droppedParams =
      spec.profile === undefined ? [] : deriveClaudeDroppedParams(spec.profile)
    declared.unsupported = declarePlugins(spec.plugins ?? []).map((name) => `plugin:${name}`)
    return { mcpEntries: entries, declared }
  },
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  observeSystemEvent,
  // RFC-237 (design-gate P2-4) — surface a clean-exit terminal `is_error`
  // result (auth/API failure) so systemAgentRun can fail the run instead of
  // letting it masquerade as a missing envelope.
  parseTerminalResultError(line: string): string | null {
    const parsed = parseResultError(line)
    if (parsed === null || !parsed.isError) return null
    return parsed.message.length > 0 ? parsed.message : 'claude reported a terminal error result'
  },
  // Claude freezes MCP availability on its init event; a server that is not
  // `connected` there loses its tools for the whole turn.
  parseUnusableMcpServers(line: string): readonly string[] | null {
    return parseUnusableMcpServers(line)
  },
  // 2026-08-09 — the same init event enumerates the tools, subagents and skills
  // claude actually loaded; anything the platform injected and does not find
  // there means the node cannot use what it declared.
  parseStartupInventory(line: string): StartupInventory | null {
    return parseStartupInventory(line)
  },
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions.
  defaultBinary(config: RuntimeBinaryConfig): string[] {
    return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeClaudeCode(binary, opts)
  },
  // claude has no `models` subcommand — a static table, ignores binary, always
  // cached. RFC-143: the provider/modelID defaults (was in routes/runtime.ts's
  // isClaude branch) live here now so the route emits one shape for both runtimes.
  async listModels(binary: string, _opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return {
      binary,
      models: listClaudeModels().map((m) => ({
        id: m.id,
        provider: m.provider ?? 'anthropic',
        modelID: m.modelID ?? m.id,
        name: m.name,
      })),
      cached: true,
    }
  },
  async captureSessions(ctx: SessionCaptureContext): Promise<void> {
    await captureClaudeSessions({
      rootSessionId: ctx.rootSessionId,
      nodeRunId: ctx.nodeRunId,
      taskId: ctx.taskId,
      db: ctx.db,
      log: ctx.log,
      // RFC-154: the transcript lives under the selected leaf (runner threads it);
      // omitted (tests / non-runner callers) → protocol default.
      configDir: join(
        ctx.runRoot,
        ctx.configDirName ?? DEFAULT_CONFIG_DIR_PROFILE['claude-code'].name,
      ),
      worktreePath: ctx.worktreePath,
    })
  },
  // RFC-117 — system-agent spawn. Persona → --append-system-prompt-file, model →
  // --model, prompt → stdin (buildClaudeSpawn already returns stdin:pipe).
  // RFC-280 T6: an optional MCP injection mounts as an mcp-config.json written
  // 0600 under runDir (secrets stay off argv) + `--mcp-config`; the playground's
  // pre-allocated native session id lands as `--session-id`.
  async buildSpawn(ctx: SystemAgentSpawnContext): Promise<SpawnPlan> {
    if (ctx.nativeSessionId !== undefined && ctx.resumeSessionId !== undefined) {
      throw new Error('system-agent-native-session-conflict')
    }
    let mcpConfigFile: string | undefined
    if (ctx.mcpInjection !== undefined && ctx.mcpInjection.mcpEntries !== null) {
      mkdirSync(ctx.runDir, { recursive: true, mode: 0o700 })
      mcpConfigFile = join(ctx.runDir, 'mcp-config.json')
      writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: ctx.mcpInjection.mcpEntries }), {
        mode: 0o600,
        flag: 'w',
      })
    }
    const plan = buildClaudeSpawn({
      ...(pickRuntimeHead(ctx.runtimeBinary, ctx.runtimeCmd) !== undefined
        ? { claudeCmd: pickRuntimeHead(ctx.runtimeBinary, ctx.runtimeCmd) }
        : {}),
      prompt: ctx.prompt,
      systemPromptText: ctx.systemPrompt,
      ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
      attemptDir: ctx.runDir,
      worktreePath: ctx.worktreePath,
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
      isSandbox: ctx.isSandbox,
      ...(mcpConfigFile !== undefined ? { mcpConfigJson: mcpConfigFile } : {}),
      ...(ctx.extraArgs !== undefined && ctx.extraArgs.length > 0
        ? { extraArgs: ctx.extraArgs }
        : {}),
    })
    if (ctx.nativeSessionId !== undefined && ctx.nativeSessionId !== '') {
      plan.cmd.push('--session-id', ctx.nativeSessionId)
    }
    return plan
  },
  // RFC-143 PR-4 — business-node spawn (was the claude branch of runner.ts:828).
  // system-prompt-file (persona + RFC-041 memory weave) + RFC-111 PR-C MCP /
  // dependsOn-subagent flags + the credential-bridge DECISION (internalized:
  // presence of the test-only head override is the mock signal — production
  // never sets it, so real runs bridge; CI never touches the keychain). No
  // internal awaits — async only to match the interface (§4.6B).
  // RFC-282 B1a — unified assembly facade (see the opencode twin for the
  // contract; parity suite rfc282-b1a is live while both paths exist).
  async buildAgentSpawn(ctx: AgentSpawnContext): Promise<AgentSpawnPlan> {
    // §7-9 — see the opencode twin: declared render degrades, assembly fails.
    let rendered: RenderedInjectionV1
    try {
      rendered = this.renderInjection(ctx.injection)
    } catch (err) {
      ctx.log.warn('startup-declaration-failed', {
        nodeRunId: ctx.nodeRunId,
        err: err instanceof Error ? err.message : String(err),
      })
      rendered = { mcpEntries: null, declared: emptyDeclaredManifest() }
    }
    const head =
      ctx.binaryOverride !== undefined
        ? { runtimeCmd: [...ctx.binaryOverride] }
        : ctx.legacyHeads?.runtimeCmd !== undefined
          ? { runtimeCmd: [...ctx.legacyHeads.runtimeCmd] }
          : {}
    if (ctx.taskMounts === undefined) {
      const plan = await this.buildSpawn(toSystemCtx(ctx, rendered, head))
      return { ...plan, declared: rendered.declared }
    }
    const plan = await this.buildBusinessSpawn(toBusinessCtx(ctx, head))
    return { ...plan, declared: rendered.declared }
  },
  async buildBusinessSpawn(ctx: BusinessNodeSpawnContext): Promise<SpawnPlan> {
    const baseSystemPrompt =
      ctx.injectedMemoryBlock !== null
        ? `${ctx.agent.bodyMd}\n\n${ctx.injectedMemoryBlock}`
        : ctx.agent.bodyMd
    const managedSkillAttachments = renderClaudeManagedSkillAttachments(
      ctx.runRoot,
      ctx.skills,
      ctx.log,
    )
    const systemPromptText =
      managedSkillAttachments.length > 0
        ? `${baseSystemPrompt}\n\n${managedSkillAttachments}`
        : baseSystemPrompt
    // 2026-08-09 — dependents now carry their OWN resolved model and their own
    // permission-derived load set. `gate` is computed just below, so the
    // ceiling is read after it; see `claudeAgents` further down.
    const claudeAgentsOf = (
      parentTools: readonly string[] | null,
    ): ReturnType<typeof toClaudeAgents> =>
      toClaudeAgents(ctx.dependents, {
        profileByName: ctx.resolvedParamsByAgent,
        parentTools,
      })
    // RFC-113 (Codex P1-3): claude's model is the RUNTIME's, not the agent's.
    // The root entry of resolvedParamsByAgent carries the dispatch-resolved profile.
    const rootParams = ctx.resolvedParamsByAgent.get(ctx.agent.name)
    // RFC-242 §2 — derive the tool gate from the agent's declared permission.
    // An agent with NO declaration stays unconstrained (user decision
    // 2026-07-31: existing workflows must not break) but is logged as such, so
    // the exposure is visible rather than silent.
    const gate = claudeBusinessGate(ctx.agent.permission)
    if (gate === null) {
      ctx.log.warn('claude-business-unconstrained', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        detail: 'agent declares no permission; claude node runs with bypassed permissions',
      })
    } else if (gate.warnings.length > 0) {
      ctx.log.warn('claude-permission-mapping', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        warnings: gate.warnings,
      })
    }
    // RFC-281 T4: the author's `external_directory` allow-list crosses to claude
    // only for LITERAL directories (they become sandbox allowWrite +
    // additionalDirectories). A mid-pattern glob has no claude equivalent —
    // disclose the granularity loss instead of dropping it silently (same
    // discipline as the permission mapping above).
    // RFC-281 T3 (§4.4): the WRITE boundary is Claude's own sandbox. On a host
    // where that mechanism is unavailable (Linux without bwrap+socat, Windows)
    // we still spawn — business must not be blocked by a missing fence (§0) —
    // but the degradation is logged so it is never silent.
    const boundaryAvailability = claudeWriteBoundaryAvailability(
      ctx.boundaryHostProbe?.platform ?? process.platform,
      ctx.boundaryHostProbe?.hasExecutable ?? ((bin) => Bun.which(bin) !== null),
    )
    if (!boundaryAvailability.available) {
      ctx.log.warn('claude-workspace-boundary-unavailable', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        reason: boundaryAvailability.reason,
        detail:
          'claude sandbox is not available on this host; the node runs WITHOUT a workspace write boundary',
      })
    }
    // 2nd impl-gate P1: settings 是**整个 claude 进程**的，dependsOn 子代理跑在
    // 同一进程里、共享这一份边界。只取 root 的白名单会让「子代理自己声明了
    // external_directory」静默失效——它拿不到那个目录，且没有任何提示。合并
    // root + 每个 dependent 的可兑现目录（lossy 也合并，一起走告警面）。
    // 每个 mount 的 git 元数据目录（linked worktree 的 common + admin dir）。
    // `?? []`：taskMounts 生产必填，但缺它绝不能让整个 spawn 崩掉（§0）——
    // 少一条放行只是少一层边界，抛异常却是节点直接起不来。
    const gitMetaDirs = (
      await Promise.all((ctx.taskMounts ?? []).map((m) => gitMetaDirsFor(m)))
    ).flat()
    const authorAllowDirs = [ctx.agent, ...ctx.dependents].reduce<{
      dirs: string[]
      lossy: string[]
    }>(
      (acc, a) => {
        const r = claudeExpressibleAuthorDirs(a.permission)
        for (const d of r.dirs) if (!acc.dirs.includes(d)) acc.dirs.push(d)
        for (const l of r.lossy) if (!acc.lossy.includes(l)) acc.lossy.push(l)
        return acc
      },
      { dirs: [], lossy: [] },
    )
    if (authorAllowDirs.lossy.length > 0) {
      ctx.log.warn('claude-external-directory-glob-unsupported', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        patterns: authorAllowDirs.lossy,
        detail:
          'claude can only express literal directories; these glob patterns are not granted on this runtime',
      })
    }
    const attachedSkillNames = ctx.skills
      .filter((skill) => skill.sourceKind === 'managed')
      .map((skill) => skill.name)
    // A gated parent has a load set to cap members with; an unconstrained one
    // (bypassPermissions) has none, and keeps the historical entry shape.
    const claudeAgents = claudeAgentsOf(gate === null ? null : gate.tools)
    if (claudeAgents !== null && claudeAgents.warnings.length > 0) {
      ctx.log.warn('claude-dependent-capability-capped', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        warnings: claudeAgents.warnings,
      })
    }
    // 2026-08-09 — plugins are an opencode concept with no claude counterpart.
    // That is by design, but a node whose agent SELECTED plugins and then ran
    // on claude got exactly nothing, with the plugin names appearing only in a
    // diagnostics field nobody reads. Say it out loud instead.
    const enabledPlugins = ctx.plugins.filter((plugin) => plugin.enabled !== false)
    if (enabledPlugins.length > 0) {
      ctx.log.warn('claude-plugins-unsupported', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        plugins: enabledPlugins.map((plugin) => plugin.name),
        detail: 'the claude-code runtime has no plugin surface; these are not loaded',
      })
    }
    const declaredAgentNames = claudeAgents === null ? [] : Object.keys(claudeAgents.agents)
    const businessHead = pickRuntimeHead(ctx.runtimeBinary, ctx.runtimeCmd)
    // RFC-280 T1: MCP wire entries + declared manifest come from the unified
    // injection layer (same partition/render toClaudeMcpConfig wraps).
    const mcpInjection = renderClaudeMcpInjection(ctx.mcps)
    const claudeMcp = mcpInjection.entries === null ? null : { mcpServers: mcpInjection.entries }
    const plan = buildClaudeSpawn({
      // Codex impl-gate P1-1: claude uses runtimeCmd (test-only), NEVER the
      // opencode-specific opencodeCmd. RFC-112/113: a custom claude fork's binary
      // (runtimeBinary, incl. the built-in's migrated config.claudeCodePath) wins;
      // else a test runtimeCmd; else production → undefined → ['claude'].
      ...(businessHead === undefined ? {} : { claudeCmd: businessHead }),
      prompt: ctx.prompt,
      systemPromptText,
      model: rootParams?.model ?? undefined,
      resumeSessionId: ctx.resumeSessionId,
      attemptDir: ctx.runRoot,
      worktreePath: ctx.worktreePath,
      gitUserName: ctx.gitUserName,
      gitUserEmail: ctx.gitUserEmail,
      isSandbox: rootParams?.isSandbox === true,
      // RFC-281 T2/T3: workspace WRITE boundary via Claude's own sandbox. The
      // author's literal external_directory allow-dirs are honored; non-literal
      // globs are disclosed as a warning below (never silently dropped).
      onUnexpressibleBoundaryDirs: (dirs) => {
        // The dir stays writable through sandbox allowWrite (a plain path list);
        // only the dontAsk tool-layer rule cannot be expressed for it. Say so
        // instead of emitting a rule whose parse we cannot predict.
        ctx.log.warn('claude-boundary-dir-unexpressible', {
          agent: ctx.agent.name,
          nodeRunId: ctx.nodeRunId,
          dirs,
          detail:
            'these mount paths contain gitignore-pattern characters ( ) * ? [ ] \\ — no Edit(...) rule was emitted for them',
        })
      },
      onExtraArgsDropped: (dropped) => {
        // RFC-281 P2-4: a pre-RFC runtime row could carry `--settings` (then a
        // legal operator flag). Dropping it protects the boundary; saying so
        // keeps it from being a silent behavior change for that operator.
        ctx.log.warn('claude-extra-args-platform-owned-dropped', {
          agent: ctx.agent.name,
          nodeRunId: ctx.nodeRunId,
          dropped,
          detail:
            'stored extraArgs contained platform-owned flags; they were removed from this spawn',
        })
      },
      boundary: {
        taskMounts: ctx.taskMounts,
        // 业务误伤检视 P2-1：claude 的 sandbox 只对**会话 cwd** 自动解析 linked
        // worktree 的共享 gitdir，对 allowWrite/additionalDirectories 里的其它
        // mount 不解析 ⇒ 多仓任务在非主 mount 上 `git add/commit` 会 EPERM，
        // 表现为「文件改得动、git 动不了」。把每个 mount 的 common/admin 目录
        // 显式放行（拿不到就少一条，不阻断）。
        gitMetaDirs: [
          ...gitMetaDirs,
          // 业务误伤检视 P2-2（用户拍板放行）：dontAsk 节点跑 bun install /
          // npm ci / cargo build 要写这些缓存，不放行就 EPERM 且**无自救路径**
          // （逃生阀在 dontAsk 下需过权限门、headless 无人应答）。它们是工具链
          // 缓存、不是任何任务的工作区。
          ...toolchainCacheDirs(),
        ],
        // 2nd impl-gate P1-1: claude 的 sandbox 只拦 Bash；Edit/Write 走
        // permissions 层，而未声明 permission 的节点是 bypassPermissions ⇒ 默认
        // 形态下 Write 工具可直写兄弟任务目录（实测复现事故形态）。deny 规则在
        // 所有 permission-mode 下都生效，是唯一的拦法。appHome 从 runRoot
        // (`<appHome>/runs/<taskId>/<nodeRunId>`) 反推，扫不到就少一条规则。
        // `runs/` 不逐个枚举（检视 P1-1：无 GC、本机已 1406 个 → 单它就 2812 条
        // 规则、264 KB settings，随部署寿命单调恶化）。也**不**下发它的祖先 deny：
        // 本次 run 自己的 system.md / settings.json / mcp-config.json 就在
        // `runs/<taskId>/<nodeRunId>` 下，deny 祖先会把它们一并盖住（§0：不给
        // 自己挖坑）。别的任务的 runs 目录不含工作区数据，放弃 deny 它的收益极小。
        siblingTaskRoots: [
          ...scanSiblingTaskRoots(
            join(ctx.runRoot, '..', '..', '..'),
            ctx.taskMounts,
            // runRoot = <appHome>/runs/<taskId>/<nodeRunId> → 倒数第二段是 taskId
            basename(join(ctx.runRoot, '..')),
          ),
        ],
        ...(authorAllowDirs.dirs.length === 0 ? {} : { authorAllowDirs: authorAllowDirs.dirs }),
      },
      ...(gate === null ? {} : { businessTools: claudeToolsValue(gate) }),
      ...(claudeMcp !== null
        ? {
            // RFC-280 §7.1: the MCP config (headers may carry user tokens) is
            // written 0600 under the per-run dir and passed as a PATH — inline
            // JSON on argv leaked secrets into /proc/<pid>/cmdline
            // (audit-backlog item, now closed on the business path too).
            mcpConfigJson: writeBusinessMcpConfig(ctx.runRoot, claudeMcp),
            // RFC-242 T5: a gated node must allowlist its own MCP namespaces or
            // dontAsk denies every MCP call (measured, see ClaudeSpawnContext).
            mcpServerNames: mcpInjection.declared.mcpServers,
          }
        : {}),
      ...(claudeAgents !== null ? { agentsJson: JSON.stringify(claudeAgents.agents) } : {}),
      // Per-runtime extraArgs (fork-private flags). Root
      // params only: claude subagents share this one process, so per-process
      // argv can only come from the root's runtime.
      ...(rootParams?.extraArgs != null && rootParams.extraArgs.length > 0
        ? { extraArgs: rootParams.extraArgs }
        : {}),
    })
    const worktreeSkillProjection = stageClaudeWorktreeSkills(
      ctx.worktreePath,
      ctx.configDir.name,
      ctx.runRoot,
      ctx.skills,
      ctx.log,
    )
    let worktreeAgentProjection: ReturnType<typeof stageClaudeWorktreeAgents>
    try {
      worktreeAgentProjection = stageClaudeWorktreeAgents(
        ctx.worktreePath,
        ctx.configDir.name,
        claudeAgents?.agents ?? {},
        ctx.log,
      )
    } catch (error) {
      worktreeSkillProjection.cleanup()
      throw error
    }
    return {
      ...plan,
      cleanup: async () => {
        try {
          worktreeAgentProjection.cleanup()
        } finally {
          try {
            worktreeSkillProjection.cleanup()
          } finally {
            await plan.cleanup?.()
          }
        }
      },
      ...(claudeMcp === null ? {} : { declaredMcpServers: mcpInjection.declared.mcpServers }),
      // §4.4: same diagnostic fields the runner used to derive from the (built-
      // for-both-runtimes) inline config — byte-equal log line, claude included.
      diagnostics: {
        inlineModel: rootParams?.model ?? null,
        inlineVariant: rootParams?.variant ?? null,
        inlineTemperature: rootParams?.temperature ?? null,
        mcpCount: mcpInjection.declared.mcpServers.length,
        mcpKeys: mcpInjection.declared.mcpServers,
        // 2026-08-09 — this line is the operator's only view of "what actually
        // went into this spawn", so it must not claim an injection that never
        // happens. `pluginCount`/`pluginNames` reported the SELECTED plugins on
        // a runtime that has no plugin surface at all: the log said N, the
        // process loaded zero. Renamed to say what is true, matching the
        // opencode side's `machineConfigIgnoredPlugins` (RFC-256), which exists
        // for exactly this reason — "report the count so that limit is visible
        // in the run log instead of looking like a silent no-op".
        pluginsIgnoredUnsupported: enabledPlugins.length,
        pluginsIgnoredNames: enabledPlugins.map((p) => p.name),
        // The three injected surfaces the startup-verification layer (RFC-280
        // T3) checks against claude's init inventory — the proof exists now:
        // parseStartupInventory feeds verifyStartup, whose skills/subagents/
        // tools-missing findings land on the node-detail warning face.
        skillNames: attachedSkillNames,
        skillProjectConfigPath: worktreeSkillProjection.configPath,
        subagentNames: declaredAgentNames,
        subagentProjectConfigPath: worktreeAgentProjection.configPath,
        declaredToolNames: gate?.tools ?? [],
        businessTools: gate === null ? 'unconstrained' : claudeToolsValue(gate),
        businessToolWarnings: gate?.warnings ?? [],
      },
    }
  },
}
