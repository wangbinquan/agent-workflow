/**
 * RFC-255 — layer 2 of the catalog-id collision check.
 *
 * A custom provider whose id equals a built-in catalog id does not create a new
 * provider: OpenCode merges the config entry INTO the catalog one, so that
 * catalog's entire model map inherits the operator's endpoint. The static
 * `RESERVED_PROVIDER_IDS` snapshot catches the ids known when it was generated;
 * this probe covers the window until it is refreshed.
 *
 * It cannot simply ask the enumeration what providers exist — the sealed
 * enumeration runs with no credentials, and a catalog provider only enters
 * OpenCode's provider map once a credential triggers it. So the probe asks the
 * inverse question: inject a config entry under the candidate id carrying ONE
 * synthetic model, and see whether more than that model comes back. Anything
 * extra can only be inherited catalog content, which is exactly the collision.
 */

import type { RuntimeModelList } from '../types'

/** Model id that cannot collide with a real one from any provider. */
const CANARY_MODEL_ID = '__aw_catalog_canary__'

export interface CatalogProbeDependencies {
  /**
   * Enumerate models with an injected config. Production passes a closure over
   * `listOpencodeModelsHermetic` bound to the effective OpenCode binary.
   */
  enumerate: (injectedProviderSection: Record<string, unknown>) => Promise<RuntimeModelList>
}

/**
 * True when `providerID` names a built-in catalog provider.
 *
 * Fails OPEN on an enumeration error (returns false) on purpose: the static
 * snapshot has already run by this point, and a broken or missing runtime
 * binary must not stop an administrator from saving an ordinary gateway. The
 * cost of a miss is a save that later fails admission, not a silent redirect —
 * the launcher's model-subset check still refuses to run a collided provider.
 */
export async function probeCatalogCollisionWith(
  providerID: string,
  dependencies: CatalogProbeDependencies,
): Promise<boolean> {
  let result: RuntimeModelList
  try {
    result = await dependencies.enumerate({
      [providerID]: {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://aw-catalog-probe.invalid/v1',
        options: { baseURL: 'https://aw-catalog-probe.invalid/v1' },
        models: { [CANARY_MODEL_ID]: {} },
      },
    })
  } catch {
    return false
  }
  const prefix = `${providerID}/`
  const reported = result.models
    .map((model) => model.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
  // The canary itself may be filtered out by upstream status rules; what marks
  // a collision is the presence of any model the platform did not inject.
  return reported.some((id) => id !== CANARY_MODEL_ID)
}
