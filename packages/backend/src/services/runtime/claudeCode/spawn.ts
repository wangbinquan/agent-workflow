// Claude Code natural CLI assembly.
//
// The platform owns only product inputs: persona, model, selected MCP/subagents,
// explicit agent permissions, resume id, cwd, Git identity and the stream-json
// transport. Machine/project configuration, credentials, plugins, skills and
// environment discovery stay under Claude Code's normal rules.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnPlan } from '../types'
import { renderClaudeBoundary } from '@/services/execution/workspaceBoundary'

export interface ClaudeSpawnContext {
  /** Override `['claude']` (tests pass a mock command array). */
  claudeCmd?: string[]
  /** User prompt — delivered over stdin. */
  prompt: string
  /** Agent persona plus any platform-managed attachment text. */
  systemPromptText: string
  model?: string
  resumeSessionId?: string
  /** Run-local directory used only for the generated system prompt file. */
  attemptDir: string
  worktreePath: string
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** Platform-selected MCP config accepted by Claude's native CLI. */
  mcpConfigJson?: string
  /** Platform-selected dependent agents accepted by Claude's native CLI. */
  agentsJson?: string
  /** Present only when the user authored an explicit agent permission map. */
  businessTools?: string
  /** Names used to allow the selected MCP namespaces under explicit permission. */
  mcpServerNames?: readonly string[]
  /** RFC-276: opt-in CLI compatibility marker; does not enable an OS sandbox. */
  isSandbox?: boolean
  /**
   * RFC-281 T2/T3: task workspace boundary. When present, a per-run
   * `settings.json` is written next to the system prompt and passed via
   * `--settings`, enabling Claude's own sandbox WRITE boundary (write = cwd +
   * tmp + these mounts). Omitted → argv/behavior byte-identical to pre-RFC-281.
   */
  boundary?: {
    taskMounts: readonly string[]
    gitMetaDirs?: readonly string[]
    authorAllowDirs?: readonly string[]
  }
  extraArgs?: readonly string[]
  /** Called when stored extraArgs carried a platform-owned flag (see below). */
  onExtraArgsDropped?: (dropped: readonly string[]) => void
  /** Called for mounts whose path cannot be expressed as a permission rule. */
  onUnexpressibleBoundaryDirs?: (dirs: readonly string[]) => void
}

/** Headless transport base shared by every platform-spawned Claude child. */
export const CLAUDE_HEADLESS_BASE_ARGV: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
])

/**
 * Flags assembled by the platform. Runtime-specific `extraArgs` cannot replace
 * these transport/product values; this validation is argv correctness, not an
 * execution boundary.
 */
export const CLAUDE_PLATFORM_OWNED_FLAGS: ReadonlySet<string> = new Set([
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '--verbose',
  '--model',
  '--append-system-prompt-file',
  '--append-system-prompt',
  '--system-prompt',
  '--system-prompt-file',
  '--mcp-config',
  '--agents',
  '--resume',
  '--continue',
  '--session-id',
  '--fork-session',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  // RFC-281 T2/T3: the per-run settings file carries the workspace write
  // boundary; extraArgs must not replace it.
  '--settings',
])

export interface ClaudeExplicitPermissionArgv {
  /** User-derived built-in load set. */
  tools: string
  /** Optional selected MCP config path (playground use). */
  mcpConfigFile?: string
  /** User-derived allowed MCP namespace pattern(s). */
  allowedTools?: string
  /** A dependency closure needs Task in addition to the authored tool set. */
  subagentsGranted?: boolean
}

function claudeLoadedTools(input: ClaudeExplicitPermissionArgv): string {
  if (input.subagentsGranted !== true) return input.tools
  const loaded = input.tools.split(',').filter((tool) => tool.length > 0)
  if (!loaded.includes('Task')) loaded.push('Task')
  return loaded.join(',')
}

/** Materialize only an explicit user permission declaration. */
export function claudeExplicitPermissionArgv(input: ClaudeExplicitPermissionArgv): string[] {
  return [
    '--permission-mode',
    'dontAsk',
    '--tools',
    claudeLoadedTools(input),
    ...(input.mcpConfigFile === undefined ? [] : ['--mcp-config', input.mcpConfigFile]),
    ...(input.allowedTools === undefined ? [] : ['--allowedTools', input.allowedTools]),
  ]
}

