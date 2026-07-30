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
import { parseEvent, parseResultError } from './events'
import { buildClaudeSpawn } from './spawn'
import { toClaudeAgents, toClaudeMcpConfig } from './inject'
import { pickRuntimeHead } from '../head'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'
import { snapshotRuntimeBinary, verifyRuntimeBinarySnapshot } from '../binarySnapshot'
import { buildClaudeMcpTestSpawn } from './mcpTest'

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
      mcp.type === 'local' ? 'opencode-verified-v1' : 'runner-filesystem-v1',
    buildSpawn: buildClaudeMcpTestSpawn,
  },
  // RFC-237 — this driver can materialize the read-only intent profile as a
  // declared-control spawn (sealed binary + `--tools` load-set pruning +
  // dontAsk; design §2). Admission gates consult this set; anything not
  // declared here still fails closed in buildSpawn below.
  narrowedSystemPermissionProfiles: ['intent-read-v1'],
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
      claudeCmd = [sealPath]
      // Design-gate P1-3: re-verify at the spawn boundary (systemAgentRun
      // awaits this immediately before Bun.spawn).
      preSpawnVerify = () => verifyRuntimeBinarySnapshot(sealPath, identity.digest)
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
    // RFC-111 PR-C: MCP + dependsOn-closure subagents → inline-JSON flags.
    const claudeMcp = toClaudeMcpConfig(ctx.mcps)
    const claudeAgents = toClaudeAgents(ctx.dependents)
    // RFC-113 (Codex P1-3): claude's model is the RUNTIME's, not the agent's.
    // The root entry of resolvedParamsByAgent carries the frozen root profile.
    const rootParams = ctx.resolvedParamsByAgent.get(ctx.agent.name)
    const plan = buildClaudeSpawn({
      // Codex impl-gate P1-1: claude uses runtimeCmd (test-only), NEVER the
      // opencode-specific opencodeCmd. RFC-112/113: a custom claude fork's binary
      // (runtimeBinary, incl. the built-in's migrated config.claudeCodePath) wins;
      // else a test runtimeCmd; else production → undefined → ['claude'].
      claudeCmd: pickRuntimeHead(ctx.runtimeBinary, ctx.runtimeCmd),
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
      ...(claudeMcp !== null ? { mcpConfigJson: JSON.stringify(claudeMcp) } : {}),
      ...(claudeAgents !== null ? { agentsJson: JSON.stringify(claudeAgents) } : {}),
      // bridge subscription creds only on REAL claude runs (tests set runtimeCmd).
      bridgeCredentials: ctx.runtimeCmd === undefined,
      log: ctx.log,
    })
    return {
      ...plan,
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
      },
    }
  },
}
