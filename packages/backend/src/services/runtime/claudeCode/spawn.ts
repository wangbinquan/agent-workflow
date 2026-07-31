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
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import { createLogger, type Logger } from '@/util/log'
import type { SpawnPlan, SystemPermissionProfile } from '../types'
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
  /** Per-attempt config-dir root; `<configDirName>/` is created under it. */
  attemptDir: string
  /**
   * RFC-154: config-dir overrides for custom forks. Omitted → protocol default
   * (`CLAUDE_CONFIG_DIR` / `.claude`, shared DEFAULT_CONFIG_DIR_PROFILE) —
   * byte-identical for every pre-RFC-154 caller (incl. the system-agent path,
   * which stays on the defaults by design — RFC-154 §2.3).
   */
  configDirEnv?: string
  configDirName?: string
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
  /**
   * RFC-237 — frozen system-permission profile. 'intent-read-v1' switches the
   * argv/env assembly to the declared-control read-only shape (design §2.2-2.3):
   * `--tools Read,Grep,Glob` load-set pruning + dontAsk + strict-mcp +
   * `--setting-sources ""` + `--disable-slash-commands`, controlled env
   * (internal-marker stripping + hardening injections, NO IS_SANDBOX).
   * Omitted / 'all-deny' → the legacy bypass shape, byte-unchanged.
   */
  systemPermissionProfile?: SystemPermissionProfile
  log?: Logger
}

/**
 * RFC-237 design §2.3 — internal Claude Code runtime markers that must never
 * leak into a declared-control child: the child would mistake itself for a
 * nested/resumed session or inherit the parent's exec path / IDE transport
 * (same closed list multica's claude backend strips, verified against 2.1.220).
 * `IS_SANDBOX` is stripped too (design-gate P2-2): the INHERITED value is
 * ambient state, not a platform decision — stripping keeps the controlled env
 * deterministic. When the daemon itself runs as uid 0, the branch tail then
 * re-injects a deliberate `IS_SANDBOX=1` via claudeSandboxEnv (2026-07-31
 * root-deployment report): a root daemon is a container-shaped deployment, the
 * assertion is honest there, and it forward-proofs against any claude release
 * widening its root gate beyond the two bypass-only checks verified on
 * 2.1.220. The user-facing `CLAUDE_CODE_*` config namespace (GIT_BASH_PATH,
 * USE_BEDROCK, …) passes through untouched — users set those deliberately.
 */
const CLAUDE_INTERNAL_ENV_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'IS_SANDBOX',
])

/** RFC-237 design §2.3 — inherit-minus-blacklist (NOT an allowlist: the auth
 *  variable families — ANTHROPIC_*, CLAUDE_CODE_OAUTH_TOKEN, AWS_* and
 *  GOOGLE_*, proxies — are open-ended and an allowlist would break them). */
export function claudeControlledInheritEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (CLAUDE_INTERNAL_ENV_MARKERS.has(key)) continue
    if (key.startsWith('CLAUDECODE_')) continue
    env[key] = value
  }
  return env
}

/** RFC-237 design §2.3 — hardening injections for the declared-control branch:
 *  no auto-update, no telemetry/error reporting, no nonessential traffic.
 *  Spread AFTER the inherited env so a daemon-level opt-in cannot re-enable. */
