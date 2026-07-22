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
import { compareSemver, extractVersion } from '@/util/semver'

/** Minimal shape buildCommand needs (a structural subset of RunNodeOptions). */
export interface OpencodeCommandOptions {
  /** Override `['opencode']` (tests pass `['bun','run',mock]`). */
  opencodeCmd?: string[]
  agent: { name: string }
  /** RFC-026 clarify-inline rerun: resume the prior opencode session. */
  resumeSessionId?: string
  /**
   * Probed version of the binary this argv will be fed to (drivers read it
   * from util/opencode-version-registry). Picks the auto-approve flag
   * SPELLING — see resolveAutoApproveFlag. Omitted/null/unparseable → the
   * legacy spelling (deliberate: every test stub reports ≤1.14.99 or is never
   * probed, so the golden argv and both stub families stay byte-identical).
   */
  binaryVersion?: string | null
}

/**
 * opencode ≥ this version renamed `run --dangerously-skip-permissions` →
 * `--auto` (pure rename — identical describe string; the legacy spelling is
 * REMOVED, not aliased).
 */
export const OPENCODE_AUTO_FLAG_MIN_VERSION = '1.18.0'

/**
 * Pick the auto-approve flag spelling for the probed binary version.
 *
 * 2026-07-21 incident: on opencode 1.18.3 the legacy spelling is an unknown
 * argument to the `.strict()` parser, and opencode's custom `.fail()`
 * (opencode/src/index.ts:104-114) swallows the "Unknown argument" line and
 * prints ONLY the `run` usage before exit 1 — so every spawn on this machine
 * died with a bare usage dump and zero stdout. Version-gate the spelling
 * instead of flipping it wholesale: MIN_OPENCODE_VERSION is 1.14.0, both
 * generations must keep working.
 *
 * Unknown (null/undefined/unparseable) → LEGACY spelling, deliberately:
 *  - the daemon boot-probes the default binary before anything can spawn, so
 *    real runs always resolve a version (this machine: 1.18.3 → `--auto`);
 *  - the TS mocks (`['bun','run',…]` heads) and the six e2e shell stubs
 *    (report 1.14.99) then keep today's argv byte-for-byte.
 */
export function resolveAutoApproveFlag(
  binaryVersion: string | null | undefined,
): '--auto' | '--dangerously-skip-permissions' {
  if (binaryVersion == null) return '--dangerously-skip-permissions'
  // Normalize through extractVersion FIRST: compareSemver returns 0 ("equal")
  // for unparseable input, which would silently pick `--auto` for garbage.
  const parsed = extractVersion(binaryVersion)
  if (parsed === null) return '--dangerously-skip-permissions'
  return compareSemver(parsed, OPENCODE_AUTO_FLAG_MIN_VERSION) >= 0
    ? '--auto'
    : '--dangerously-skip-permissions'
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
  // The auto-approve flag is UNCONDITIONAL: the CLI run has no
  // permission-answer channel, so a non-skip run would hang on the first
  // tool prompt. flag-audit W0（§3 假旋钮）删掉了从未有生产调用方传值的
  // `dangerouslySkipPermissions?: boolean` 参数——想恢复可配置需先解决应答通道。
  // Its SPELLING is version-gated: opencode ≥1.18 removed
  // `--dangerously-skip-permissions` in favor of `--auto` — see
  // resolveAutoApproveFlag above (2026-07-21 incident lock).
  const cmd = [
    ...head,
    'run',
    '--agent',
    opts.agent.name,
    '--format',
    'json',
    '--thinking',
    resolveAutoApproveFlag(opts.binaryVersion),
  ]
  // RFC-026: clarify-inline rerun — resume the prior opencode session so the
  // agent has its full prior transcript + state. Only ever populated by the
  // scheduler on the clarify-driven path (review / retry / loop paths leave
  // it undefined). Empty string is treated the same as undefined.
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
    cmd.push('--session', opts.resumeSessionId)
  }
  // The user prompt is delivered as a TRAILING positional after an explicit `--`
  // end-of-options separator — never as a bare positional right after `run`.
  // opencode's top-level parser is `.strict()` (opencode/src/index.ts:116), so a
  // bare positional whose first character is `-` is scanned as an option, and an
  // unknown one makes opencode print the `run` usage to stderr and exit 1 BEFORE
  // doing any work. This bites every prompt starting with a dash — most notably
  // the RFC-200 injection-boundary wrapper (prompt.ts prepends
  // `---\n**Untrusted input boundary.…`, present on every run that carries an
  // <aw-input> block, i.e. all workgroup runs), but also any agent prompt whose
  // first line is a markdown list. Routing the prompt through `--` lands it in
  // yargs' `args["--"]` bucket, which run.ts merges straight back into the
  // message (`[...args.message, ...(args["--"] || [])].join(" ")`, run.ts:250/264
  // — opencode sets `parserConfiguration({"populate--": true})`), so the prompt
  // arrives byte-for-byte while never being scanned for flags. Keep this LAST.
  cmd.push('--', prompt)
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

