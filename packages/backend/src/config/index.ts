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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('config')

/**
 * Load the config from disk, backfilling missing fields with defaults.
 * Returns a fully-typed Config. Throws on invalid JSON or schema mismatch.
 */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    log.info('no config found, writing defaults', { path })
    saveConfigRaw(path, DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }

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
 * Apply a partial patch to the current config and write atomically.
 * Returns the new full config. Throws ValidationError on schema mismatch.
 */
export function applyConfigPatch(path: string, patch: unknown): Config {
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
  saveConfigRaw(path, revalidated.data)
  return revalidated.data
}

/** Atomic write: tempfile + rename. */
function saveConfigRaw(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.config.json.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

/** Merge defaults under unknown raw input (shallow + nested for known objects). */
function mergeDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object' || raw === null) return out
  const obj = raw as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    // Deep-merge for the two nested objects in the schema.
    if (k === 'worktreeAutoGc' && typeof v === 'object' && v !== null) {
      out[k] = { ...DEFAULT_CONFIG.worktreeAutoGc, ...(v as Record<string, unknown>) }
    } else if (k === 'eventsArchiveThresholds' && typeof v === 'object' && v !== null) {
      out[k] = {
        ...DEFAULT_CONFIG.eventsArchiveThresholds,
        ...(v as Record<string, unknown>),
      }
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
    if (k === 'worktreeAutoGc' && typeof v === 'object' && v !== null) {
      next.worktreeAutoGc = {
        ...current.worktreeAutoGc,
        ...(v as Record<string, unknown>),
      } as Config['worktreeAutoGc']
    } else if (k === 'eventsArchiveThresholds' && typeof v === 'object' && v !== null) {
      next.eventsArchiveThresholds = {
        ...current.eventsArchiveThresholds,
        ...(v as Record<string, unknown>),
      } as Config['eventsArchiveThresholds']
    } else {
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  return next
}
