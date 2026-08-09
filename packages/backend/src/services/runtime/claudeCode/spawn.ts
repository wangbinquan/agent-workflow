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
import { canonicalEnvKey, envNameMatches } from '@agent-workflow/shared'

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
  /**
   * RFC-242 §3 — WHICH execution surface is being assembled. `buildClaudeSpawn`
   * is shared by the system-agent path and the business-node path, and they
   * have different security postures: 'system' materializes its frozen profile
   * (all-deny ⇒ empty load set), 'business' keeps the RFC-111 shape until
   * RFC-242 §2 lands its permission mapping + escape valve. Omitted ⇒
   * 'business' (the historical default), so no caller silently tightens.
   */
  surface?: 'system' | 'business'
  /**
   * RFC-242 §2 — the BUSINESS tool gate derived from `agent.permission`
   * (`permissionMap.ts`). Present ⇒ the declared-control shape with exactly
   * these built-ins. Absent ⇒ the historical unconstrained shape
   * (`bypassPermissions`), which the user decision of 2026-07-31 keeps as the
   * default so existing agents do not break — the caller MUST surface an
   * `unconstrained` warning instead of tightening silently.
   */
  businessTools?: string
  /**
   * RFC-242 T5 — names of the MCP servers this business node configures.
   *
   * MEASURED against claude 2.1.220 (2026-07-31): under `--permission-mode
   * dontAsk` an MCP tool call is DENIED ("Permission to use mcp__x__y has been
   * denied because Claude Code is running in don't ask mode") unless the tool
   * matches `--allowedTools`. Built-ins keep their cwd-based auto-decision
   * either way — verified in the same run: `Read` succeeded alongside an
   * allowlisted MCP call. So a declared-control business node MUST allowlist its
   * own MCP namespaces or its servers connect and then answer nothing. The
   * historical `bypassPermissions` shape allows everything, which is why this
   * only bites the RFC-242 §2 gated shape.
   */
  mcpServerNames?: readonly string[]
  /**
   * 2026-08-04 — per-runtime extra argv tokens (registry-validated: claude-code
   * protocol only, platform-owned flags rejected). Appended LAST so the
   * platform's own flag groups stay byte-stable for the golden locks. First
   * consumer: CodeAgent's `--skip-safe-check` (its per-run trust prompt fires
   * every spawn because the platform hands it a fresh private config dir).
   */
  extraArgs?: readonly string[]
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
    // RFC-254 T2: platform-aware name comparison. On Windows the environment
    // block is case-insensitive, so an inherited `ClaudeCode` would slip past
    // a byte-exact Set lookup and re-enter the controlled child.
    if (envNameMatches(CLAUDE_INTERNAL_ENV_MARKERS, key, process.platform)) continue
    if (canonicalEnvKey(key, process.platform).startsWith('CLAUDECODE_')) continue
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

/** Headless transport base shared by every platform-spawned Claude child. */
export const CLAUDE_HEADLESS_BASE_ARGV: readonly string[] = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
])

/**
 * 2026-08-04 (runtime extraArgs) — flags the PLATFORM owns on a Claude argv:
 * everything this module can emit plus their close aliases. A runtime's
 * `extraArgs` (fork-private flags like `--skip-safe-check`) must never be able
 * to override the transport, the permission shape, the sealed prompt/MCP
 * material or session identity — the registry rejects these at write time
 * (`validateExtraArgs`), keyed off this single set so a new platform flag
 * cannot be forgotten in a second copy.
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
  '--strict-mcp-config',
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
  '--setting-sources',
  '--settings',
  '--disable-slash-commands',
])

/** RFC-237 — the intent read-only load set (hands-on verified on 2.1.220). */
export const CLAUDE_INTENT_READONLY_TOOLS = 'Read,Grep,Glob' as const

/** RFC-242 §3 — `all-deny` materialized: an EMPTY built-in load set. Proven
 *  usable by the RFC-238 MCP playground, which runs on `--tools ""` plus one
 *  MCP namespace. */
export const CLAUDE_ALL_DENY_TOOLS = '' as const

