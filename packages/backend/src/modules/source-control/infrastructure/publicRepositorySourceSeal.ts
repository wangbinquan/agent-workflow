import { canonicalJson } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { SecretBox } from '@/auth/secretBox'
import { ensureCachedRepoIdentity } from '@/services/gitRepoCache'
import { ConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { PublicRepositorySourceSealPort } from '../application/ports/repositoryLaunch'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'
import { SealedRepositorySourceFactsSchema } from '../domain/repositoryPreparationFacts'
import { createRepositoryPreparationJournal } from './repositoryPreparationJournal'
import { composeRepositoryWorkspaceStore } from './repositoryWorkspaceStore'

/** No clone/fetch. The existing cache identity owner still seals credentials as before. */
export function createPublicRepositorySourceSeal(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly secretBox?: SecretBox
}): PublicRepositorySourceSealPort {
  const journal = createRepositoryPreparationJournal(input.db)
  const store = composeRepositoryWorkspaceStore(input.db)
  return Object.freeze<PublicRepositorySourceSealPort>({
    async seal(context, source) {
      const requestKey = `public-source:${context.idempotencyKey}`
      const requestDigest = `sha256:${sha256Hex(canonicalJson(source))}`
      const previous = await journal.sourceByRequest(requestKey)
      if (previous !== null) {
        if (previous.kind !== 'public-url' || previous.requestDigest !== requestDigest)
          throw new ConflictError(
            'repository-source-request-mismatch',
            'repository source request changed',
          )
        return decodeRepositoryLaunchRef('source', previous.id)
      }
      const identity = await ensureCachedRepoIdentity(
        {
          store,
          appHome: input.appHome,
          ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
        },
        { url: source.url },
      )
      const factsJson = canonicalJson(
        SealedRepositorySourceFactsSchema.parse({
          version: 1,
          kind: 'public-url',
          cachedRepoId: identity.cachedRepoId,
          requestedRef: source.requestedRef ?? null,
          url: source.url,
        }),
      )
      const sealed = await journal.seal({
        id: `sc:source:v1:${ulid()}`,
        requestKey,
        requestDigest,
        kind: 'public-url',
        factsJson,
        createdAt: context.now,
      })
      return decodeRepositoryLaunchRef('source', sealed.id)
    },
  })
}
