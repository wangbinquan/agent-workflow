import {
  CONTRADICTED_URL_FACT_REASONS,
  LINKABLE_UNREADABLE_URL_REASONS,
  repositoryUrlFactKey,
  type RepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type { LookupReader } from '@/platform/persistence/migration/conversion/lookups'

/** RFC-626 §3.4 row 4: the decision a kept task or mount records when its cache URL is unreadable. */
export const REPOSITORY_URL_KEPT = 'v2-boot-url-kept-unreadable'

/**
 * RFC-626 §3.4 row 4: with automatic resolution a task or mount whose cache repository URL
 * cannot be restored is linked to that cache by URL hash instead of blocking. That is how the
 * previous release linked missing cache IDs at boot (v0.19.2 `services/repoCredentials.ts`
 * :235-262, independent of whether the cache URL could be unsealed). When no single cache has
 * the hash the column stays empty. A fact that is not blocked passes through unchanged.
 *
 * Only a reason the cache repository itself is kept for (`LINKABLE_UNREADABLE_URL_REASONS`, the
 * one list the cache rule and the schedule rule decide by) links: for any other reason — the
 * cache row could not be decoded and is set aside (`v2-boot-url-source-codec`), or the URL is
 * not proved at all — the cache is not in the new database, so the task and its mounts are kept
 * without a cache ID, as the schedule that names it is kept without one (implementation gate
 * G2-3).
 */
export function keepUnreadableRepositoryUrl(
  urls: LookupReader<RepositoryUrlFact>,
  fact: RepositoryUrlFact,
  rawUrl: string | null,
): { readonly fact: RepositoryUrlFact; readonly unreadable: string | null } {
  if (fact.state !== 'blocked') return { fact, unreadable: null }
  // §3.6: a fact that contradicts the frozen row is not an unreadable address. The cache
  // rule ends the upgrade for the same fact; the task that names it does not paper over it.
  if (fact.reason !== null && CONTRADICTED_URL_FACT_REASONS.includes(fact.reason))
    throw new ConversionContractError(fact.reason, rawUrl ?? '')
  const byUrl = rawUrl ? urls.get(repositoryUrlFactKey(rawUrl)) : undefined
  const linkable = fact.reason !== null && LINKABLE_UNREADABLE_URL_REASONS.includes(fact.reason)
  return {
    fact: {
      state: 'proven',
      cachedRepoId: fact.cachedRepoId ?? (linkable ? byUrl?.cachedRepoId : null) ?? null,
      repoUrl: byUrl?.repoUrl ?? rawUrl,
      rawUrlDigest: fact.rawUrlDigest,
      factIds: fact.factIds,
      reason: null,
    },
    unreadable: fact.reason ?? 'v2-boot-url-unproven',
  }
}
