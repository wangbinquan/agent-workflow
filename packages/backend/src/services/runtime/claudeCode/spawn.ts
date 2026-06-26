// RFC-111 PR-B — Claude Code argv + env assembly (core).
//
// Contract verified hands-on against claude 2.1.193 (design §6.1):
//   claude -p --output-format stream-json --verbose --permission-mode bypassPermissions
//          [--model <alias|id>] --append-system-prompt-file <file>
//          [--disallowed-tools "<writes>"] [--resume <id>]
//   • prompt delivered via STDIN (D12 — avoids argv E2BIG; ≤10MB cap, V9)
//   • env: PWD=worktree, CLAUDE_CONFIG_DIR=<attemptDir>/.claude (transcript +
//     skills isolation, D16), auth inherited from process.env (ANTHROPIC_API_KEY
//     / OAuth token / etc.), RFC-067 git identity.
//
// PR-B scope = persona (system prompt) + model + readonly tool-gate + stdin
// prompt + stream-json. Skills / MCP / dependsOn subagents / subscription
// credential bridge land in PR-C (prepareClaudeAttemptDir).
//
// Leaf module: imports node:fs/path + runtime types only → no module-init cycle.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnPlan } from '../types'

export interface ClaudeSpawnContext {
  /** Override `['claude']` (tests pass `['bun','run',mock]`). */
  claudeCmd?: string[]
  /** User prompt — delivered via stdin. */
  prompt: string
  /** Agent persona (bodyMd + any injected memory block) → --append-system-prompt-file. */
  systemPromptText: string
  /** claude --model (alias or full id). Omitted → claude's own default. */
  model?: string
  /** readonly agent → best-effort write-tool gate (D7). */
  readonly?: boolean
  /** RFC-026 clarify-inline rerun → --resume <id> (PR-C wires this). */
  resumeSessionId?: string
  /** Per-attempt config-dir root; `.claude/` is created under it. */
  attemptDir: string
  /** Subprocess cwd = task worktree. */
  worktreePath: string
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
}

/** Best-effort readonly write-tool denial (D7 — not a sandbox; Bash/MCP still write). */
export const CLAUDE_READONLY_DISALLOWED_TOOLS = 'Write Edit MultiEdit NotebookEdit'

export function buildClaudeSpawn(ctx: ClaudeSpawnContext): SpawnPlan {
  const configDir = join(ctx.attemptDir, '.claude')
  mkdirSync(configDir, { recursive: true })
  // Persona file consumed by --append-system-prompt-file (append, not replace:
  // keeps Claude Code's own tool/harness scaffolding — RFC-111 D6).
  const systemPromptFile = join(ctx.attemptDir, 'system.md')
  writeFileSync(systemPromptFile, ctx.systemPromptText)

  const head = ctx.claudeCmd ?? ['claude']
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
  if (ctx.readonly === true) cmd.push('--disallowed-tools', CLAUDE_READONLY_DISALLOWED_TOOLS)
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
