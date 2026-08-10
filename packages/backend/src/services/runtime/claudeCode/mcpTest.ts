import { mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpTestSpawnContext, McpTestSpawnPlan } from '../types'
import { buildClaudeSpawn } from './spawn'

export async function buildClaudeMcpTestSpawn(ctx: McpTestSpawnContext): Promise<McpTestSpawnPlan> {
  if (ctx.nativeSessionId !== undefined && ctx.resumeSessionId !== undefined) {
    throw new Error('mcp-test-native-session-conflict')
  }
  mkdirSync(ctx.runDir, { recursive: true, mode: 0o700 })
  const mcpConfigFile = join(ctx.runDir, 'mcp-config.json')
  writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        [ctx.executionMaterial.runtimeKey]: ctx.executionMaterial.claudeEntry,
      },
    }),
    { mode: 0o600 },
  )
  const plan = buildClaudeSpawn({
    claudeCmd:
      ctx.runtimeBinary !== undefined && ctx.runtimeBinary !== null && ctx.runtimeBinary !== ''
        ? [ctx.runtimeBinary]
        : ['claude'],
    prompt: ctx.prompt,
    systemPromptText: ctx.systemPrompt,
    ...(ctx.model !== undefined && ctx.model !== null && ctx.model !== ''
      ? { model: ctx.model }
      : {}),
    ...(ctx.resumeSessionId === undefined ? {} : { resumeSessionId: ctx.resumeSessionId }),
    attemptDir: ctx.runDir,
    worktreePath: ctx.worktreePath,
    isSandbox: ctx.isSandbox,
    mcpConfigJson: mcpConfigFile,
  })
  if (ctx.nativeSessionId !== undefined && ctx.nativeSessionId !== '') {
    plan.cmd.push('--session-id', ctx.nativeSessionId)
  }
  return {
    ...plan,
    diagnostics: {
      mcpTestCodec: 'mcp-test-v1',
      mcpCount: 1,
      mcpKeys: [ctx.executionMaterial.runtimeKey],
      nativeSessionMode: ctx.resumeSessionId === undefined ? 'new' : 'resume',
    },
    cleanup: async () => {
      await rm(ctx.runDir, { recursive: true, force: true })
    },
  }
}