const CLAUDE_READONLY_HARDENING_ENV = Object.freeze({
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})

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
  // RFC-154: leaf name is configurable (custom forks); default = .claude.
  const configDir = join(
    ctx.attemptDir,
    ctx.configDirName ?? DEFAULT_CONFIG_DIR_PROFILE['claude-code'].name,
  )
  mkdirSync(ctx.attemptDir, { recursive: true })
  // RFC-111 PR-C: prepare CLAUDE_CONFIG_DIR — inject skills + (real runs only)
  // bridge the subscription credential so the relocated dir can still auth.
  prepareClaudeConfigDir(configDir, ctx.skills ?? [], log, ctx.bridgeCredentials === true)
  // Persona file consumed by --append-system-prompt-file (append, not replace:
  // keeps Claude Code's own tool/harness scaffolding — RFC-111 D6).
  const systemPromptFile = join(ctx.attemptDir, 'system.md')
  writeFileSync(systemPromptFile, ctx.systemPromptText)

  const head = ctx.claudeCmd ?? ['claude']
  const readOnlyIntent = ctx.systemPermissionProfile === 'intent-read-v1'
  const cmd = [
    ...head,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(readOnlyIntent
      ? [
          // RFC-237 design §2.2 (hands-on verified on 2.1.220): --tools prunes
          // the LOADED tool set (init echoes exactly these three; Write returns
          // "No such tool available" and the run continues; Bash is invisible);
          // dontAsk is the permission-layer backstop — outside-cwd reads are
          // auto-denied (design §2.1 #11-13), in-cwd reads auto-allowed, no
          // interactive hang possible. strict-mcp with NO --mcp-config → zero
          // MCP servers; --setting-sources "" cuts user/project/local settings;
          // --disable-slash-commands is defense-in-depth against config-dir
          // skill loading. NOT bypassPermissions; IS_SANDBOX is still injected
          // on uid-0 daemons (env tail) as an honest container assertion.
          '--permission-mode',
          'dontAsk',
          '--tools',
          'Read,Grep,Glob',
          '--strict-mcp-config',
          '--setting-sources',
          '',
          '--disable-slash-commands',
        ]
      : [
          // multica-proven non-interactive form; V6 to re-confirm vs --dangerously-skip-permissions.
          '--permission-mode',
          'bypassPermissions',
        ]),
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

  const configDirEnv = ctx.configDirEnv ?? DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env
  const env: Record<string, string> = {
    // RFC-237 design §2.3: the declared-control branch inherits minus the
    // internal-marker blacklist (incl. IS_SANDBOX); the legacy branch keeps the
    // full-inherit shape byte-unchanged.
    ...(readOnlyIntent
      ? claudeControlledInheritEnv(process.env)
      : (process.env as Record<string, string>)),
    // opencode needed PWD=cwd; Claude Code resolves the project slug from cwd too,
    // and we keep PWD aligned so the transcript project dir matches the worktree.
    PWD: ctx.worktreePath,
    // D16: relocate the config root per attempt → transcript + skills isolation.
    // (Subscription auth bridge + skills land in PR-C; API-key auth flows via the
    // inherited env and is orthogonal to this dir.)
    // RFC-154: key is configurable (custom forks); default = CLAUDE_CONFIG_DIR.
    [configDirEnv]: configDir,
    // Spread LAST: legacy branch — a root daemon's injected IS_SANDBOX=1 wins
    // over an inherited IS_SANDBOX=0 (claude's gate wants the exact '1');
    // read-only branch — hardening injections win over any daemon-level opt-in,
    // and a uid-0 daemon re-asserts IS_SANDBOX=1 DELIBERATELY (2026-07-31 root
    // deployment report): the inherited value was stripped for determinism, a
    // root daemon is a container-shaped deployment where the assertion is
    // honest, and this forward-proofs against claude releases widening the
    // root gate beyond the bypass-only checks verified on 2.1.220. Non-root
    // spawns still get nothing on either branch.
    ...(readOnlyIntent
      ? { ...CLAUDE_READONLY_HARDENING_ENV, ...claudeSandboxEnv(process.getuid?.()) }
      : claudeSandboxEnv(process.getuid?.())),
  }
  // RFC-154 (Codex impl-gate P2): with a CUSTOM key, scrub the protocol default
  // inherited from the daemon's own environment — otherwise the child carries
  // BOTH keys and a fork that still consults the default one lands in a stale
  // dir. Default-key spawns are untouched (we just wrote it ourselves).
  if (configDirEnv !== DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env) {
    delete env[DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env]
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
