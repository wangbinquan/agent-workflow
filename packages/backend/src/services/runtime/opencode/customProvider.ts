/**
 * RFC-255 — the single source of truth for how an administrator-configured
 * OpenAI-compatible gateway reaches OpenCode.
 *
 * Four consumers depend on this module and must never derive the shape
 * independently: the sealed model enumeration, the three verified planners,
 * the launcher's admission check, and resume identity. The split between what
 * each of them sees is deliberate:
 *
 *   enumeration section — every enabled entry, WITH display names, no key.
 *                         Names are what the model picker shows.
 *   runtime section     — the ONE selected entry, no key and no display name.
 *                         It is hashed into the execution identity, so putting
 *                         the name there would make renaming a gateway break
 *                         resume for running tasks (design gate P2-2).
 *   auth                — the key alone, in OpenCode's strict api shape, and
 *                         only ever through OPENCODE_AUTH_CONTENT. Keeping it
 *                         out of the config is what lets a key rotation leave
 *                         the identity digest untouched (D5).
 *
 * `api` and `options.baseURL` are written from the same value on purpose:
 * OpenCode reports the former as `model.api.url` (provider.ts:1450) and the SDK
 * dials the latter (provider.ts:1693-1695). Writing one without the other would
 * let the endpoint we verify drift from the endpoint that actually serves the
 * request.
 */