export interface ClaudeDeclaredControlArgv {
  /** `--tools` value: the LOADED built-in set. '' disables all built-ins. */
  tools: string
  /** Private MCP config file path; omitted → no --mcp-config (strict alone = zero MCP). */
  mcpConfigFile?: string
  /** `--allowedTools` pattern (e.g. one MCP namespace); omitted → flag absent. */
  allowedTools?: string
  /**
   * True when the load set grants the `Skill` tool, i.e. this node is SUPPOSED
   * to be able to use its managed skills. Controls TWO flags, because skills
   * need both a tool and a discovery source:
   *
   * 2026-08-04 audit: `--disable-slash-commands` was emitted unconditionally on
   * the strength of a comment calling it "defense-in-depth against config-dir
   * skills". The CLI's own help text says otherwise — the flag's documented
   * effect is **"Disable all skills"**. So a node that declared permissions,
   * selected managed skills, had the whole tree staged into its private config
   * dir (`prepareClaudeConfigDir`) and had `skill: 'allow'` translated into
   * `--tools …,Skill` then had every one of those skills switched off, with no
   * warning anywhere. Three parts of one spawn contradicting each other.
   *
   * 2026-08-09, the layer under it: with the tool restored the skills STILL did
   * not exist, because user-scope skill discovery is gated on the setting
   * sources. Read from the 2.1.226 binary — the loader is
   *
   *     let r = join(Hn(), "skills")            // Hn() = CLAUDE_CONFIG_DIR
   *     Tg("userSettings") && !s ? Y0r(r, "userSettings", t) : []
   *
   * with `Tg(x) = fC().includes(x)`, `fC()` reading `allowedSettingSources`, and
   * `--setting-sources ""` parsing to `[]`. So `""` means claude never even
   * readdir's `$CLAUDE_CONFIG_DIR/skills`, and the model's Skill call comes back
   * `Unknown skill: <name>`. Measured on the same build: `""` → 15 bundled
   * skills and nothing staged; `user` → the staged skill appears.
   *
   * `user` is the minimal opening: the user-settings ROOT is `Hn()`, i.e. the
   * private per-attempt config dir the platform just created, which holds only
   * what `prepareClaudeConfigDir` put there (`skills/` + the bridged
   * credential). No `settings.json` / `agents/` / `commands/` exists to be read,
   * and `project` / `local` stay closed so the repo cannot inject anything.
   * `stageSkills` strips `.claude-plugin` so a staged tree cannot come back as a
   * plugin (hooks!) through the door this opens.
   *
   * Default false keeps the historical shape for every caller that grants no
   * Skill tool (system surfaces, the read-only intent set, the MCP playground).
   */
  skillsGranted?: boolean
  /**
   * 2026-08-09 — this spawn carries a NON-EMPTY dependsOn closure (`--agents`),
   * so the platform loads `Task` regardless of what the agent's own permission
   * says. `Task` is the only way to reach a subagent, and until now it was
   * gated on the user writing `task: 'allow'` while `--agents` went out
   * unconditionally: a node that declared dependencies registered them and then
   * could not call a single one, with no diagnostic anywhere.
   *
   * opencode has derived this from the closure since RFC-251
   * (`hermetic.ts:864-868` opens `task` iff `allowedTaskTargets.length > 0`) and
   * never consults the user's permission for it. Deriving it here is what makes
   * one agent definition mean the same thing on both runtimes.
   *
   * Does this widen the blast radius? MEASURED on 2.1.226: no. A subagent's
   * tool pool is the PARENT's loaded set — the built-in `general-purpose`
   * declares `tools:["*"]` and still reported exactly `Agent, Read` under a
   * `--tools Read,Task` parent. So `Task` cannot be used to reach a capability
   * the parent does not already load; the built-ins it also exposes are
   * capped by the same ceiling.
   */
  subagentsGranted?: boolean
}

/**
 * RFC-237 (2026-07-31 unification) — the SINGLE owner of Claude's
 * declared-control flag group. Every security-relevant flag lives here so a
 * new capability cannot ship a near-copy that silently drops one (the env
 * counterpart of this drift caused the root-deployment incident;
 * `mcpTest.ts` had already grown a second copy of this group).
 *
 * Semantics (verified against claude 2.1.220, RFC-237 design §2.1-2.2):
 *  - `dontAsk` — permission backstop: outside-cwd reads auto-denied, in-cwd
 *    auto-allowed, no interactive hang in headless mode. NOT bypassPermissions
 *    (uid-0 daemons still assert IS_SANDBOX via the env assembly, see above);
 *  - `--tools` — prunes the LOADED built-in set (init echoes exactly this set;
 *    a call to anything else returns "No such tool available" and the run
 *    continues);
 *  - `--strict-mcp-config` — UNCONDITIONAL: with no `--mcp-config` it means
 *    zero MCP servers; with one it means exactly that file and nothing
 *    inherited;
 *  - `--setting-sources` — `""` cuts user/project/local settings, but `user` is
 *    REQUIRED to make the node's own skills exist at all (see `skillsGranted`);
 *  - `--disable-slash-commands` — the CLI's documented effect is "Disable all
 *    skills", so it is emitted ONLY when the load set grants no `Skill` tool.
 *    Sending it while ALSO staging the node's managed skills and granting
 *    `Skill` (which is what happened until 2026-08-04) silently deleted the
 *    node's skill capability.
 *
 * Flag ORDER is part of the contract (argv golden locks); callers append their
 * own model/prompt/session flags after this group.
 */
