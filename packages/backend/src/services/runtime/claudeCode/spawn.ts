// RFC-111 PR-B — Claude Code argv + env assembly (core).
//
// Contract verified hands-on against claude 2.1.193 (design §6.1):
//   claude -p --output-format stream-json --verbose --permission-mode bypassPermissions
//          [--model <alias|id>] --append-system-prompt-file <file>
//          [--disallowed-tools "<writes>"] [--resume <id>]
//   • prompt delivered via STDIN (D12 — avoids argv E2BIG; ≤10MB cap, V9)
//   • env: PWD=worktree, CLAUDE_CONFIG_DIR=<attemptDir>/.claude (transcript +
//     skills isolation, D16), IS_SANDBOX=1 iff the daemon runs as root (claude's
//     root/sudo gate rejects bypassPermissions under uid 0 without it), auth
//     inherited from process.env (ANTHROPIC_API_KEY / OAuth / etc.), RFC-067
//     git identity.
//
// PR-B scope = persona (system prompt) + model + readonly tool-gate + stdin
// prompt + stream-json. Skills / MCP / dependsOn subagents / subscription
// credential bridge land in PR-C (prepareClaudeAttemptDir).
//
// Leaf module: imports node:fs/path + runtime types only → no module-init cycle.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger, type Logger } from '@/util/log'
import type { SpawnPlan } from '../types'
import { type ClaudeSkillInjection, prepareClaudeConfigDir } from './config'

export interface ClaudeSpawnContext {
  /** Override `['claude']` (tests pass `['bun','run',mock]`). */
  claudeCmd?: string[]
  /** User prompt — delivered via stdin. */
  prompt: string
  /** Agent persona (bodyMd + any injected memory block) → --append-system-prompt-file. */
  systemPromptText: string
  /** claude --model (alias or full id). Omitted → claude's own default. */
  model?: string
  /** RFC-026 clarify-inline rerun → --resume <id> (PR-C wires this). */
  resumeSessionId?: string
  /** Per-attempt config-dir root; `.claude/` is created under it. */
  attemptDir: string
  /** Subprocess cwd = task worktree. */
  worktreePath: string
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** RFC-111 PR-C: managed/external skills to inject into CLAUDE_CONFIG_DIR/skills. */
  skills?: readonly ClaudeSkillInjection[]
  /** RFC-111 PR-C: pre-built `--mcp-config` JSON (toClaudeMcpConfig); omitted → no MCP. */
  mcpConfigJson?: string
  /** RFC-111 PR-C: pre-built `--agents` JSON (toClaudeAgents); omitted → no subagents. */
  agentsJson?: string
  /**
   * RFC-111 PR-C: bridge the subscription credential into the relocated config
   * dir (macOS keychain / Linux file). Only true for REAL claude runs — tests
   * (mock-claude) leave it false so CI never touches the keychain.
   */
  bridgeCredentials?: boolean
  log?: Logger
}

/**
 * claude's root/sudo gate: `--permission-mode bypassPermissions` (and
 * `--dangerously-skip-permissions`) hard-exit ("cannot be used with root/sudo
 * privileges") when getuid()===0 unless IS_SANDBOX === '1' — exact-string check
 * in the CLI. A root daemon therefore cannot start ANY claude child without
 * asserting the flag. Non-root spawns get nothing: the gate never fires there,
 * and claude's own sandbox detection keeps its meaning (Codex P1: don't spoof
 * the flag where it isn't needed to start).
 */
export function claudeSandboxEnv(uid: number | undefined): { IS_SANDBOX?: '1' } {
  return uid === 0 ? { IS_SANDBOX: '1' } : {}
}

export function buildClaudeSpawn(ctx: ClaudeSpawnContext): SpawnPlan {
  const log: Logger = ctx.log ?? createLogger('claude-code')
  const configDir = join(ctx.attemptDir, '.claude')
  mkdirSync(ctx.attemptDir, { recursive: true })
  // RFC-111 PR-C: prepare CLAUDE_CONFIG_DIR — inject skills + (real runs only)
  // bridge the subscription credential so the relocated dir can still auth.
  prepareClaudeConfigDir(configDir, ctx.skills ?? [], log, ctx.bridgeCredentials === true)
  // Persona file consumed by --append-system-prompt-file (append, not replace:
  // keeps Claude Code's own tool/harness scaffolding — RFC-111 D6).
  const systemPromptFile = join(ctx.attemptDir, 'system.md')
  writeFileSync(systemPromptFile, ctx.systemPromptText)

  const rawHead = ctx.claudeCmd ?? ['claude']
  // On Windows, .js files cannot be spawned directly - prefix with ['bun', 'run'].
  const isWindows = process.platform === 'win32'
  const head = isWindows && rawHead[0]?.endsWith('.js')
    ? ['bun', 'run', ...rawHead]
    : rawHead
  const cmd = [
    ...head,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // multica-proven non-interactive form; V6 to re-confirm vs --dangerously-skip-permissions.
    '--permission-mode',
    'bypassPermissions',
  ]
  if (ctx.model !== undefined && ctx.model.length > 0) cmd.push('--model', ctx.model)
  cmd.push('--append-system-prompt-file', systemPromptFile)
  // RFC-111 PR-C: MCP via --mcp-config (+ --strict-mcp-config so repo .mcp.json
  // can't shadow the platform set, mirroring opencode's inline-config precedence).
  if (ctx.mcpConfigJson !== undefined && ctx.mcpConfigJson.length > 0) {
    cmd.push('--mcp-config', ctx.mcpConfigJson, '--strict-mcp-config')
  }
  // RFC-111 PR-C: dependsOn closure → claude subagents.
  if (ctx.agentsJson !== undefined && ctx.agentsJson.length > 0) {
    cmd.push('--agents', ctx.agentsJson)
  }
  if (ctx.resumeSessionId !== undefined && ctx.resumeSessionId.length > 0) {
    cmd.push('--resume', ctx.resumeSessionId)
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // opencode needed PWD=cwd; Claude Code resolves the project slug from cwd too,
    // and we keep PWD aligned so the transcript project dir matches the worktree.
    PWD: ctx.worktreePath,
    // D16: relocate the config root per attempt → transcript + skills isolation.
    // (Subscription auth bridge + skills land in PR-C; API-key auth flows via the
    // inherited env and is orthogonal to this dir.)
    CLAUDE_CONFIG_DIR: configDir,
    // Spread LAST so a root daemon's injected IS_SANDBOX=1 also wins over an
    // inherited IS_SANDBOX=0 (claude's gate wants the exact string '1').
    ...claudeSandboxEnv(process.getuid?.()),
  }
  const gitName = typeof ctx.gitUserName === 'string' ? ctx.gitUserName : ''
  const gitEmail = typeof ctx.gitUserEmail === 'string' ? ctx.gitUserEmail : ''
  if (gitName.length > 0 && gitEmail.length > 0) {
    env.GIT_AUTHOR_NAME = gitName
    env.GIT_AUTHOR_EMAIL = gitEmail
    env.GIT_COMMITTER_NAME = gitName
    env.GIT_COMMITTER_EMAIL = gitEmail
  }

  return { cmd, env, stdin: { mode: 'pipe', data: ctx.prompt } }
}
