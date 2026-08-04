/**
 * RFC-255 — administrator-configured custom OpenAI-compatible providers.
 *
 * RFC-224 sealed the verified execution path off from every machine-level
 * opencode config surface, which silently removed the ONLY channel a custom
 * baseURL gateway (one-api / new-api / vLLM …) had: `provider.{id}.options`
 * in `~/.config/opencode/opencode.json`. This module owns the closed shape the
 * platform accepts instead, plus the pure validators shared by the HTTP route,
 * the CLI and the runtime planners.
 *
 * Three shapes exist deliberately (design gate P1-2):
 *   - WIRE     — what GET returns and PUT accepts. `apiKey` is optional and the
 *                mask string is a legal value (it means "keep what is stored").
 *   - STORED   — what lands on disk. `apiKey` is a secretBox-sealed string.
 *   - RUNTIME  — what reaches OpenCode. Built in the backend; carries neither
 *                the key nor the display name (see design §3).
 * Collapsing them is what makes read-modify-write silently destroy credentials,
 * so the wire schema must never reject the mask.
 */

/** Fixed placeholder returned in place of a stored key on every outbound path. */
export const CUSTOM_PROVIDER_API_KEY_MASK = '••••••••'

/** v1 admits exactly one provider implementation (RFC-255 D1/D8). */
export const CUSTOM_PROVIDER_NPM = '@ai-sdk/openai-compatible' as const

/** Same shape OpenCode itself requires of a provider id (hermetic.ts). */
export const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Built-in catalog ids a custom entry may NOT claim (design gate P0-1, layer 1).
 *
 * A config-source provider whose id equals a catalog id does not create a new
 * provider — OpenCode merges it INTO the catalog entry, so the catalog's whole
 * model list inherits the custom `api` url (provider.ts:1428,1450, measured:
 * 18 anthropic models re-pointed at the gateway). That must be impossible by
 * construction, not caught later.
 *
 * The sealed enumeration cannot supply this set: with no credentials forwarded
 * it only reports the free `opencode/*` tier, so catalog ids look "free" to it.
 * Hence this explicit snapshot plus the canary probe (layer 2, backend side).
 */
export const RESERVED_PROVIDER_IDS: readonly string[] = Object.freeze([
  // Credential-env table (backend PROVIDER_API_KEY_ENV) — kept in sync by test.
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'xai',
  'mistral',
  'groq',
  'deepinfra',
  'cerebras',
  'cohere',
  'gateway',
  'togetherai',
  'perplexity',
  'vercel',
  'alibaba',
  'azure',
  // Catalog ids reachable without that table.
  'amazon-bedrock',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'dynamic',
  'github-copilot',
  'gitlab',
  'google-vertex',
  'kilo',
  'llmgateway',
  'nvidia',
  'openai-compatible',
  'opencode',
  'sap-ai-core',
  'snowflake-cortex',
  'venice',
  'zenmux',
])

const RESERVED_PROVIDER_ID_SET: ReadonlySet<string> = new Set(RESERVED_PROVIDER_IDS)

export interface CustomProviderModel {
  id: string
  name?: string
}

/** Wire shape — GET output and PUT input. See the module header. */
export interface CustomProviderEntryWire {
  id: string
  name?: string
  npm: typeof CUSTOM_PROVIDER_NPM
  baseURL: string
  /** Absent or equal to the mask ⇒ keep the stored value. */
  apiKey?: string
  models: CustomProviderModel[]
  enabled: boolean
}

export interface CustomProviderIssue {
  /** Stable validation code; the route maps it to a localized message. */
  code: string
  /** Index into the submitted array, when the issue belongs to one entry. */
  index?: number
  field?: string
  /** Non-secret detail (an id, a duplicate name) for the message template. */
  detail?: string
}

