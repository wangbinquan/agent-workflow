// RFC-111 PR-A(A2) — opencode argv + env assembly, extracted from runner.ts
// WITHOUT behavior change. This is the runtime-specific spawn surface the
// golden test locks byte-for-byte; the claude driver (PR-B) produces a
// different cmd/env from the same raw materials.
//
// `buildInlineConfig` stays in runner.ts: it is built there and then MUTATED in
// place (RFC-029 inventory plugin append + RFC-041 memory-block append) before
// spawn, so this module receives the already-serialized inline config.
//
// Leaf module: imports nothing from runner.ts → no module-init cycle.
// (RFC-154: the shared config-dir profile is a cross-package leaf import.)

import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'

/** Minimal shape buildCommand needs (a structural subset of RunNodeOptions). */
export interface OpencodeCommandOptions {
  /** Override `['opencode']` (tests pass `['bun','run',mock]`). */
  opencodeCmd?: string[]
  agent: { name: string }
  /** RFC-026 clarify-inline rerun: resume the prior opencode session. */
  resumeSessionId?: string
}

/**
 * Linux caps a single argv element (execve MAX_ARG_STRLEN) at 128 KiB —
 * independent of the larger ARG_MAX total-size limit, and not raisable by
 * ulimit. opencode takes the prompt as a POSITIONAL argument, so a large
 * `{{git_diff}}` expansion makes the spawn fail with E2BIG: the child never
 * starts and the user sees a raw kernel error instead of an actionable one.
 * Guard with headroom (the rest of argv + the ~128 KiB env also count toward
 * ARG_MAX) and fail READABLY here — buildCommand runs during spawn assembly,
 * which the runner catches and turns into the node's errorMessage
 * (runner.ts "runtime-spawn-failed"). claude is unaffected: its driver pipes
 * the prompt through stdin, never argv.
 * See design/test-guard-audit-2026-07-21 gap B4-runtime-5 / Top-14.
 */
export const MAX_OPENCODE_PROMPT_BYTES = 120 * 1024

export function buildCommand(opts: OpencodeCommandOptions, prompt: string): string[] {
  // Measure BYTES, not code units — a CJK-heavy prompt is ~3x its `.length`.
  const promptBytes = Buffer.byteLength(prompt, 'utf8')
  if (promptBytes > MAX_OPENCODE_PROMPT_BYTES) {
    throw new Error(
      `prompt-too-large: opencode prompt is ${promptBytes} bytes, over the ` +
        `${MAX_OPENCODE_PROMPT_BYTES}-byte argv limit (Linux caps one argument at ` +
        `128 KiB); reduce the diff or inputs feeding this node`,
    )
  }
  const head = opts.opencodeCmd ?? ['opencode']
  // `--thinking` makes opencode emit `reasoning` events to stdout in
  // `--format json` mode; without it `cli/cmd/run.ts:671` filters them
  // out and the SessionTab can never show the model's thinking blocks.
  //
  // `--dangerously-skip-permissions` is UNCONDITIONAL: the CLI run has no
  // permission-answer channel, so a non-skip run would hang on the first
  // tool prompt. flag-audit W0（§3 假旋钮）删掉了从未有生产调用方传值的
  // `dangerouslySkipPermissions?: boolean` 参数——想恢复可配置需先解决应答通道。
  const cmd = [
    ...head,
    'run',
    prompt,
    '--agent',
    opts.agent.name,
    '--format',
    'json',
    '--thinking',
    '--dangerously-skip-permissions',
  ]
  // RFC-026: clarify-inline rerun — resume the prior opencode session so the
  // agent has its full prior transcript + state. Only ever populated by the
  // scheduler on the clarify-driven path (review / retry / loop paths leave
  // it undefined). Empty string is treated the same as undefined.
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  return cmd
}

