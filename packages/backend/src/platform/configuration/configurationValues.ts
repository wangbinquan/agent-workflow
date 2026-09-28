// RFC-370: shared configuration value rules, with no storage or host effects.
// File and hosted adapters must use the same defaults, patch and validation rules.
import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  type Config,
  type ConfigPatch,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

/** Decode an already parsed stored value. JSON/transport failures belong to the adapter. */
export function resolveConfigurationValue(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(mergeDefaults(raw))
  if (!parsed.success) {
    throw new Error(`config: validation failed: ${JSON.stringify(parsed.error.issues)}`)
  }
  return parsed.data
}

/** Validate before loading storage: an invalid patch must not materialize defaults. */
export function validateConfigurationPatch(patch: unknown): ConfigPatch {
  const parsed = ConfigPatchSchema.safeParse(patch)
  if (!parsed.success) {
    throw new ValidationError('config-invalid', 'config patch failed validation', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

/** Merge a validated patch without changing the input snapshot or writing storage. */
export function mergeValidatedConfigurationPatch(current: Config, patch: ConfigPatch): Config {
  const next = mergePatch(current, patch)
  const revalidated = ConfigSchema.safeParse(next)
  if (!revalidated.success) {
    throw new ValidationError('config-invalid', 'merged config failed validation', {
      issues: revalidated.error.issues,
    })
  }
  return revalidated.data
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Discriminated config objects deep-merge only while their discriminator is
 * unchanged. Merging a PostgreSQL payload over the SQLite variant (or vice
 * versa) would retain forbidden keys and make a valid provider switch fail. */
function mergeNestedConfigValue(
  key: string,
  base: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(base)) return patch
  if (
    key === 'database' &&
    typeof patch.provider === 'string' &&
    typeof base.provider === 'string' &&
    patch.provider !== base.provider
  ) {
    return patch
  }
  return { ...base, ...patch }
}

/** Merge defaults under unknown raw input (shallow + nested for known objects). */
export function mergeDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object' || raw === null) return out
  const obj = raw as Record<string, unknown>
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (NESTED_CONFIG_KEYS.has(k) && isPlainObject(v)) {
      const base = defaults[k]
      out[k] = mergeNestedConfigValue(k, base, v)
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
      ;(next as Record<string, unknown>)[k] = mergeNestedConfigValue(k, base, v)
    } else {
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  return next
}