/**
 * 2026-08-09 — the LOADED set actually emitted: the mapped tools plus `Task`
 * when this spawn carries a dependsOn closure. Appended (never reordered) so
 * every existing golden argv stays byte-identical, and de-duped so an agent
 * that already declared `task: 'allow'` does not produce `Task,Task`.
 * An empty mapped set stays empty unless subagents are actually present.
 */
function claudeLoadedTools(input: ClaudeDeclaredControlArgv): string {
  if (input.subagentsGranted !== true) return input.tools
  const loaded = input.tools.split(',').filter((tool) => tool.length > 0)
  if (loaded.includes('Task')) return input.tools
  loaded.push('Task')
  return loaded.join(',')
}

export function claudeDeclaredControlArgv(input: ClaudeDeclaredControlArgv): string[] {
  return [
    '--permission-mode',
    'dontAsk',
    '--tools',
    claudeLoadedTools(input),
    ...(input.mcpConfigFile === undefined ? [] : ['--mcp-config', input.mcpConfigFile]),
    '--strict-mcp-config',
    '--setting-sources',
    // `user` = the private per-attempt config dir ONLY (see `skillsGranted`);
    // without it claude never scans `$CLAUDE_CONFIG_DIR/skills`.
    input.skillsGranted === true ? 'user' : '',
    ...(input.skillsGranted === true ? [] : ['--disable-slash-commands']),
    ...(input.allowedTools === undefined ? [] : ['--allowedTools', input.allowedTools]),
  ]
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
  // RFC-242 §3 — a SYSTEM-agent spawn materializes its frozen profile for real:
  // 'all-deny' (and the omitted profile every system caller still sends) means
  // an EMPTY built-in load set on claude too. System agents are pure inference
  // + stdout (distiller distils, smoke round-trips a prompt into an envelope) —
  // none of them ever called a tool, so the old bypass shape was exposure with
  // no capability behind it.
  //
  // BUSINESS nodes keep the RFC-111 shape here on purpose: their tools ARE the
  // product, and narrowing them needs the permission mapping + escape valve of
  // RFC-242 §2 (user decision 2026-07-31: existing agents must not break).
  // The surface is EXPLICIT — inferring it from optional business fields would
  // silently tighten a business spawn that happens to omit them.
  const systemSurface = ctx.surface === 'system'
  // RFC-242 §2: a business spawn is declared-control IFF its agent's
  // permission produced a gate; otherwise it stays unconstrained (existing
  // agents keep working) and the caller warns.
  const businessGated = !systemSurface && !readOnlyIntent && ctx.businessTools !== undefined
  /** Any shape running under the declared-control contract (argv AND env). */
  const declaredControl = systemSurface || readOnlyIntent || businessGated
  // RFC-242 T5: exactly the node's own MCP namespaces, never a broad `mcp__*` —
  // `--strict-mcp-config` already fixes the server set, and naming them keeps
  // the allowlist as narrow as the config it mirrors.
  const mcpAllowedTools = (ctx.mcpServerNames ?? []).map((name) => `mcp__${name}__*`).join(',')
  const cmd = [
    ...head,
    ...CLAUDE_HEADLESS_BASE_ARGV,
    ...(systemSurface || readOnlyIntent || businessGated
      ? claudeDeclaredControlArgv({
          tools: readOnlyIntent
            ? CLAUDE_INTENT_READONLY_TOOLS
            : businessGated
              ? (ctx.businessTools as string)
              : CLAUDE_ALL_DENY_TOOLS,
          ...(businessGated && mcpAllowedTools.length > 0 ? { allowedTools: mcpAllowedTools } : {}),
          // Only the business gate can grant Skill; the read-only intent set
          // and the all-deny system surface never do.
          ...(businessGated && /(^|,)Skill(,|$)/.test(ctx.businessTools ?? '')
            ? { skillsGranted: true }
            : {}),
          // 2026-08-09: the closure itself grants Task — same derivation
          // opencode uses, and `--agents` is exactly "the closure is non-empty".
          ...(businessGated && ctx.agentsJson !== undefined && ctx.agentsJson.length > 0
            ? { subagentsGranted: true }
            : {}),
        })
      : [
          // multica-proven non-interactive form; RFC-242 §2 replaces this with
          // a mapping-driven tool gate + explicit unconstrained escape valve.
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
  // 2026-08-04 — runtime extraArgs, appended LAST: the platform flag groups
  // above stay byte-stable (golden locks) and the registry has already
  // rejected platform-owned flags, so nothing here can override them.
  if (ctx.extraArgs !== undefined && ctx.extraArgs.length > 0) {
    cmd.push(...ctx.extraArgs)
  }

  // RFC-242 T2: every DECLARED-CONTROL shape (system agents, intent, and a
  // permission-gated business node) gets the controlled env + hardening. An
  // unconstrained business node keeps the full inherit — tightening it without
  // its tool gate would disturb exactly the agents the user chose to leave
  // alone (decision 2026-07-31).
  const env = assembleClaudeEnv({
    inherit: declaredControl ? 'controlled' : 'full',
    hardening: declaredControl,
    worktreePath: ctx.worktreePath,
    configDirEnv: ctx.configDirEnv ?? DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env,
    configDir,
    gitUserName: ctx.gitUserName ?? null,
    gitUserEmail: ctx.gitUserEmail ?? null,
  })

  return { cmd, env, stdin: { mode: 'pipe', data: ctx.prompt } }
}

export interface ClaudeEnvAssembly {
  /** 'full' = legacy byte-compatible full inherit; 'controlled' = inherit minus
   *  the internal-marker blacklist (declared-control branches). */
  inherit: 'full' | 'controlled'
  /** Inject the no-telemetry/no-autoupdate hardening set (declared-control). */
  hardening: boolean
  worktreePath: string
  /** RFC-154 config-dir key + resolved private dir. */
  configDirEnv: string
  configDir: string
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
}

/**
 * RFC-237 (2026-07-31 unification) — the SINGLE env assembly point for every
 * Claude Code child the platform spawns. Survival-critical keys must never be
 * re-implemented per call site (the root-deployment incident: the read-only
 * branch re-built its tail and dropped the uid-0 IS_SANDBOX assert; the MCP
 * playground then copied a third variant). Branches express ONLY their inherit
 * policy and hardening choice; everything below is invariant:
 *
 *  - PWD=worktree (claude derives the transcript project slug from cwd);
 *  - RFC-154 config-dir relocation + default-key scrub for custom forks
 *    (Codex impl-gate P2: a child carrying BOTH keys lands a fork in a stale
 *    dir);
 *  - uid-0 daemons ALWAYS assert IS_SANDBOX=1, spread last so it wins over any
 *    inherited value ('full') or survives the blacklist strip ('controlled'):
 *    claude's root gate wants the exact string '1' (bypass branches), a root
 *    daemon is a container-shaped deployment where the assertion is honest,
 *    and it forward-proofs against claude releases widening the gate beyond
 *    the bypass-only checks binary-verified on 2.1.220. Non-root spawns get
 *    nothing;
 *  - RFC-067 git identity (both fields non-empty to inject).
 *
 * `uid` is dependency-injected so root behavior is testable on non-root CI.
 */
export function assembleClaudeEnv(
  assembly: ClaudeEnvAssembly,
  uid: number | undefined = process.getuid?.(),
): Record<string, string> {
  const env: Record<string, string> = {
    ...(assembly.inherit === 'controlled'
      ? claudeControlledInheritEnv(process.env)
      : (process.env as Record<string, string>)),
    PWD: assembly.worktreePath,
    [assembly.configDirEnv]: assembly.configDir,
    ...(assembly.hardening ? CLAUDE_READONLY_HARDENING_ENV : {}),
    ...claudeSandboxEnv(uid),
  }
  if (assembly.configDirEnv !== DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env) {
    delete env[DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env]
  }
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
