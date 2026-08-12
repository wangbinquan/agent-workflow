// RFC-154 — per-runtime config-dir injection profile.
//
// A custom fork binary may have renamed the env var it reads its config dir
// from and/or that directory's leaf name, so both are per-runtime configurable
// (runtimes.config_dir_env / config_dir_name, NULL = the protocol default
// below). This module is the SINGLE SOURCE for the protocol defaults —
// spawn/driver code must import from here, never re-hardcode the literals
// (source-guard locked).
//
// What each half means depends on the driver:
//   * opencode — the framework stages skills into a per-run config dir and
//     points the CLI at it: `<env> = <runRoot>/<name>`.
//   * claude — since RFC-276 the platform sets NO config-dir env (the operator's
//     natural config/auth root is preserved). `name` selects the PROJECT config
//     leaf projected into the worktree (`<worktree>/<name>/skills|agents`), and
//     both halves also locate the operator's real root when reading transcripts
//     back (claudeCode/sessionCapture.ts claudeUserConfigRoots).
//
// Dependency-free leaf module (same discipline as listWire): safe for both the
// backend registry/drivers and the frontend form placeholders.

export interface RuntimeConfigDirProfile {
  /** Env var NAME the spawned binary reads its config dir path from. */
  env: string
  /** Leaf directory name created under the per-run root. */
  name: string
}

/**
 * Protocol defaults. Keys are RuntimeKind values; the backend's
 * `defaultConfigDirProfile(kind)` indexes this by RuntimeKind, so adding a new
 * driver kind without a default here fails typecheck (completeness guard).
 */
export const DEFAULT_CONFIG_DIR_PROFILE = {
  opencode: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
  'claude-code': { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
} as const satisfies Record<string, RuntimeConfigDirProfile>

/**
 * Env keys the platform itself writes into every spawn (see
 * opencode/spawn.ts buildOpencodeEnv + claudeCode/spawn.ts buildClaudeSpawn).
 * `config_dir_env` colliding with any of these would make the config-dir
 * channel and that mechanism overwrite each other — one of them silently loses
 * (Codex design-gate P1). Rejected at save time.
 *
 * The OTHER protocol's default config-dir env is deliberately NOT reserved:
 * re-stating your own protocol's default is a harmless no-op, and a
 * cross-protocol name can't collide inside one spawn (one runtime per run).
 */
export const RESERVED_SPAWN_ENV: ReadonlySet<string> = new Set([
  'PWD',
  'OPENCODE_CONFIG_CONTENT', // agent-definition channel (RFC-154 non-goal)
  'OPENCODE_PERMISSION', // post-inline permission override; scrubbed from managed children (RFC-223)
  'OPENCODE_AW_INVENTORY_OUT', // inventory plugin ↔ runner contract (RFC-029)
  'IS_SANDBOX', // runtime-profile controlled Claude CLI compatibility marker
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
])

/**
 * Pure validation predicates — the ONE copy both the backend service validators
 * (runtimeRegistry throws ValidationError from these) and the frontend form
 * (inline error + disabled Save) consume, so the two layers can't drift.
 * Callers pass a TRIMMED, NON-EMPTY value (empty = unset, valid by definition).
 */
export function configDirNameProblem(trimmed: string): 'invalid-leaf' | null {
  // Must be a single leaf: no separators, no traversal ('..' escapes the run
  // root; '.' collapses onto it), no NUL.
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0')
  ) {
    return 'invalid-leaf'
  }
  return null
}

export function configDirEnvProblem(trimmed: string): 'invalid-name' | 'reserved' | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return 'invalid-name'
  // RFC-254 T2: the collision check is case-INSENSITIVE on every platform, not
  // just Windows. This is CONFIG VALIDATION, and config is data that travels —
  // a name accepted on Linux and later run on a Windows daemon (where the
  // environment block folds case) would become a silent collision with the
  // reserved variable it shadows. Rejecting `Pwd` everywhere costs nothing;
  // every reserved name is conventionally all-caps anyway.
  const folded = trimmed.toUpperCase()
  for (const reserved of RESERVED_SPAWN_ENV) {
    if (reserved.toUpperCase() === folded) return 'reserved'
  }
  return null
}
