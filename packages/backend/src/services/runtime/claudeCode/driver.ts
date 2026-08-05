// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

import type {
  BusinessNodeSpawnContext,
  NormalizedEvent,
  ProbeOpts,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  SessionCaptureContext,
  SpawnPlan,
  SystemAgentSpawnContext,
  ListModelsOpts,
} from '../types'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import { parseEvent, parseResultError, parseUnusableMcpServers } from './events'
import { buildClaudeSpawn } from './spawn'
import { toClaudeAgents, toClaudeMcpConfig } from './inject'
import { pickRuntimeHead } from '../head'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'
import { snapshotRuntimeBinary, verifyRuntimeBinarySnapshot } from '../binarySnapshot'
import { claudeBusinessGate, claudeToolsValue } from './permissionMap'
import { buildClaudeMcpTestSpawn } from './mcpTest'
import { claudeLocalMcpFenceDecision, materializeClaudeNetlessMcp } from './netlessMcp'
import { executionIdentityFailure } from '../opencode/failure'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  containmentProfile: 'runner-filesystem-v1',
  mcpTest: {
    codec: 'mcp-test-v1',
    defaultConfigDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
    bridgeCredentials: true,
    sessionOwnerReceipt: null,
    createNativeSessionId: randomUUID,
    sessionReference: ({ turnSeq, nativeSessionId }) => {
      if (nativeSessionId === null) throw new Error('mcp-test-native-session-missing')
      return turnSeq === 1 ? { nativeSessionId } : { resumeSessionId: nativeSessionId }
    },
    sessionStoreDbPath: () => null,
    containmentProfile: ({ mcp }) =>
      mcp.type === 'local' ? 'model-child-netless-v1' : 'runner-filesystem-v1',
    buildSpawn: buildClaudeMcpTestSpawn,
  },
  // RFC-237 — this driver can materialize the read-only intent profile as a
  // declared-control spawn (sealed binary + `--tools` load-set pruning +
  // dontAsk; design §2). Admission gates consult this set; anything not
  // declared here still fails closed in buildSpawn below.
  narrowedSystemPermissionProfiles: ['intent-read-v1'],
  // 2026-08-04 — claude forks carry private flags (CodeAgent's
  // --skip-safe-check); the registry-validated extraArgs land at the argv tail.
  acceptsExtraArgs: true,
  // RFC-242 T5 — a node that fences its local MCP demands the model-child
  // no-network bundle: claude forks the platform's wrapper, which needs the
  // admitted child provider to build a boundary at all. WHICH nodes those are
  // (and why the others are excluded) is `claudeLocalMcpFenceDecision`, the same
  // predicate buildBusinessSpawn materializes from — demand and materialization
  // must never drift.
  businessContainmentProfile: ({ agent, mcps, runtimeCmd }) =>
    claudeLocalMcpFenceDecision({
      gate: claudeBusinessGate(agent.permission),
      mcps,
      runtimeCmd,
    }).fence
      ? 'model-child-netless-v1'
      : 'runner-filesystem-v1',
  minVersion: MIN_CLAUDE_CODE_VERSION,
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  // RFC-237 (design-gate P2-4) — surface a clean-exit terminal `is_error`
  // result (auth/API failure) so systemAgentRun can fail the run instead of
  // letting it masquerade as a missing envelope.
  parseTerminalResultError(line: string): string | null {
    const parsed = parseResultError(line)
    if (parsed === null || !parsed.isError) return null
    return parsed.message.length > 0 ? parsed.message : 'claude reported a terminal error result'
  },
  // RFC-242 T5 — claude freezes MCP availability on its init event; a fenced
  // server that is not `connected` there loses its tools for the whole turn.
  parseUnusableMcpServers(line: string): readonly string[] | null {
    return parseUnusableMcpServers(line)
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
      // RFC-154: the transcript lives under the FROZEN leaf (runner threads it);
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
  //
  // RFC-234 §1.1 / RFC-237 §1.3 — a narrowed profile is admissible ONLY when
  // this driver declares it; 'intent-read-v1' takes the declared-control branch
  // below, everything else undeclared fails closed instead of silently widening.
  async buildSpawn(ctx: SystemAgentSpawnContext): Promise<SpawnPlan> {
    const profile = ctx.systemPermissionProfile
    if (
      profile !== undefined &&
      profile !== 'all-deny' &&
      !claudeCodeDriver.narrowedSystemPermissionProfiles.includes(profile)
    ) {
      throw new Error(`claude-code runtime cannot enforce system permission profile '${profile}'`)
    }
    const readOnlyIntent = profile === 'intent-read-v1'
    const sourceHead =
      ctx.runtimeBinary != null && ctx.runtimeBinary !== '' ? [ctx.runtimeBinary] : undefined
    // RFC-237 design §2.4 — the declared-control branch executes ONLY a private
    // byte-frozen copy (same TOCTOU fence as opencode, shared module). The
    // explicit test seam skips the seal exactly like opencode's legacy test
    // spawn; production callers never set it.
    let claudeCmd = sourceHead
    let preSpawnVerify: (() => Promise<void>) | undefined
    if (readOnlyIntent && ctx.testOnlyUnverifiedRuntime !== true) {
      const sealPath = join(ctx.runDir, 'bin', 'claude-sealed')
      const identity = await snapshotRuntimeBinary({
        command: sourceHead ?? ['claude'],
        snapshotPath: sealPath,
      })
      // RFC-254 T39: execute the path the snapshot ACTUALLY wrote — on win32 it
      // carries the resolved source extension so the copy is runnable; on POSIX
      // it is === sealPath.
      claudeCmd = [identity.snapshotPath]
      // Design-gate P1-3: re-verify at the spawn boundary (systemAgentRun
      // awaits this immediately before Bun.spawn).
      preSpawnVerify = () => verifyRuntimeBinarySnapshot(identity.snapshotPath, identity.digest)
    }
    // Design-gate P1-1 — bridge decision internalized for the declared-control
    // branch (same shape as buildBusinessSpawn: absent test seam = real run →
    // bridge; mock tests never touch the keychain). An explicit caller value
    // still wins. Legacy branch keeps the caller-provided passthrough.
    const bridgeCredentials = readOnlyIntent
      ? (ctx.bridgeCredentials ?? ctx.testOnlyUnverifiedRuntime !== true)
      : ctx.bridgeCredentials
    const plan = buildClaudeSpawn({
      ...(claudeCmd !== undefined ? { claudeCmd } : {}),
      prompt: ctx.prompt,
      systemPromptText: ctx.systemPrompt,
      // RFC-242 §3: this IS the system-agent surface — materialize the profile.
      surface: 'system',
      ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
      attemptDir: ctx.runDir,
      // Design-gate P1-2: RFC-154 custom config-dir profile of the selected
      // runtime row; omitted → protocol defaults (pre-RFC-237 byte-unchanged).
      ...(ctx.configDirEnv !== undefined ? { configDirEnv: ctx.configDirEnv } : {}),
      ...(ctx.configDirName !== undefined ? { configDirName: ctx.configDirName } : {}),
      worktreePath: ctx.worktreePath,
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      ...(bridgeCredentials != null ? { bridgeCredentials } : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
      ...(profile !== undefined ? { systemPermissionProfile: profile } : {}),
      ...(ctx.extraArgs !== undefined && ctx.extraArgs.length > 0
        ? { extraArgs: ctx.extraArgs }
        : {}),
      ...(ctx.log !== undefined ? { log: ctx.log } : {}),
    })
    return preSpawnVerify === undefined ? plan : { ...plan, preSpawnVerify }
  },
  // RFC-143 PR-4 — business-node spawn (was the claude branch of runner.ts:828).
  // system-prompt-file (persona + RFC-041 memory weave) + RFC-111 PR-C MCP /
  // dependsOn-subagent flags + the credential-bridge DECISION (internalized:
  // presence of the test-only head override is the mock signal — production
  // never sets it, so real runs bridge; CI never touches the keychain). No
  // internal awaits — async only to match the interface (§4.6B).
  async buildBusinessSpawn(ctx: BusinessNodeSpawnContext): Promise<SpawnPlan> {
    const systemPromptText =
      ctx.injectedMemoryBlock !== null
        ? `${ctx.agent.bodyMd}\n\n${ctx.injectedMemoryBlock}`
        : ctx.agent.bodyMd
    const claudeAgents = toClaudeAgents(ctx.dependents)
    // RFC-113 (Codex P1-3): claude's model is the RUNTIME's, not the agent's.
    // The root entry of resolvedParamsByAgent carries the frozen root profile.
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
    // RFC-242 T2 — a permission-gated business node executes a byte-frozen
    // copy, same TOCTOU fence as the intent path. The seam is the SAME one the
    // credential bridge already uses: a test runtimeCmd means a mock head
    // (multi-token, unsealable), production leaves it undefined. An
    // unconstrained node keeps the historical head — sealing it without its
    // tool gate would be posture theater on a bypassed process.
    const businessHead = pickRuntimeHead(ctx.runtimeBinary, ctx.runtimeCmd)
    const sealBusiness = gate !== null && ctx.runtimeCmd === undefined
    let sealedHead = businessHead
    const preSpawnChecks: Array<() => Promise<void>> = []
    if (sealBusiness) {
      const sealPath = join(ctx.runRoot, 'bin', 'claude-sealed')
      const identity = await snapshotRuntimeBinary({
        command: businessHead ?? ['claude'],
        snapshotPath: sealPath,
      })
      // RFC-254 T39: win32 snapshot carries the resolved source extension; run
      // and re-verify the path actually written (POSIX === sealPath).
      sealedHead = [identity.snapshotPath]
      preSpawnChecks.push(() => verifyRuntimeBinarySnapshot(identity.snapshotPath, identity.digest))
    }
    // RFC-242 T5 — fence the model's local MCP children: claude is told to fork
    // the platform's 0500 wrapper, which re-enters this binary and applies the
    // admitted child provider's no-network boundary (netlessMcp.ts, design §4.2).
    //
    // ONE predicate decides both the containment DEMAND (above) and this
    // MATERIALIZATION, from the SAME three inputs — including `runtimeCmd`. The
    // first cut fed the demand two of them and the materialization three, so an
    // injected mock head produced a node that had dropped the runner's outer
    // sandbox (macOS `provider-child-only`) while building no fence at all
    // (impl-gate P2-7). The seam is the same one the credential bridge and the
    // binary seal use; it now lives inside the shared decision.
    const fence = claudeLocalMcpFenceDecision({
      gate,
      mcps: ctx.mcps,
      runtimeCmd: ctx.runtimeCmd,
    })
    if (fence.skipReason === 'unfenced-shell') {
      // Never silent: this node's MCP servers keep full network because fencing
      // them would cost the outer sandbox that also contains its shell.
      ctx.log.warn('claude-mcp-netless-skipped', {
        agent: ctx.agent.name,
        nodeRunId: ctx.nodeRunId,
        reason: fence.skipReason,
        detail:
          'node grants Bash; local MCP keeps network so the runner outer sandbox is preserved (RFC-242 C-2 pending)',
      })
    }
    let localWrapperByName: ReadonlyMap<string, string> | undefined
    if (fence.fence) {
      // Fail closed, never fall back to the raw command: reaching here means
      // businessContainmentProfile already demanded the model-child bundle, so a
      // missing admission is a wiring bug, not a reason to unfence the child.
      const containment =
        ctx.containment ?? executionIdentityFailure('execution-identity-containment-required')
      const appHome = ctx.appHome ?? executionIdentityFailure('execution-identity-store-unsafe')
      if (containment.spawnTopology === 'provider-child-only') {
        // Adversarial review P1-2: on a provider that cannot nest (macOS
        // Seatbelt) the model-child boundary REPLACES the runner's outer one,
        // and the child launcher only wraps the MCP servers — claude's own
        // in-process Read/Edit/Write lose their platform filesystem boundary.
        // That is the same trade RFC-227 already makes for the verified
        // opencode server (its write/edit tools are in-process too), but it is
        // a trade, not a pure gain: say so per node instead of leaving it in a
        // design document. RFC-242 C-2 (Bash through the same wrapper) is what
        // removes it — then macOS can contain every model-controlled child.
        ctx.log.warn('claude-mcp-netless-outer-dropped', {
          agent: ctx.agent.name,
          nodeRunId: ctx.nodeRunId,
          providerId: containment.receipt.providerId,
          detail:
            'local MCP children gain the no-network child boundary; this provider cannot nest, so the runner outer sandbox around claude itself is dropped for this node (RFC-242 C-2 pending)',
        })
      }
      const netless = await materializeClaudeNetlessMcp({
        mcps: ctx.mcps,
        containment,
        runRoot: ctx.runRoot,
        worktreePath: ctx.worktreePath,
        appHome,
        ...(ctx.repoWorktreePaths === undefined
          ? {}
          : { repoWorktreePaths: ctx.repoWorktreePaths }),
        // RFC-067: the fenced child's env is REPLACED, not inherited, so the
        // task identity has to travel in the manifest like it does for claude.
        gitUserName: ctx.gitUserName,
        gitUserEmail: ctx.gitUserEmail,
        log: ctx.log,
      })
      localWrapperByName = netless.wrapperByName
      preSpawnChecks.push(netless.preSpawnVerify)
    }
    // RFC-111 PR-C: MCP → inline-JSON flag, with T5's local entries rewritten to
    // their wrapper (remote entries are byte-unchanged).
    const claudeMcp = toClaudeMcpConfig(ctx.mcps, localWrapperByName)
    const preSpawnVerify: (() => Promise<void>) | undefined =
      preSpawnChecks.length === 0
        ? undefined
        : async () => {
            for (const check of preSpawnChecks) await check()
          }
    const plan = buildClaudeSpawn({
      // Codex impl-gate P1-1: claude uses runtimeCmd (test-only), NEVER the
      // opencode-specific opencodeCmd. RFC-112/113: a custom claude fork's binary
      // (runtimeBinary, incl. the built-in's migrated config.claudeCodePath) wins;
      // else a test runtimeCmd; else production → undefined → ['claude'].
      claudeCmd: sealedHead,
      prompt: ctx.prompt,
      systemPromptText,
      model: rootParams?.model ?? undefined,
      resumeSessionId: ctx.resumeSessionId,
      attemptDir: ctx.runRoot,
      // RFC-154: frozen config-dir profile (env-var name + leaf) for custom forks.
      configDirEnv: ctx.configDir.env,
      configDirName: ctx.configDir.name,
      worktreePath: ctx.worktreePath,
      gitUserName: ctx.gitUserName,
      gitUserEmail: ctx.gitUserEmail,
      skills: ctx.skills,
      surface: 'business',
      ...(gate === null ? {} : { businessTools: claudeToolsValue(gate) }),
      ...(claudeMcp !== null
        ? {
            mcpConfigJson: JSON.stringify(claudeMcp),
            // RFC-242 T5: a gated node must allowlist its own MCP namespaces or
            // dontAsk denies every MCP call (measured, see ClaudeSpawnContext).
            mcpServerNames: Object.keys(claudeMcp.mcpServers),
          }
        : {}),
      ...(claudeAgents !== null ? { agentsJson: JSON.stringify(claudeAgents) } : {}),
      // 2026-08-04 — frozen per-runtime extraArgs (fork-private flags). Root
      // params only: claude subagents share this one process, so per-process
      // argv can only come from the root's runtime.
      ...(rootParams?.extraArgs != null && rootParams.extraArgs.length > 0
        ? { extraArgs: rootParams.extraArgs }
        : {}),
      // bridge subscription creds only on REAL claude runs (tests set runtimeCmd).
      bridgeCredentials: ctx.runtimeCmd === undefined,
      log: ctx.log,
    })
    return {
      ...plan,
      ...(preSpawnVerify === undefined ? {} : { preSpawnVerify }),
      // RFC-242 T5: a server the PLATFORM fenced must actually come up. The
      // runner fails the node when claude's init inventory says otherwise —
      // a fence that silently drops the node's tools is the failure mode this
      // whole path exists to prevent.
      ...(localWrapperByName === undefined || localWrapperByName.size === 0
        ? {}
        : { fencedMcpServers: [...localWrapperByName.keys()] }),
      // §4.4: same diagnostic fields the runner used to derive from the (built-
      // for-both-runtimes) inline config — byte-equal log line, claude included.
      diagnostics: {
        inlineModel: rootParams?.model ?? null,
        inlineVariant: rootParams?.variant ?? null,
        inlineTemperature: rootParams?.temperature ?? null,
        mcpCount: claudeMcp !== null ? Object.keys(claudeMcp.mcpServers).length : 0,
        mcpKeys: claudeMcp !== null ? Object.keys(claudeMcp.mcpServers) : [],
        pluginCount: ctx.plugins.filter((p) => p.enabled !== false).length,
        pluginNames: ctx.plugins.filter((p) => p.enabled !== false).map((p) => p.name),
        // 2026-08-04 audit (P2-9): diagnostics existed to answer "what actually
        // landed in this spawn assembly", but carried none of the decisions that
        // silently REMOVE capability — so "this node loaded zero tools", "its
        // MCP children got no fence" and "its declared network posture is not
        // enforced yet" were invisible outside a daemon log nobody reads.
        // Names and enums only, never config bodies (docs/OPENCODE_CONFIG.md §6).
        businessTools: gate === null ? 'unconstrained' : claudeToolsValue(gate),
        businessToolWarnings: gate?.warnings ?? [],
        // RFC-252 G4 is not landed: `agent.network` is persisted and exported
        // but NOTHING enforces it. Report the declaration next to the fact that
        // it is inert, so a workflow author cannot read the saved value as a
        // working switch.
        declaredNetwork: ctx.agent.network ?? null,
        networkEnforced: false,
      },
    }
  },
}
