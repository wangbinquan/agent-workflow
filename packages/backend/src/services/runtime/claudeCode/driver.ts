// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

import type { NormalizedEvent, RuntimeDriver, SpawnPlan, SystemAgentSpawnContext } from '../types'
import { parseEvent } from './events'
import { buildClaudeSpawn } from './spawn'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
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
    })
  },
}
