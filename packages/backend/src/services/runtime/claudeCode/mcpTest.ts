// RFC-238 — Claude Code's dedicated MCP-only playground plan.
//
// This is intentionally separate from buildClaudeSpawn: business/system
// callers retain their historical argv, while this capability uses dontAsk,
// an empty built-in tool set, one private MCP config file, and a session-scoped
// config directory that survives between turns.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import type { McpTestSpawnContext, McpTestSpawnPlan } from '../types'
import { prepareClaudeConfigDir } from './config'
import { assembleClaudeEnv, claudeDeclaredControlArgv, CLAUDE_HEADLESS_BASE_ARGV } from './spawn'
import { snapshotRuntimeBinary, verifyRuntimeBinarySnapshot } from '../binarySnapshot'
import { identityDigest } from '../opencode/executionIdentity'

export async function buildClaudeMcpTestSpawn(ctx: McpTestSpawnContext): Promise<McpTestSpawnPlan> {
  if (ctx.nativeSessionId !== undefined && ctx.resumeSessionId !== undefined) {
    throw new Error('mcp-test-native-session-conflict')
  }
  const configDir = ctx.sessionStoreRoot
  mkdirSync(ctx.runDir, { recursive: true, mode: 0o700 })
  prepareClaudeConfigDir(configDir, [], ctx.log, ctx.bridgeCredentials === true)

  const systemPromptFile = join(ctx.runDir, `system-${ctx.turnId}.md`)
  writeFileSync(systemPromptFile, ctx.systemPrompt, { mode: 0o600 })

  const mcpConfig = {
    mcpServers: {
      [ctx.executionMaterial.runtimeKey]: ctx.executionMaterial.claudeEntry,
    },
  }
  const mcpConfigFile = join(ctx.executionMaterial.root, 'claude-mcp-config.json')
  // Secrets stay out of argv/process listings: Claude receives only this
  // daemon-private path.
  const mcpConfigJson = JSON.stringify(mcpConfig)
  writeFileSync(mcpConfigFile, mcpConfigJson, { mode: 0o600 })
  const mcpConfigDigest = createHash('sha256').update(mcpConfigJson).digest('hex')

  const sourceHead =
    ctx.runtimeBinary !== undefined && ctx.runtimeBinary !== null && ctx.runtimeBinary !== ''
      ? [ctx.runtimeBinary]
      : ['claude']
  const sealedBinary = join(ctx.runDir, 'runtime-bin', 'claude')
  const binaryIdentity = await snapshotRuntimeBinary({
    command: sourceHead,
    snapshotPath: sealedBinary,
  })
  // RFC-237 unification (2026-07-31): the declared-control flag group is owned
  // by spawn.ts — this capability only declares its own tool surface (no
  // built-ins, exactly one MCP namespace). Byte-identical to the previous
  // hand-rolled group; a dropped flag now fails the shared contract, not just
  // this file's review.
  const cmd = [
    sealedBinary,
    ...CLAUDE_HEADLESS_BASE_ARGV,
    ...claudeDeclaredControlArgv({
      tools: '',
      mcpConfigFile,
      allowedTools: `mcp__${ctx.executionMaterial.runtimeKey}__*`,
    }),
  ]
  if (ctx.model !== undefined && ctx.model !== null && ctx.model !== '') {
    cmd.push('--model', ctx.model)
  }
  cmd.push('--append-system-prompt-file', systemPromptFile)
  if (ctx.nativeSessionId !== undefined && ctx.nativeSessionId !== '') {
    cmd.push('--session-id', ctx.nativeSessionId)
  } else if (ctx.resumeSessionId !== undefined && ctx.resumeSessionId !== '') {
    cmd.push('--resume', ctx.resumeSessionId)
  }

  // RFC-237 unification (2026-07-31): env flows through the single Claude
  // assembly point — controlled inherit + hardening + config-dir scrub + the
  // uid-0 sandbox assert this file previously lacked (same root-deployment
  // exposure the read-only intent branch had).
  const configDirEnv = ctx.configDir.env ?? DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env
  const env = assembleClaudeEnv({
    inherit: 'controlled',
    hardening: true,
    worktreePath: ctx.worktreePath,
    configDirEnv,
    configDir,
  })

  const sessionContractDigest = identityDigest({
    codec: 1,
    protocol: 'claude-code',
    sessionId: ctx.sessionId,
    runtimeSessionId: ctx.nativeSessionId ?? ctx.resumeSessionId ?? null,
    agentName: ctx.agentName,
    model: ctx.model ?? null,
    worktreePath: ctx.worktreePath,
    configDir: {
      env: configDirEnv,
      name: ctx.configDir.name,
      root: configDir,
    },
    mcpExecutionDigest: ctx.executionMaterial.executionDigest,
  })

  return {
    cmd,
    env,
    stdin: { mode: 'pipe', data: ctx.prompt },
    containment: ctx.containment,
    preSpawnVerify: async () => {
      await ctx.executionMaterial.preSpawnVerify()
      await verifyRuntimeBinarySnapshot(sealedBinary, binaryIdentity.digest)
      const metadata = statSync(mcpConfigFile)
      const digest = createHash('sha256').update(readFileSync(mcpConfigFile)).digest('hex')
      if (
        !metadata.isFile() ||
        (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) ||
        digest !== mcpConfigDigest
      ) {
        throw new Error('mcp-test-config-changed-before-spawn')
      }
    },
    identity: {
      codec: 'mcp-test-plan-identity-v1',
      runtimeBinaryDigest: binaryIdentity.digest,
      mcpExecutionDigest: ctx.executionMaterial.executionDigest,
      sessionContractDigest,
      rawCommandDigest: identityDigest({
        codec: 1,
        protocol: 'claude-code',
        runtimeBinaryDigest: binaryIdentity.digest,
      }),
    },
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
