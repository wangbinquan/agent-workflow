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

/** Minimal shape buildCommand needs (a structural subset of RunNodeOptions). */
export interface OpencodeCommandOptions {
  /** Override `['opencode']` (tests pass `['bun','run',mock]`). */
  opencodeCmd?: string[]
  agent: { name: string }
  /** RFC-026 clarify-inline rerun: resume the prior opencode session. */
  resumeSessionId?: string
}

export function buildCommand(opts: OpencodeCommandOptions, prompt: string): string[] {
  const rawHead = opts.opencodeCmd ?? ['opencode']
  // On Windows, .js files cannot be spawned directly — prefix with ['bun', 'run'].
  const isWindows = process.platform === 'win32'
  const head = isWindows && rawHead[0]?.endsWith('.js')
    ? ['bun', 'run', ...rawHead]
    : rawHead
  // `--thinking` makes opencode emit `reasoning` events to stdout in
  // `--format json` mode; without it `cli/cmd/run.ts:671` filters them
  // out and the SessionTab can never show the model's thinking blocks.
  //
  // `--dangerously-skip-permissions` is UNCONDITIONAL: the CLI run has no
  // permission-answer channel, so a non-skip run would hang on the first
  // tool prompt. flag-audit W0（§3 假旋钮）删掉了从未有生产调用方传值的
  // `dangerouslySkipPermissions?: boolean` 参数——想恢复可配置需先解决应答通道。
  // Windows: Bun.spawn truncates argv elements at '\n', which corrupts
  // multi-line prompts AND drops all argv args after the newline. opencode
  // reads the prompt from stdin when no positional is given, so on Windows
  // we omit the prompt from argv (the runner pipes it via stdin via
  // buildOpencodeSpawn's stdin plan).
  const cmd = [
    ...head,
    'run',
    ...(isWindows ? [] : [prompt]),
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
  /** Per-run OPENCODE_CONFIG_DIR (framework-managed skills live under it). */
  runDir: string
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
 * inline block in runNode (PWD fix, OPENCODE_CONFIG_DIR/CONTENT, conditional
 * OPENCODE_AW_INVENTORY_OUT, RFC-067 git identity).
 */
export function buildOpencodeEnv(ctx: OpencodeEnvContext): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // opencode 1.14.51+ resolves its root via `process.env.PWD ?? process.cwd()`;
    // Bun.spawn's `cwd:` updates cwd but leaves PWD inherited from the daemon,
    // so without forcing PWD = worktree opencode loads two Instances and the
    // `--format json` events stop reaching our stdout pump. See runner.ts.
    PWD: ctx.worktreePath,
    OPENCODE_CONFIG_DIR: ctx.runDir,
    OPENCODE_CONFIG_CONTENT: ctx.inlineConfigSerialized,
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