function hasControlChars(value: string): boolean {
  return value.includes('\0')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Absolute http(s) URL, no `${` template marker.
 *
 * The marker matters: OpenCode expands `${VAR}` inside the effective baseURL
 * against the server's environment (provider.ts:1698-1710), so a URL carrying
 * one would let an operator probe the sealed env through the request path.
 */
export function isValidCustomProviderBaseURL(value: string): boolean {
  if (value.length === 0 || hasControlChars(value) || value.includes('${')) return false
  if (value.trim() !== value) return false
  // Matched here rather than with `new URL` because this module is shared with
  // build targets that do not carry the DOM lib; the scheme + non-empty
  // authority check is what the admission comparison actually depends on.
  const match = /^(https?):\/\/([^/?#\s]+)(?:[/?#][^\s]*)?$/.exec(value)
  if (match === null) return false
  const authority = match[2] ?? ''
  return authority.length > 0 && !authority.includes('@') && !authority.includes('..')
}

export function isReservedProviderId(id: string): boolean {
  return RESERVED_PROVIDER_ID_SET.has(id)
}

/**
 * Validate one entry's intrinsic shape. Cross-entry rules (id uniqueness) and
 * key-presence rules (which depend on what is already stored) are separate:
 * see `validateCustomProviders`.
 */
export function validateCustomProviderEntry(entry: unknown, index?: number): CustomProviderIssue[] {
  const issues: CustomProviderIssue[] = []
  const at = (code: string, field?: string, detail?: string): void => {
    issues.push({
      code,
      ...(index === undefined ? {} : { index }),
      ...(field ? { field } : {}),
      ...(detail ? { detail } : {}),
    })
  }
  if (!isPlainRecord(entry)) {
    at('config-custom-provider-malformed')
    return issues
  }
  const { id, name, npm, baseURL, apiKey, models, enabled } = entry as Record<string, unknown>

  if (typeof id !== 'string' || !CUSTOM_PROVIDER_ID_RE.test(id)) {
    at('config-custom-provider-id-invalid', 'id', typeof id === 'string' ? id : undefined)
  } else if (isReservedProviderId(id)) {
    at('config-custom-provider-id-reserved', 'id', id)
  }
  if (name !== undefined && (typeof name !== 'string' || hasControlChars(name))) {
    at('config-custom-provider-name-invalid', 'name')
  }
  if (npm !== CUSTOM_PROVIDER_NPM) {
    at('config-custom-provider-npm-unsupported', 'npm')
  }
  if (typeof baseURL !== 'string' || !isValidCustomProviderBaseURL(baseURL)) {
    at('config-custom-provider-baseurl-invalid', 'baseURL')
  }
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || hasControlChars(apiKey)) {
      at('config-custom-provider-apikey-invalid', 'apiKey')
    }
  }
  if (!Array.isArray(models) || models.length === 0) {
    at('config-custom-provider-models-empty', 'models')
  } else {
    const seen = new Set<string>()
    for (const model of models) {
      if (
        !isPlainRecord(model) ||
        typeof model.id !== 'string' ||
        model.id.length === 0 ||
        hasControlChars(model.id)
      ) {
        at('config-custom-provider-model-invalid', 'models')
        continue
      }
      if (
        model.name !== undefined &&
        (typeof model.name !== 'string' || hasControlChars(model.name))
      ) {
        at('config-custom-provider-model-invalid', 'models')
        continue
      }
      if (seen.has(model.id)) {
        at('config-custom-provider-model-duplicate', 'models', model.id)
        continue
      }
      seen.add(model.id)
    }
  }
  if (typeof enabled !== 'boolean') {
    at('config-custom-provider-enabled-invalid', 'enabled')
  }
  return issues
}

/**
 * Validate a submitted array.
 *
 * `knownIds` is the set of ids already stored — an entry whose id is NOT in it
 * is new (or was renamed, which is the same thing) and therefore must carry a
 * real key: there is nothing to preserve for it. Passing the mask as that key
 * is rejected rather than stored, so a read-modify-write of a fresh entry
 * cannot persist the placeholder as if it were a credential.
 *
 * Uniqueness is by id only. Two entries may share a baseURL, and a trailing
 * slash makes a distinct URL — the platform deliberately does not normalize,
 * because admission compares the reported url byte-for-byte (design D13).
 */
export function validateCustomProviders(
  entries: unknown,
  knownIds: ReadonlySet<string> = new Set(),
): CustomProviderIssue[] {
  if (entries === undefined) return []
  if (!Array.isArray(entries)) return [{ code: 'config-custom-provider-malformed' }]
  const issues: CustomProviderIssue[] = []
  const seenIds = new Set<string>()
  entries.forEach((entry, index) => {
    issues.push(...validateCustomProviderEntry(entry, index))
    if (!isPlainRecord(entry)) return
    const id = entry.id
    if (typeof id !== 'string') return
    if (seenIds.has(id)) {
      issues.push({ code: 'config-custom-provider-id-duplicate', index, field: 'id', detail: id })
    }
    seenIds.add(id)
    const isNew = !knownIds.has(id)
    const apiKey = entry.apiKey
    if (isNew && (apiKey === undefined || apiKey === CUSTOM_PROVIDER_API_KEY_MASK)) {
      issues.push({
        code: 'config-custom-provider-apikey-required',
        index,
        field: 'apiKey',
        detail: id,
      })
    }
  })
  return issues
}

/** True when the submitted value means "keep whatever is already stored". */
export function isPreservedApiKey(value: string | undefined): boolean {
  return value === undefined || value === CUSTOM_PROVIDER_API_KEY_MASK
}

/**
 * Ids whose catalog-collision probe must run: entries that are new or whose
 * baseURL/id the administrator just introduced. Disabling an entry, rotating
 * its key or editing its model list never spawns the sealed binary
 * (design gate P2-3 — PUT /api/config must not depend on a working runtime).
 */
export function idsRequiringCatalogProbe(
  entries: readonly { id: string }[],
  knownIds: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (!knownIds.has(entry.id) && !out.includes(entry.id)) out.push(entry.id)
  }
  return out
}
