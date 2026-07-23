// Config load / save for the daemon.
// Source of truth is ~/.agent-workflow/config.json. Schema lives in @shared.
// Atomic writes via tempfile + rename so a crashed save can never produce a
// half-written config that fails subsequent loads.

import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  type Config,
  type ConfigPatch,
} from '@agent-workflow/shared'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('config')

/**
 * Read the config from disk WITHOUT any write side effect (RFC-216 §2/§3):
 *   - missing file      → `null` (the caller decides a default; nothing is written)
 *   - present + valid   → fully-typed Config (defaults backfilled)
 *   - present + corrupt → throws (bad JSON / schema mismatch), same message as before
 *
 * `loadConfig` is the write-on-missing wrapper around this. Read-only callers —
 * the `agent-workflow sandbox` preflight, whose whole contract is "touches no
 * files" — must use THIS, because `loadConfig` materializes defaults to disk on
 * a fresh machine (which would create ~/.agent-workflow/config.json out of a
 * pure diagnostic command).
 */
export function readConfig(path: string): Config | null {
  assertConfigPath(path)
  if (!existsSync(path)) return null

  let raw: unknown
  try {
    const text = readFileSync(path, 'utf-8')
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`config: failed to parse ${path}: ${(err as Error).message}`)
  }

  // Backfill defaults onto unknown blob, then validate. This makes config
  // forward-compatible: adding a new field with a default doesn't require
  // a migration as long as the existing $schema_version is current.
  const merged = mergeDefaults(raw)
  const parsed = ConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new Error(`config: validation failed: ${JSON.stringify(parsed.error.issues)}`)
  }
  return parsed.data
}

/**
 * Load the config from disk, backfilling missing fields with defaults.
 * Returns a fully-typed Config. Throws on invalid JSON or schema mismatch.
 * On a MISSING file this writes the defaults to disk (byte-identical to the
 * historical behavior); use `readConfig` when a write must never happen.
 */
export function loadConfig(path: string): Config {
  const existing = readConfig(path)
  if (existing !== null) return existing

  log.info('no config found, writing defaults', { path })
  saveConfigRaw(path, DEFAULT_CONFIG)
  return DEFAULT_CONFIG
}

/**
 * Apply a partial patch to the current config and write atomically.
 * Returns the new full config. Throws ValidationError on schema mismatch.
 */
export function applyConfigPatch(path: string, patch: unknown): Config {
  const next = previewConfigPatch(path, patch)
  saveConfigRaw(path, next)
  return next
}

/** Validate and merge a patch without writing it. Route-level semantic gates
 * use this to inspect the exact value that would be persisted before the
 * atomic save occurs. */
export function previewConfigPatch(path: string, patch: unknown): Config {
  const parsed = ConfigPatchSchema.safeParse(patch)
  if (!parsed.success) {
    throw new ValidationError('config-invalid', 'config patch failed validation', {
      issues: parsed.error.issues,
    })
  }
  const current = loadConfig(path)
  const next = mergePatch(current, parsed.data)
  const revalidated = ConfigSchema.safeParse(next)
  if (!revalidated.success) {
    throw new ValidationError('config-invalid', 'merged config failed validation', {
      issues: revalidated.error.issues,
    })
  }
  return revalidated.data
}

/**
 * An empty/blank path would resolve dirname() to the process cwd and can never
 * be a valid rename target — refuse it before any filesystem side effect.
 */
function assertConfigPath(path: string): void {
  if (path.trim() === '') {
    throw new Error('config: empty config path')
  }
}

/** Atomic write: tempfile + rename. Exported for tests only. */
export function saveConfigRaw(path: string, cfg: Config): void {
  assertConfigPath(path)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.config.json.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    // A failed rename must never orphan the tempfile in dirname(path).
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort — the rename error below is the failure that matters
    }
    throw err
  }
}

/**
 * Config keys whose default is a nested object, DERIVED from `DEFAULT_CONFIG`
 * rather than hard-coded.
 *
 * These are the keys that must be deep-merged, and getting that wrong is not a
 * cosmetic issue: an older `config.json` that predates a newly added inner field
 * would be passed through verbatim, fail `ConfigSchema.safeParse` on the missing
 * field, and make `loadConfig` throw — i.e. the daemon stops booting. The list
 * used to be a hand-maintained pair of `if` branches, so every future nested
 * field silently opted out of that protection until someone remembered to add it.
 */
const NESTED_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.entries(DEFAULT_CONFIG)
    .filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v))
    .map(([k]) => k),
)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Merge defaults under unknown raw input (shallow + nested for known objects). */
function mergeDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object' || raw === null) return out
  const obj = raw as Record<string, unknown>
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (NESTED_CONFIG_KEYS.has(k) && isPlainObject(v)) {
      const base = defaults[k]
      out[k] = isPlainObject(base) ? { ...base, ...v } : v
    } else {
      out[k] = v
    }
  }
  return out
}

function mergePatch(current: Config, patch: ConfigPatch): Config {
  const next: Config = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    // RFC-117: explicit null clears the field (back to "unset" → inherits the
    // global default), e.g. the settings runtime "Inherit" option. JSON.stringify
    // drops undefined, so the UI sends null to actually remove a saved override.
    if (v === null) {
      delete (next as Record<string, unknown>)[k]
      continue
    }
    // Same derived-key rule as mergeDefaults: a nested object in a PATCH is a
    // partial update of that object, not a replacement. Hard-coding the key list
    // here meant `PATCH {newNested: {onlyOneField: x}}` silently dropped the
    // sibling fields for every nested key someone forgot to add.
    if (NESTED_CONFIG_KEYS.has(k) && isPlainObject(v)) {
      const base = (current as unknown as Record<string, unknown>)[k]
      ;(next as Record<string, unknown>)[k] = isPlainObject(base) ? { ...base, ...v } : v
    } else {
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  return next
}
