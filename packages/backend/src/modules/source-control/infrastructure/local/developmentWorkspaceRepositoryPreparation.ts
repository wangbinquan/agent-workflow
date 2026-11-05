// RFC-310 — development workspace repository preparation: fetch the registered mirror and check that the
// configured default branch is fresh before a Digital Employee baseline is frozen (RFC-451: moved verbatim from
// services/developmentDeliveryDeps; a deployment selection, chosen by the deployment profile).

import type { SecretBox } from '@/auth/secretBox'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { DomainError, NotFoundError } from '@/util/errors'
import { resolveCachedRepo } from './repositoryMirrorCache'

export interface DevelopmentWorkspaceRepositoryPreparation {
  prepare(input: { readonly repositoryId: string }): Promise<{
    readonly id: string
    readonly localPath: string
    readonly defaultBranch: string | null
  }>
}

export function assertDevelopmentWorkspaceRepositoryFreshness(input: {
  readonly repositoryId: string
  readonly urlRedacted: string
  readonly configuredDefaultBranch: string | null
  readonly preparedDefaultBranch: string | null
  readonly ffOutcomes: readonly {
    readonly branch: string
    readonly warning: string | null
  }[]
}): string {
  const defaultBranch = input.preparedDefaultBranch
  if (defaultBranch === null || defaultBranch.length === 0) {
    throw new DomainError(
      'cached-repo-default-branch-unavailable',
      `cached repo '${input.repositoryId}' has no resolvable default branch after refresh`,
      409,
      { url: input.urlRedacted },
    )
  }
  const missingConfiguredBranch = input.ffOutcomes.some(
    (outcome) =>
      outcome.branch === input.configuredDefaultBranch && outcome.warning === 'origin-ref-missing',
  )
  if (missingConfiguredBranch) {
    throw new DomainError(
      'repo-ref-not-found',
      `default branch '${input.configuredDefaultBranch}' no longer exists in ${input.urlRedacted}; refusing to freeze the stale local branch`,
      400,
      { url: input.urlRedacted, ref: input.configuredDefaultBranch },
    )
  }
  return defaultBranch
}

export function buildDevelopmentWorkspaceRepositoryPreparation(
  provider: DevelopmentWorkspaceRepositoryPreparation,
): DevelopmentWorkspaceRepositoryPreparation {
  return Object.freeze({
    prepare: (input: { readonly repositoryId: string }) => provider.prepare(input),
  })
}

/** Provider-neutral cache mechanics; bootstrap supplies the selected store. */
export function createDevelopmentWorkspaceRepositoryPreparation(input: {
  readonly store: RepositoryWorkspaceStore
  readonly appHome: string
  readonly secretBox?: SecretBox
}): DevelopmentWorkspaceRepositoryPreparation {
  return Object.freeze({
    async prepare(request: { readonly repositoryId: string }) {
      const row = await input.store.findCachedRepoById(request.repositoryId)
      if (row === null) {
        throw new NotFoundError(
          'cached-repo-not-found',
          `cached repo '${request.repositoryId}' not found`,
        )
      }
      const url = unsealRepoUrl(row, input.secretBox, input.store)
      if (url === null) {
        throw new DomainError(
          'cached-repo-credential-unavailable',
          `cached repo '${request.repositoryId}' has no readable URL (sealed with a different secret.key?)`,
          409,
        )
      }
      const prepared = await resolveCachedRepo(
        {
          store: input.store,
          appHome: input.appHome,
          secretBox: input.secretBox,
          syncBranches:
            row.defaultBranch === null || row.defaultBranch.length === 0 ? [] : [row.defaultBranch],
        },
        { url },
      )
      if (!prepared.fetchOk) {
        throw new DomainError(
          'repo-fetch-failed',
          `repository fetch failed for ${prepared.cached.urlRedacted}; refusing to freeze a stale Digital Employee baseline`,
          502,
          { url: prepared.cached.urlRedacted, stderr: prepared.fetchError },
        )
      }
      if (prepared.cached.id !== row.id) {
        throw new DomainError(
          'cached-repo-identity-mismatch',
          `cached repository identity changed while preparing '${row.id}'`,
          409,
        )
      }
      const defaultBranch = assertDevelopmentWorkspaceRepositoryFreshness({
        repositoryId: row.id,
        urlRedacted: prepared.cached.urlRedacted,
        configuredDefaultBranch: row.defaultBranch,
        preparedDefaultBranch: prepared.cached.defaultBranch,
        ffOutcomes: prepared.ffOutcomes,
      })
      return {
        id: prepared.cached.id,
        localPath: prepared.cached.localPath,
        defaultBranch,
      }
    },
  })
}
