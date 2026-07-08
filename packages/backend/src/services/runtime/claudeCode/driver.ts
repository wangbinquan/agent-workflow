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
import { join } from 'node:path'
import { parseEvent } from './events'
import { buildClaudeSpawn } from './spawn'
import { toClaudeAgents, toClaudeMcpConfig } from './inject'
import { pickRuntimeHead } from '../head'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  minVersion: MIN_CLAUDE_CODE_VERSION,
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
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
      configDir: join(ctx.runRoot, '.claude'),
      worktreePath: ctx.worktreePath,
    })
  },
  // RFC-117 — system-agent spawn. Persona → --append-system-prompt-file, model →
  // --model, prompt → stdin (buildClaudeSpawn already returns stdin:pipe). No
  // skills/mcp/subagents for a framework system agent.
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan {
    return buildClaudeSpawn({
      ...(ctx.runtimeBinary != null && ctx.runtimeBinary !== ''
        ? { claudeCmd: [ctx.runtimeBinary] }
        : {}),
      prompt: ctx.prompt,
      systemPromptText: ctx.systemPrompt,
      ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
      attemptDir: ctx.runDir,
      worktreePath: ctx.worktreePath,
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      ...(ctx.bridgeCredentials != null ? { bridgeCredentials: ctx.bridgeCredentials } : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
      ...(ctx.log !== undefined ? { log: ctx.log } : {}),
    })
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
