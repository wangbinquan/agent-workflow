// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

import type { StartupInventory } from '../types'
import type {
  AgentInjectionSpecV1,
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
  renderClaudeMcpInjection,
} from '@/services/execution/agentInjection'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'
import { claudeBusinessGate, claudeToolsValue } from './permissionMap'
import { buildClaudeMcpTestSpawn } from './mcpTest'
import {
  renderClaudeManagedSkillAttachments,
  stageClaudeWorktreeAgents,
  stageClaudeWorktreeSkills,
} from './config'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  mcpTest: {
    codec: 'mcp-test-v1',
    defaultConfigDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    createNativeSessionId: randomUUID,
    sessionReference: ({ turnSeq, nativeSessionId }) => {
      if (nativeSessionId === null) throw new Error('mcp-test-native-session-missing')
      return turnSeq === 1 ? { nativeSessionId } : { resumeSessionId: nativeSessionId }
    },
    buildSpawn: buildClaudeMcpTestSpawn,
  },
  // 2026-08-04 — claude forks carry private flags (CodeAgent's
  // --skip-safe-check); the registry-validated extraArgs land at the argv tail.
  acceptsExtraArgs: true,
  // Claude CLI compatibility only; this capability does not provide platform
  // process isolation or any operating-system sandbox guarantee.
  acceptsSandboxCompatibilityMarker: true,
  minVersion: MIN_CLAUDE_CODE_VERSION,
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
  // --model, prompt → stdin (buildClaudeSpawn already returns stdin:pipe). No
  // skills/mcp/subagents for a framework system agent.
  async buildSpawn(ctx: SystemAgentSpawnContext): Promise<SpawnPlan> {
    return buildClaudeSpawn({
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
      ...(ctx.extraArgs !== undefined && ctx.extraArgs.length > 0
        ? { extraArgs: ctx.extraArgs }
        : {}),
    })
  },
  // RFC-143 PR-4 — business-node spawn (was the claude branch of runner.ts:828).
  // system-prompt-file (persona + RFC-041 memory weave) + RFC-111 PR-C MCP /
  // dependsOn-subagent flags + the credential-bridge DECISION (internalized:
  // presence of the test-only head override is the mock signal — production
  // never sets it, so real runs bridge; CI never touches the keychain). No
  // internal awaits — async only to match the interface (§4.6B).
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
      ...(gate === null ? {} : { businessTools: claudeToolsValue(gate) }),
      ...(claudeMcp !== null
        ? {
            mcpConfigJson: JSON.stringify(claudeMcp),
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
        // The three injected surfaces the runner then PROVES against claude's
        // startup inventory — same values, one derivation.
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
