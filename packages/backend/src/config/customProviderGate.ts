/**
 * RFC-255 — the one place that decides what a custom-provider submission is
 * allowed to persist, and what any reader is allowed to see.
 *
 * Both the HTTP route and the CLI go through here. That is not tidiness: the
 * CLI writes the same config file, so a gate living only in the route would let
 * `agent-workflow config set` store an entry the API would have rejected —
 * including one whose id collides with a built-in catalog provider.
 *
 * The mask is a placeholder, never a credential. Outbound it replaces the
 * sealed value; inbound it means "keep what is stored". A submission that
 * offers the mask for an id with nothing stored is rejected rather than saved,
 * so the placeholder can never become the secret.
 */

import {
  CUSTOM_PROVIDER_API_KEY_MASK,
  isPreservedApiKey,
  isReservedProviderId,
  validateCustomProviders,
  type Config,
  type CustomProviderEntryWire,
  type CustomProviderIssue,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import { ValidationError } from '@/util/errors'

function entries(cfg: Pick<Config, 'customProviders'>): CustomProviderEntryWire[] {
  const value = cfg.customProviders
  return Array.isArray(value) ? (value as CustomProviderEntryWire[]) : []
}

/**
 * Replace every stored credential with the mask.
 *
 * Applied to GET responses, PUT responses and CLI output alike: the frontend
 * re-reads the body it gets back from a save, so masking only the GET would
 * still hand the browser a real key on every edit.
 */
export function maskConfigForOutput<T extends Pick<Config, 'customProviders'>>(cfg: T): T {
  const list = entries(cfg)
  if (list.length === 0) return cfg
  return {
    ...cfg,
    customProviders: list.map((entry) => ({
      ...entry,
      ...(entry.apiKey === undefined ? {} : { apiKey: CUSTOM_PROVIDER_API_KEY_MASK }),
    })),
  }
}

function issueMessage(issue: CustomProviderIssue): string {
  const where = issue.index === undefined ? '' : ` (entry #${issue.index + 1})`
  const detail = issue.detail === undefined ? '' : `: ${issue.detail}`
  return `${issue.code}${where}${detail}`
}

function throwIssues(issues: readonly CustomProviderIssue[]): never {
  const first = issues[0]!
  throw new ValidationError(first.code, issueMessage(first), {
    field: first.field === undefined ? 'customProviders' : `customProviders.${first.field}`,
    permanent: true,
    issues: issues.map((issue) => ({ ...issue })),
  })
}

export interface CustomProviderGateDependencies {
  /**
   * Probe whether an id is actually a built-in catalog provider (layer 2 of the
   * collision check). Runs only for ids that are new to this config, so
   * disabling an entry or rotating a key never depends on a working runtime.
   */
  probeCatalogCollision?: (id: string) => Promise<boolean>
}

/**
 * Validate a merged config's customProviders against what is currently stored,
 * and return the list with credentials sealed and preserved values carried over.
 *
 * `current` is the config as persisted (sealed keys); `next` is the merge
 * result from the patch (wire values). The returned list is what should be
 * written.
 */
export async function resolveCustomProvidersForSave(
  current: Pick<Config, 'customProviders'>,
  next: Pick<Config, 'customProviders'>,
  secretBox: Pick<SecretBox, 'seal'>,
  dependencies: CustomProviderGateDependencies = {},
): Promise<CustomProviderEntryWire[]> {
  const stored = new Map(entries(current).map((entry) => [entry.id, entry]))
  const submitted = entries(next)
  const issues = validateCustomProviders(submitted, new Set(stored.keys()))
  if (issues.length > 0) throwIssues(issues)

  const probe = dependencies.probeCatalogCollision
  if (probe !== undefined) {
    for (const entry of submitted) {
      if (stored.has(entry.id) || isReservedProviderId(entry.id)) continue
      if (await probe(entry.id)) {
        throwIssues([
          {
            code: 'config-custom-provider-id-catalog',
            field: 'id',
            detail: entry.id,
            index: submitted.indexOf(entry),
          },
        ])
      }
    }
  }

  return submitted.map((entry) => {
    const previousKey = stored.get(entry.id)?.apiKey
    // Byte-identical to what is already stored ⇒ this is the stored (sealed)
    // value coming back around, not a new secret. Sealing it again would
    // produce a double-sealed credential that unseals to ciphertext, and the
    // gateway would reject every request with no hint as to why.
    if (previousKey !== undefined && entry.apiKey === previousKey) {
      return { ...entry, apiKey: previousKey }
    }
    if (isPreservedApiKey(entry.apiKey)) {
      const previous = stored.get(entry.id)
      // validateCustomProviders already rejected "preserve" with nothing to
      // preserve; this is the type-level tail of that guarantee.
      if (previous?.apiKey === undefined) {
        throwIssues([
          {
            code: 'config-custom-provider-apikey-required',
            field: 'apiKey',
            detail: entry.id,
            index: submitted.indexOf(entry),
          },
        ])
      }
      return { ...entry, apiKey: previous.apiKey }
    }
    return { ...entry, apiKey: secretBox.seal(entry.apiKey as string) }
  })
}
