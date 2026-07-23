// RFC-154 — per-runtime config-dir injection profile.
//
// The framework stages skills into a per-run config directory and tells the
// spawned CLI where it is via an env var (opencode: OPENCODE_CONFIG_DIR →
// <runRoot>/.opencode; claude: CLAUDE_CONFIG_DIR → <runRoot>/.claude). A custom
// fork binary may have renamed the env var and/or its default leaf directory,
// so both are per-runtime configurable (runtimes.config_dir_env /
// config_dir_name, NULL = the protocol default below). This module is the
// SINGLE SOURCE for the protocol defaults — spawn/driver code must import from
// here, never re-hardcode the literals (source-guard locked).
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
  'IS_SANDBOX', // claude root guard
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
  if (RESERVED_SPAWN_ENV.has(trimmed)) return 'reserved'
  return null
}