/**
 * Linux's execve caps a SINGLE argv/env string at MAX_ARG_STRLEN = 32 pages =
 * 128 KiB on a 4 KiB-page kernel (`man 2 execve`). Unlike the total ARG_MAX
 * budget this is a fixed per-string limit, and unlike macOS (which enforces only
 * the ~1 MiB total ARG_MAX, with no per-string cap) it can reject one oversized
 * env value on its own. This is the ONE spawn-size bound that is a hard, portable
 * constant rather than a runtime- and sandbox-dependent estimate.
 */
export const LINUX_MAX_ARG_STRLEN = 128 * 1024

/**
 * Fail READABLY when the one env string this driver injects unbounded —
 * OPENCODE_CONFIG_CONTENT, a large inline agent/MCP/config body that
 * buildOpencodeEnv writes with no size check of its own (upstream only emits a
 * UTF-16 `.length` warning) — would cross Linux's per-string execve limit,
 * instead of a raw E2BIG the user cannot act on. The runner maps the throw to
 * the node's `runtime-spawn-failed` errorMessage.
 *
 * Scoped deliberately narrow, because getting a spawn-size guard WRONG breaks
 * every spawn rather than an oversized one:
 *  - only OPENCODE_CONFIG_CONTENT, never the inherited process.env — a legitimate
 *    ambient variable must not be able to fail an otherwise-valid spawn;
 *  - only on Linux — macOS enforces no per-string cap, so the same value that
 *    would E2BIG on Linux spawns fine there and a fixed guard would false-reject.
 *
 * The TOTAL argv+env budget is a SEPARATE, platform- and sandbox-dependent
 * concern: it needs the runtime `getconf ARG_MAX` (macOS is ~1 MiB, NOT 256 KiB;
 * Linux's is bounded by RLIMIT_STACK and page size), plus the sandbox wrapper's
 * own argv and the envp pointer slots — none of which a fixed constant can stand
 * in for without false-rejecting legitimate large-but-valid spawns. It is left to
 * a future platform-aware guard measured at the real spawn boundary. claude is
 * unaffected (its driver pipes the prompt through stdin, never argv).
 */
export function assertOpencodeSpawnSize(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux') return
  const value = env.OPENCODE_CONFIG_CONTENT
  if (value === undefined) return
  // The kernel measures the whole `KEY=VALUE\0` entry against MAX_ARG_STRLEN.
  const bytes =
    Buffer.byteLength('OPENCODE_CONFIG_CONTENT', 'utf8') +
    1 /* '=' */ +
    Buffer.byteLength(value, 'utf8') +
    1 /* NUL */
  if (bytes > LINUX_MAX_ARG_STRLEN) {
    throw new Error(
      `spawn-config-too-large: OPENCODE_CONFIG_CONTENT is ${bytes} bytes, over Linux's ` +
        `${LINUX_MAX_ARG_STRLEN}-byte per-argv-string execve limit (MAX_ARG_STRLEN); ` +
        `reduce the inline agent/MCP/config bodies feeding this node`,
    )
  }
}

export interface OpencodeSpawnContext extends OpencodeEnvContext {
  opencodeCmd?: string[]
  agentName: string
  prompt: string
  resumeSessionId?: string
  /** See OpencodeCommandOptions.binaryVersion (flag-spelling version gate). */
  binaryVersion?: string | null
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
      binaryVersion: ctx.binaryVersion,
    },
    ctx.prompt,
  )
  const env = buildOpencodeEnv(ctx)
  // Fail readably before Linux execve would reject an oversized inline config
  // with a raw E2BIG (see assertOpencodeSpawnSize — scoped to that one string).
  assertOpencodeSpawnSize(env)
  return { cmd, env }
}