export interface OpencodeEnvContext {
  /** opencode subprocess cwd = task worktree. */
  worktreePath: string
  /** Per-run config dir (framework-managed skills live under it). */
  runDir: string
  /**
   * RFC-154: the env var NAME `runDir` is exported through. Omitted → the
   * protocol default (`OPENCODE_CONFIG_DIR`, shared DEFAULT_CONFIG_DIR_PROFILE)
   * — byte-identical for every pre-RFC-154 caller. A custom fork that renamed
   * the variable gets its name from the runtime row's frozen configDir.env.
   */
  configDirEnv?: string
  /** JSON.stringify of the built+mutated inline agent/mcp/plugin config. */
  inlineConfigSerialized: string
  /** RFC-029 inventory snapshot output path; omitted → env var not set. */
  inventoryOutPath?: string
  /** RFC-067 per-task git identity (both must be non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
}

/**
 * Build the opencode subprocess env. Byte-identical to the pre-RFC-111
 * inline block in runNode (PWD fix, config-dir env + OPENCODE_CONFIG_CONTENT,
 * conditional OPENCODE_AW_INVENTORY_OUT, RFC-067 git identity).
 */
export function buildOpencodeEnv(ctx: OpencodeEnvContext): Record<string, string> {
  const configDirEnv = ctx.configDirEnv ?? DEFAULT_CONFIG_DIR_PROFILE.opencode.env
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // opencode 1.14.51+ resolves its root via `process.env.PWD ?? process.cwd()`;
    // Bun.spawn's `cwd:` updates cwd but leaves PWD inherited from the daemon,
    // so without forcing PWD = worktree opencode loads two Instances and the
    // `--format json` events stop reaching our stdout pump. See runner.ts.
    PWD: ctx.worktreePath,
    // RFC-154: key is configurable (custom forks); default = OPENCODE_CONFIG_DIR.
    [configDirEnv]: ctx.runDir,
    OPENCODE_CONFIG_CONTENT: ctx.inlineConfigSerialized,
  }
  // RFC-154 (Codex impl-gate P2): with a CUSTOM key, scrub the protocol default
  // inherited from the daemon's own environment — otherwise the child carries
  // BOTH keys and a fork that still consults the default one lands in a stale
  // dir. Default-key spawns are untouched (we just wrote it ourselves).
  if (configDirEnv !== DEFAULT_CONFIG_DIR_PROFILE.opencode.env) {
    delete env[DEFAULT_CONFIG_DIR_PROFILE.opencode.env]
  }
  // RFC-029: tell the dump plugin where to write the snapshot file. Set only
  // when the plugin was actually injected — otherwise leaving it unset keeps
  // any externally-set value (mock-opencode) from being hijacked.
  if (ctx.inventoryOutPath !== undefined) {
    env.OPENCODE_AW_INVENTORY_OUT = ctx.inventoryOutPath
  }
  // RFC-067: per-task git identity. Author + committer set together — if either
  // side is empty/null the entire block is skipped so the daemon's existing
  // identity resolution keeps working unchanged.
  const gitName = typeof ctx.gitUserName === 'string' ? ctx.gitUserName : ''
  const gitEmail = typeof ctx.gitUserEmail === 'string' ? ctx.gitUserEmail : ''
  if (gitName.length > 0 && gitEmail.length > 0) {
    env.GIT_AUTHOR_NAME = gitName
    env.GIT_AUTHOR_EMAIL = gitEmail
    env.GIT_COMMITTER_NAME = gitName
    env.GIT_COMMITTER_EMAIL = gitEmail
  }
  return env
}

export interface OpencodeSpawnContext extends OpencodeEnvContext {
  opencodeCmd?: string[]
  agentName: string
  prompt: string
  resumeSessionId?: string
}

/** Combine argv + env into one spawn plan (the opencode driver's buildSpawn). */
export function buildOpencodeSpawn(ctx: OpencodeSpawnContext): {
  cmd: string[]
  env: Record<string, string>
} {
  const cmd = buildCommand(
    {
      opencodeCmd: ctx.opencodeCmd,
      agent: { name: ctx.agentName },
      resumeSessionId: ctx.resumeSessionId,
    },
    ctx.prompt,
  )
  const env = buildOpencodeEnv(ctx)
  return { cmd, env }
}