export function buildClaudeSpawn(ctx: ClaudeSpawnContext): SpawnPlan {
  mkdirSync(ctx.attemptDir, { recursive: true })
  const systemPromptFile = join(ctx.attemptDir, 'system.md')
  writeFileSync(systemPromptFile, ctx.systemPromptText)

  const explicitPermission = ctx.businessTools !== undefined
  // RFC-281 T2/T3: per-run settings carrying the WRITE boundary (Claude's own
  // sandbox). No denyWrite/denyRead is emitted — an appHome-ancestor denyWrite
  // would shadow the agent's own cwd (T0 §5-2), and the sandbox default
  // (write = cwd + tmp + allowWrite) already refuses sibling task worktrees.
  let settingsFile: string | undefined
  // A boundary with no mounts cannot express a workspace, and emitting an empty
  // allowWrite would leave the sandbox enabled with cwd-only writes derived from
  // nothing — fail OPEN (no settings file) rather than risk fencing off a
  // legitimate run (§0: business must not be collateral damage).
  const boundaryMounts = (ctx.boundary?.taskMounts ?? []).filter((p) => p.length > 0)
  if (ctx.boundary !== undefined && boundaryMounts.length > 0) {
    const rendered = renderClaudeBoundary({
      taskMounts: boundaryMounts,
      ...(ctx.boundary.gitMetaDirs === undefined ? {} : { gitMetaDirs: ctx.boundary.gitMetaDirs }),
      ...(ctx.boundary.authorAllowDirs === undefined
        ? {}
        : { authorAllowDirs: ctx.boundary.authorAllowDirs }),
      explicitPermission,
    })
    if (rendered.unexpressibleDirs.length > 0) {
      ctx.onUnexpressibleBoundaryDirs?.(rendered.unexpressibleDirs)
    }
    settingsFile = join(ctx.attemptDir, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify(rendered.settings, null, 2))
  }
  const mcpAllowedTools = (ctx.mcpServerNames ?? []).map((name) => `mcp__${name}__*`).join(',')
  const cmd = [
    ...(ctx.claudeCmd ?? ['claude']),
    ...CLAUDE_HEADLESS_BASE_ARGV,
    ...(explicitPermission
      ? claudeExplicitPermissionArgv({
          tools: ctx.businessTools as string,
          ...(mcpAllowedTools.length > 0 ? { allowedTools: mcpAllowedTools } : {}),
          ...(ctx.agentsJson !== undefined && ctx.agentsJson.length > 0
            ? { subagentsGranted: true }
            : {}),
        })
      : ['--permission-mode', 'bypassPermissions']),
  ]
  if (ctx.model !== undefined && ctx.model.length > 0) cmd.push('--model', ctx.model)
  // RFC-281: settings layer is merged per key by the CLI; we only pin the
  // sandbox write boundary (see composeClaudeBoundarySettings).
  if (settingsFile !== undefined) cmd.push('--settings', settingsFile)
  cmd.push('--append-system-prompt-file', systemPromptFile)
  if (ctx.mcpConfigJson !== undefined && ctx.mcpConfigJson.length > 0) {
    cmd.push('--mcp-config', ctx.mcpConfigJson)
  }
  if (ctx.agentsJson !== undefined && ctx.agentsJson.length > 0) {
    cmd.push('--agents', ctx.agentsJson)
  }
  if (ctx.resumeSessionId !== undefined && ctx.resumeSessionId.length > 0) {
    cmd.push('--resume', ctx.resumeSessionId)
  }
  // RFC-281 (impl-gate P2-4): `--settings` only became platform-owned in this
  // RFC, so a runtime row saved BEFORE it could legitimately carry
  // `--settings /ops/mine.json` in extra_args_json. The save-time validator
  // never re-runs for stored rows, and extraArgs land at the argv TAIL — the
  // operator's file would silently win over the workspace boundary. Drop any
  // platform-owned token here (spawn is the last gate) and report it.
  if (ctx.extraArgs !== undefined && ctx.extraArgs.length > 0) {
    const kept: string[] = []
    const dropped: string[] = []
    for (let i = 0; i < ctx.extraArgs.length; i += 1) {
      const arg = ctx.extraArgs[i] as string
      const bare = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      if (CLAUDE_PLATFORM_OWNED_FLAGS.has(bare)) {
        dropped.push(arg)
        // a bare `--flag value` pair drops its value too
        const next = ctx.extraArgs[i + 1]
        if (!arg.includes('=') && next !== undefined && !next.startsWith('-')) {
          dropped.push(next)
          i += 1
        }
        continue
      }
      kept.push(arg)
    }
    if (dropped.length > 0) ctx.onExtraArgsDropped?.(dropped)
    cmd.push(...kept)
  }

  return {
    cmd,
    env: assembleClaudeEnv({
      worktreePath: ctx.worktreePath,
      gitUserName: ctx.gitUserName,
      gitUserEmail: ctx.gitUserEmail,
      isSandbox: ctx.isSandbox,
    }),
    stdin: { mode: 'pipe', data: ctx.prompt },
  }
}

export interface ClaudeEnvAssembly {
  worktreePath: string
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** When true, inject the upstream Claude CLI compatibility marker. */
  isSandbox?: boolean
}

/**
 * Full daemon environment plus the product-owned cwd, optional Claude CLI
 * compatibility marker, and optional Git identity. The marker is controlled by
 * the runtime profile and is not evidence of a platform OS sandbox.
 */
export function assembleClaudeEnv(
  assembly: ClaudeEnvAssembly,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    // Runtime config owns this marker. Scrub ambient values first so the
    // default-off state is deterministic, including case-folded Windows envs.
    if (key.toUpperCase() === 'IS_SANDBOX') continue
    if (typeof value === 'string') env[key] = value
  }
  env.PWD = assembly.worktreePath
  if (assembly.isSandbox === true) env.IS_SANDBOX = '1'
  const gitName = typeof assembly.gitUserName === 'string' ? assembly.gitUserName : ''
  const gitEmail = typeof assembly.gitUserEmail === 'string' ? assembly.gitUserEmail : ''
  if (gitName.length > 0 && gitEmail.length > 0) {
    env.GIT_AUTHOR_NAME = gitName
    env.GIT_AUTHOR_EMAIL = gitEmail
    env.GIT_COMMITTER_NAME = gitName
    env.GIT_COMMITTER_EMAIL = gitEmail
  }
  return env
}