import type { CustomProviderEntryWire } from '@agent-workflow/shared'
import {
  CUSTOM_PROVIDER_NPM,
  isValidCustomProviderBaseURL,
  validateCustomProviderEntry,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { createSecretBox } from '@/auth/secretBox'
import { loadConfig } from '@/config'
import { Paths } from '@/util/paths'
import { executionIdentityFailure } from './failure'
import type { IdentityJson } from './executionIdentity'
import type { StrictProviderAuth } from './hermetic'
import { buildStrictProviderAuth, resolveStrictProviderAuth } from './hermetic'

/** What a planner learns about the selected provider id. */
export type CustomProviderLookup =
  | { state: 'absent' }
  | { state: 'enabled'; entry: CustomProviderEntryWire }
  | { state: 'disabled'; entry: CustomProviderEntryWire }

/**
 * Structurally valid entries only.
 *
 * config.json is an operator-editable file: PUT validation can be bypassed by
 * editing it directly, so anything malformed is treated as absent rather than
 * trusted. Reporting it as absent (not as an error) keeps a hand-corrupted
 * entry from wedging unrelated runs.
 */
function isUsableEntry(entry: unknown): entry is CustomProviderEntryWire {
  return validateCustomProviderEntry(entry).length === 0
}

/**
 * Deliberately loose: every entry is validated below, so a narrow `Config`
 * slice would only force casts at the call seams without adding safety.
 */
export interface CustomProviderConfigSource {
  customProviders?: unknown
}

export function listUsableCustomProviders(
  cfg: CustomProviderConfigSource,
): CustomProviderEntryWire[] {
  const entries = cfg.customProviders
  if (!Array.isArray(entries)) return []
  return entries.filter(isUsableEntry)
}

export function findCustomProvider(
  cfg: CustomProviderConfigSource,
  providerID: string,
): CustomProviderLookup {
  const entry = listUsableCustomProviders(cfg).find((candidate) => candidate.id === providerID)
  if (entry === undefined) return { state: 'absent' }
  return entry.enabled ? { state: 'enabled', entry } : { state: 'disabled', entry }
}

/**
 * The provider section injected into the controlled config for ONE run.
 *
 * No key, no display name — see the module header for why each is excluded.
 */
export function buildControlledProviderSection(
  entry: CustomProviderEntryWire,
): Record<string, IdentityJson> {
  if (
    entry.npm !== CUSTOM_PROVIDER_NPM ||
    !isValidCustomProviderBaseURL(entry.baseURL) ||
    entry.models.length === 0
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  const models: Record<string, IdentityJson> = {}
  for (const model of entry.models) {
    if (model.id.length === 0) return executionIdentityFailure('execution-identity-mismatch')
    models[model.id] = {}
  }
  return {
    [entry.id]: {
      npm: entry.npm,
      api: entry.baseURL,
      options: { baseURL: entry.baseURL },
      models,
    },
  }
}

/**
 * The provider section used when enumerating models for the pickers.
 *
 * Carries display names (the picker renders them) and still no credential:
 * enumeration was measured to list config providers with `OPENCODE_AUTH_CONTENT`
 * left at `{}`, so the enumeration surface stays key-free by construction.
 */
export function buildEnumerationProviderSection(
  cfg: CustomProviderConfigSource,
): Record<string, IdentityJson> {
  const section: Record<string, IdentityJson> = {}
  for (const entry of listUsableCustomProviders(cfg)) {
    if (!entry.enabled) continue
    const models: Record<string, IdentityJson> = {}
    for (const model of entry.models) {
      models[model.id] = model.name === undefined ? {} : { name: model.name }
    }
    section[entry.id] = {
      npm: entry.npm,
      api: entry.baseURL,
      options: { baseURL: entry.baseURL },
      models,
      ...(entry.name === undefined ? {} : { name: entry.name }),
    }
  }
  return section
}

/**
 * A stable digest input describing the enumeration section.
 *
 * The sealed enumeration caches per binary; without this in the cache key an
 * administrator's edit would keep serving the previous model list.
 */
export function customProvidersProjection(cfg: CustomProviderConfigSource): string {
  const section = buildEnumerationProviderSection(cfg)
  const ids = Object.keys(section).sort()
  return JSON.stringify(ids.map((id) => [id, section[id]]))
}

/**
 * The gateway credential, unsealed from storage and re-validated against the
 * same strict predicate every other provider goes through.
 *
 * Re-using `buildStrictProviderAuth` rather than hand-rolling the JSON keeps a
 * single definition of "what OpenCode is allowed to receive" — upstream only
 * JSON.parses OPENCODE_AUTH_CONTENT, so this predicate is the whole check.
 */
export function buildCustomProviderAuth(
  entry: CustomProviderEntryWire,
  secretBox: Pick<SecretBox, 'unseal'>,
): StrictProviderAuth {
  const sealed = entry.apiKey
  if (typeof sealed !== 'string' || sealed.length === 0) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  let key: string
  try {
    key = secretBox.unseal(sealed)
  } catch {
    // Wrong or lost secret.key: the credential cannot be recovered, and this is
    // exactly the shape an operator sees after restoring a backup without it.
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  return buildStrictProviderAuth(entry.id, {
    OPENCODE_AUTH_CONTENT: JSON.stringify({ [entry.id]: { type: 'api', key } }),
  })
}

/**
 * Test seams for the planner-facing resolver below. Production reads the
 * daemon's own config file and secret key; tests inject both.
 */
export interface CustomProviderPlanDependencies {
  loadCustomProviderConfig?: () => CustomProviderConfigSource
  secretBox?: Pick<SecretBox, 'unseal'>
}

export interface ResolvedProviderCredential {
  /**
   * Undefined means "let OpenCode resolve it" — reachable only with RFC-256
   * machine-config inheritance on, where the provider is typically declared in
   * the operator's own `opencode.json` with an inline `apiKey` and no platform
   * channel has (or needs) a key for it.
   */
  auth?: StrictProviderAuth
  /** Present only for a platform-configured gateway; enters the frozen config. */
  customProvider?: Record<string, IdentityJson>
}

/**
 * Resolve the credential for a selected model, for all three planners.
 *
 * The disabled branch fails here rather than falling through to the generic
 * three-channel lookup. Falling through was the original design and it is
 * unsound in two measured ways: a leftover entry for the same id in the host's
 * native auth.json makes planning succeed and the run die much later as
 * `provider-untrusted`, and an id matching the credential-env table would be
 * satisfied by the daemon's own key against the VENDOR endpoint — the opposite
 * of what disabling a gateway is supposed to mean.
 */
export async function resolveProviderCredential(
  providerID: string,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  dependencies: CustomProviderPlanDependencies = {},
): Promise<ResolvedProviderCredential> {
  const loadCfg = dependencies.loadCustomProviderConfig ?? (() => loadConfig(Paths.config))
  const cfg = loadCfg()
  const lookup = findCustomProvider(cfg, providerID)
  if (lookup.state === 'absent') {
    // RFC-256: with machine-config inheritance on, a provider the operator
    // declared in their own opencode.json carries its own credential (an
    // inline `options.apiKey`, or their auth store). Failing here would be the
    // pre-RFC-256 regression itself — the platform refusing to launch because
    // IT could not find a key, for a provider it is not the one authenticating.
    const inherit = (cfg as { inheritMachineOpencodeConfig?: unknown }).inheritMachineOpencodeConfig
    if (inherit === false) {
      return { auth: await resolveStrictProviderAuth(providerID, sourceEnv) }
    }
    try {
      return { auth: await resolveStrictProviderAuth(providerID, sourceEnv) }
    } catch {
      return {}
    }
  }
  if (lookup.state === 'disabled') {
    return executionIdentityFailure('execution-identity-custom-provider-disabled')
  }
  const secretBox = dependencies.secretBox ?? createSecretBox(Paths.secretKeyFile)
  return {
    auth: buildCustomProviderAuth(lookup.entry, secretBox),
    customProvider: buildControlledProviderSection(lookup.entry),
  }
}

/**
 * RFC-256 — is machine-config inheritance on for this daemon?
 *
 * Read through the same seam the credential resolver uses so a test can flip it
 * without touching the real config file. Defaults to ON: that is the behavior
 * the platform had before RFC-224 sealed it off.
 */
export function inheritsMachineOpencodeConfig(
  dependencies: CustomProviderPlanDependencies = {},
): boolean {
  const loadCfg = dependencies.loadCustomProviderConfig ?? (() => loadConfig(Paths.config))
  const value = (loadCfg() as { inheritMachineOpencodeConfig?: unknown })
    .inheritMachineOpencodeConfig
  return value !== false
}

/** Admission values as the launcher sees them, recovered from the sealed plan. */
export interface AdmittedCustomProvider {
  id: string
  npm: string
  baseURL: string
  modelIds: readonly string[]
}

/**
 * Recover what was injected, from the manifest's own expected config.
 *
 * The launcher runs in a separate process from the planner and only receives
 * the manifest, so admission values must travel inside something already
 * carried and digest-protected. `expectedConfig.provider` IS the injected
 * section, which makes the admission comparison same-source by construction —
 * no new manifest field, nothing that can disagree with what was sent.
 */
export function admittedCustomFromExpectedConfig(
  expectedConfig: unknown,
  providerID: string,
): AdmittedCustomProvider | undefined {
  if (typeof expectedConfig !== 'object' || expectedConfig === null) return undefined
  const provider = (expectedConfig as { provider?: unknown }).provider
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return undefined
  if (!Object.hasOwn(provider, providerID)) return undefined
  const entry = (provider as Record<string, unknown>)[providerID]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const { npm, api, models } = entry as Record<string, unknown>
  if (typeof npm !== 'string' || typeof api !== 'string') return undefined
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return undefined
  return {
    id: providerID,
    npm,
    baseURL: api,
    modelIds: Object.keys(models as Record<string, unknown>),
  }
}
