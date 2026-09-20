import {
  RUNTIME_NUMERIC_BOUNDS,
  configDirEnvProblem,
  configDirNameProblem,
  DEFAULT_CONFIG_DIR_PROFILE,
  type RuntimeConfigDirProfile,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import type {
  RuntimeKind,
  RuntimeProtocol,
  RuntimeProfile,
  RuntimeView,
  RuntimeProfileInput,
} from '../public/types'

/** RFC-112 Codex P3: runtime names are lowercase, URL-safe (used in /:name routes). */
export const RUNTIME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

export interface RuntimeRow extends RuntimeProfile {
  id: string
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  /** RFC-118: false = disabled (hidden from agent/default pickers, kept in list). */
  enabled: boolean
  /** Persisted, deterministic form of RuntimeProfile.isSandbox. */
  isSandbox: boolean
  /** RFC-154: config-dir injection overrides — NULL = protocol default. */
  configDirEnv: string | null
  configDirName: string | null
  /** 2026-08-04 — raw JSON column behind RuntimeProfile.extraArgs (NULL = none). */
  extraArgsJson: string | null
  lastProbeJson: string | null
  /** Persisted execution-target generation for long-running probe CAS. */
  probeFence: number
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

/** Parse the raw extra_args_json column: string[] or null (invalid → null). */
export function parseRuntimeExtraArgs(json: string | null | undefined): string[] | null {
  if (json == null || json.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((t): t is string => typeof t === 'string')
    ) {
      return parsed
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * RFC-154: the protocol's default config-dir profile. Indexing the shared map by
 * RuntimeKind is the completeness guard — registering a new driver kind without
 * a default entry in DEFAULT_CONFIG_DIR_PROFILE fails typecheck here.
 */
export function defaultConfigDirProfile(kind: RuntimeKind): RuntimeConfigDirProfile {
  return DEFAULT_CONFIG_DIR_PROFILE[kind]
}

/** Fold a row's nullable overrides over the protocol default (empty = unset). */
export function resolveConfigDirProfile(
  protocol: RuntimeKind,
  configDirEnv: string | null,
  configDirName: string | null,
): RuntimeConfigDirProfile {
  const dft = defaultConfigDirProfile(protocol)
  const nonEmpty = (v: string | null): string | null =>
    v !== null && v.trim().length > 0 ? v.trim() : null
  return {
    env: nonEmpty(configDirEnv) ?? dft.env,
    name: nonEmpty(configDirName) ?? dft.name,
  }
}

/** Extract just the execution params from a row. */
export function runtimeProfileOf(
  row: RuntimeProfile & { extraArgsJson?: string | null },
): RuntimeProfile {
  return {
    model: row.model,
    variant: row.variant,
    temperature: row.temperature,
    steps: row.steps,
    maxSteps: row.maxSteps,
    isSandbox: row.isSandbox === true,
    // A DB row carries the raw column; an already-materialized profile (frozen
    // params) carries the array. Either way the output always has the key, so
    // probe fingerprints and views stay shape-stable.
    extraArgs: row.extraArgs ?? parseRuntimeExtraArgs(row.extraArgsJson ?? null),
  }
}

/** Freeze the exact row identity/profile a long-running probe is about to use. */
export function runtimeProbeTargetOf(
  row: RuntimeRow,
  resolvedBinaryPath: string,
): RuntimeProbeTarget {
  return Object.freeze({
    id: row.id,
    name: row.name,
    probeFence: row.probeFence,
    resolvedBinaryPath,
    fingerprint: Object.freeze({
      protocol: row.protocol,
      binaryPath: row.binaryPath,
      configDirEnv: row.configDirEnv,
      configDirName: row.configDirName,
      ...runtimeProfileOf(row),
    }),
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function receiptMatchesTarget(receipt: unknown, target: RuntimeProbeTarget): unknown | null {
  if (!isRecord(receipt) || receipt.codec !== 1 || !isRecord(receipt.target)) return null
  const stored = receipt.target
  if (!isRecord(stored.fingerprint) || !Object.hasOwn(receipt, 'smoke')) return null
  const f = target.fingerprint
  const storedFingerprint = stored.fingerprint
  if (
    stored.id !== target.id ||
    stored.name !== target.name ||
    stored.probeFence !== target.probeFence ||
    stored.resolvedBinaryPath !== target.resolvedBinaryPath ||
    storedFingerprint.protocol !== f.protocol ||
    storedFingerprint.binaryPath !== f.binaryPath ||
    storedFingerprint.model !== f.model ||
    storedFingerprint.variant !== f.variant ||
    storedFingerprint.temperature !== f.temperature ||
    storedFingerprint.steps !== f.steps ||
    storedFingerprint.maxSteps !== f.maxSteps ||
    storedFingerprint.isSandbox !== f.isSandbox ||
    storedFingerprint.configDirEnv !== f.configDirEnv ||
    storedFingerprint.configDirName !== f.configDirName
  ) {
    return null
  }
  return receipt.smoke
}

/**
 * Public view of a row for the HTTP layer. A receipt is shown only when its
 * self-contained row/profile/fence/effective-binary target matches live state;
 * legacy/malformed JSON and externally drifted config fail closed to null.
 * `defaultRuntimeName` drives the in-table default marker (RFC-113 D3/D7).
 */
export function runtimeRowToView(
  row: RuntimeRow,
  defaultRuntimeName: string | null | undefined,
  resolvedBinaryPath: string,
): RuntimeView {
  let lastProbe: unknown = null
  if (row.lastProbeJson !== null) {
    try {
      const receipt: unknown = JSON.parse(row.lastProbeJson)
      lastProbe = receiptMatchesTarget(receipt, runtimeProbeTargetOf(row, resolvedBinaryPath))
    } catch {
      lastProbe = null
    }
  }
  return {
    name: row.name,
    protocol: row.protocol,
    binaryPath: row.binaryPath,
    enabled: row.enabled,
    isDefault: row.name === (defaultRuntimeName ?? 'opencode'),
    configDirEnv: row.configDirEnv,
    configDirName: row.configDirName,
    ...runtimeProfileOf(row),
    lastProbe,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// RFC-143: `runtimeHead` (RFC-112 PR-A) was a second copy of the per-protocol
// config-key binary pick with ZERO production callers (dispatch uses runner's
// pickRuntimeHead; the routes use resolveRuntimeBinary → driver.defaultBinary).
// Deleted — driver.defaultBinary is the single source.

// --- guards ----------------------------------------------------------------

export function validateName(name: string): void {
  if (!RUNTIME_NAME_RE.test(name))
    throw new ValidationError(
      'runtime-name-invalid',
      'runtime name must be lowercase URL-safe (^[a-z0-9][a-z0-9-]{0,30}$)',
    )
  // RFC-153: opencode / claude-code are no longer reserved — they are ordinary
  // rows now, so a deleted preseeded name may be recreated (name uniqueness in
  // createRuntime still blocks a duplicate while a preseeded row exists).
}

/**
 * RFC-154: `config_dir_name` is joined under the per-run root and mkdir'd, so it
 * must be a SINGLE leaf directory name — no separators / traversal ('..' escapes
 * the run root; '.' collapses onto it, mixing skills/ + transcript + credentials
 * into the run-root top level — Codex design-gate P3). Empty/blank = unset (NULL
 * → protocol default). Exported for direct unit coverage.
 */
export function validateConfigDirName(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = v.trim()
  if (s.length === 0) return null
  // Rule lives in the shared predicate (Codex impl-gate P3: the frontend form
  // consumes the same one, so the two layers can't drift).
  if (configDirNameProblem(s) !== null)
    throw new ValidationError(
      'runtime-config-dir-name-invalid',
      'config_dir_name must be a single directory name (no separators, "." or "..")',
    )
  return s
}

/**
 * RFC-154: `config_dir_env` becomes an env KEY on every business spawn — it must
 * be a legal env var name and must not collide with the keys the platform itself
 * writes (RESERVED_SPAWN_ENV — colliding with e.g. OPENCODE_CONFIG_CONTENT would
 * make the config-dir channel clobber the agent-definition channel, Codex
 * design-gate P1). Empty/blank = unset. Exported for direct unit coverage.
 */
export function validateConfigDirEnv(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = v.trim()
  if (s.length === 0) return null
  // Rule lives in the shared predicate (Codex impl-gate P3, same as above).
  const problem = configDirEnvProblem(s)
  if (problem === 'invalid-name')
    throw new ValidationError(
      'runtime-config-dir-env-invalid',
      'config_dir_env must be a legal environment variable name ([A-Za-z_][A-Za-z0-9_]*)',
    )
  if (problem === 'reserved')
    throw new ValidationError(
      'runtime-config-dir-env-reserved',
      `config_dir_env must not be the platform-reserved variable '${s}'`,
    )
  return s
}

/** Validate + normalize profile params into the row columns (only present keys).
 *  extraArgs / isSandbox are deliberately NOT handled here — their validation needs the
 *  protocol, so create/update call validateExtraArgs themselves. */
export function profilePatch(
  input: RuntimeProfileInput,
): Partial<Omit<RuntimeProfile, 'extraArgs' | 'isSandbox'>> {
  const out: Partial<Omit<RuntimeProfile, 'extraArgs' | 'isSandbox'>> = {}
  const str = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  if (input.model !== undefined) out.model = str(input.model)
  if (input.variant !== undefined) out.variant = str(input.variant)
  if (input.temperature !== undefined) {
    const bound = RUNTIME_NUMERIC_BOUNDS.temperature
    if (
      input.temperature !== null &&
      (!Number.isFinite(input.temperature) ||
        input.temperature < bound.min ||
        input.temperature > bound.max)
    )
      throw new ValidationError(
        'runtime-temperature-invalid',
        `temperature must be ${bound.min}–${bound.max}`,
      )
    out.temperature = input.temperature
  }
  for (const k of ['steps', 'maxSteps'] as const) {
    const v = input[k]
    const bound = RUNTIME_NUMERIC_BOUNDS[k]
    if (v !== undefined) {
      if (v !== null && (!Number.isSafeInteger(v) || v < bound.min || v > bound.max))
        throw new ValidationError(
          `runtime-${k}-invalid`,
          `${k} must be an integer from ${bound.min} to ${bound.max}`,
        )
      out[k] = v
    }
  }
  return out
}

/**
 * Exact registry columns whose values define the runtime execution profile and
 * therefore the meaning of a deep-smoke receipt. Keep this in lockstep with
 * `updateRuntime`'s `executionProfileChanged` invalidation set.
 */
export interface RuntimeExecutionProfileFingerprint {
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
  readonly extraArgs?: readonly string[] | null
  readonly protocol: RuntimeProtocol
  readonly binaryPath: string | null
  readonly configDirEnv: string | null
  readonly configDirName: string | null
  readonly isSandbox: boolean
}

export interface RuntimeProbeTarget {
  /** Immutable row identity; protects delete + same-name recreation. */
  readonly id: string
  readonly name: string
  /** Persisted generation; protects profile + inherited config-binary changes. */
  readonly probeFence: number
  /** Exact effective executable selected after row + daemon-config resolution. */
  readonly resolvedBinaryPath: string
  readonly fingerprint: RuntimeExecutionProfileFingerprint
}

export interface ResolvedRuntime extends RuntimeProfile {
  name: string
  protocol: RuntimeKind
  binaryPath: string | null
  isSandbox: boolean
  /** RFC-154: resolved config-dir profile (row overrides folded over the protocol default). */
  configDir: RuntimeConfigDirProfile
}

/**
 * Config fields that hold a runtime NAME (all checked before delete). RFC-153
 * impl-gate: besides `agents.runtime`, the config references runtimes in
 * `defaultRuntime` AND the three per-feature internal-agent fields (memoryDistill /
 * commitPush / mergeAgent, resolved via `resolveInternalAgentRuntime`). A deleted
 * row any of these point at would silently downgrade that job to the protocol-name
 * fallback (NULL profile). `deleteRuntime` checks all four INSIDE its transaction
 * (2nd-pass impl-gate: reference/count/delete must be atomic, so there is no
 * separate async reference pass).
 */
export interface RuntimeRefConfig {
  defaultRuntime?: string | null
  memoryDistillRuntime?: string | null
  commitPushRuntime?: string | null
  mergeAgentRuntime?: string | null
  /** RFC-234 — intent-builder system agent selection. */
  intentBuilderRuntime?: string | null
  /** RFC-239 — change-narrative (AI 导读) system agent selection. */
  changeNarrativeRuntime?: string | null
}
