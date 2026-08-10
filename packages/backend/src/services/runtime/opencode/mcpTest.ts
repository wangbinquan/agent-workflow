import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpTestSpawnContext, McpTestSpawnPlan } from '../types'
import { getOpencodeBinaryVersion } from '@/util/opencode-version-registry'
import { buildOpencodeSpawn } from './spawn'

export async function buildOpencodeMcpTestSpawn(
  ctx: McpTestSpawnContext,
): Promise<McpTestSpawnPlan> {
  const head =
    ctx.runtimeBinary !== undefined && ctx.runtimeBinary !== null && ctx.runtimeBinary !== ''
      ? [ctx.runtimeBinary]
      : ['opencode']
  const runConfigDir = join(ctx.runDir, ctx.configDir.name)
  mkdirSync(runConfigDir, { recursive: true, mode: 0o700 })
  const inlineConfig = {
    agent: {
      [ctx.agentName]: {
        prompt: ctx.systemPrompt,
        ...(ctx.model !== undefined && ctx.model !== null && ctx.model !== ''
          ? { model: ctx.model }
          : {}),
        ...(ctx.variant !== undefined && ctx.variant !== null ? { variant: ctx.variant } : {}),
        ...(ctx.temperature !== undefined && ctx.temperature !== null
          ? { temperature: ctx.temperature }
          : {}),
        ...(ctx.steps !== undefined && ctx.steps !== null ? { steps: ctx.steps } : {}),
      },
    },
    mcp: {
      [ctx.executionMaterial.runtimeKey]: ctx.executionMaterial.opencodeEntry,
    },
  }
  const { cmd, env } = buildOpencodeSpawn({
    opencodeCmd: head,
    binaryVersion: getOpencodeBinaryVersion(head[0]!),
    agentName: ctx.agentName,
    prompt: ctx.prompt,
    ...(ctx.resumeSessionId === undefined ? {} : { resumeSessionId: ctx.resumeSessionId }),
    worktreePath: ctx.worktreePath,
    runDir: runConfigDir,
    configDirEnv: ctx.configDir.env,
    inlineConfigSerialized: JSON.stringify(inlineConfig),
  })
  return {
    cmd,
    env,
    stdin: { mode: 'ignore' },
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
