import { eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { unsealRepoUrl } from '@/services/repoCredentials'
import type { WebhookEndpointRow } from '@/services/webhook/dispatcherTypes'
import type { RepoResolution } from '@/services/webhook/webhookDispatch'
import { sha1Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import {
  gitUrlCacheKeyWith,
  isFileSchemeUrl,
  parseGitUrl,
  type CodeHostEvent,
} from '@agent-workflow/shared'

const log = createLogger('webhook-repository-resolver')

type CachedRepository = Readonly<{
  id: string
  urlEnc: string | null
}>

async function resolveWithLookup(
  lookup: (urlHash: string) => Promise<CachedRepository | null>,
  secretBox: SecretBox,
  event: CodeHostEvent,
  endpoint: Pick<WebhookEndpointRow, 'preferredCloneProtocol'>,
  autoRegister: boolean,
): Promise<RepoResolution> {
  for (const url of [event.repoHttpUrl, event.repoSshUrl]) {
    const parsed = parseGitUrl(url)
    if (parsed === null) continue
    const key = gitUrlCacheKeyWith(parsed, sha1Hex)
    const row = await lookup(key.hash)
    if (row === null) continue
    const plain = unsealRepoUrl(row, secretBox)
    if (plain !== null) {
      const rowParsed = parseGitUrl(plain)
      if (
        rowParsed === null ||
        gitUrlCacheKeyWith(rowParsed, sha1Hex).canonical !== key.canonical
      ) {
        log.warn('url_hash bucket collision — not adopting cached repo', {
          repoPath: event.repoPath,
          cachedRepoId: row.id,
        })
        continue
      }
    } else {
      log.warn('cached repo url not verifiable (sealed, unseal failed); adopting by hash', {
        cachedRepoId: row.id,
      })
    }
    return { kind: 'cached', cachedRepoId: row.id }
  }
  if (!autoRegister) return { kind: 'unregistered' }
  const autoUrl = endpoint.preferredCloneProtocol === 'ssh' ? event.repoSshUrl : event.repoHttpUrl
  if (isFileSchemeUrl(autoUrl)) {
    log.warn('refusing to auto-register a file:// repo from a webhook event', {
      repoPath: event.repoPath,
    })
    return { kind: 'unregistered' }
  }
  return { kind: 'url', repoUrl: autoUrl }
}

export function createSqliteWebhookRepositoryResolver(db: DbClient, secretBox: SecretBox) {
  return async (
    event: CodeHostEvent,
    endpoint: Pick<WebhookEndpointRow, 'preferredCloneProtocol'>,
    autoRegister: boolean,
  ): Promise<RepoResolution> =>
    await resolveWithLookup(
      async (urlHash) =>
        db
          .select({ id: cachedRepos.id, urlEnc: cachedRepos.urlEnc })
          .from(cachedRepos)
          .where(eq(cachedRepos.urlHash, urlHash))
          .get() ?? null,
      secretBox,
      event,
      endpoint,
      autoRegister,
    )
}

export function createPostgresqlWebhookRepositoryResolver(
  db: PostgresqlDatabaseClient,
  secretBox: SecretBox,
) {
  return async (
    event: CodeHostEvent,
    endpoint: Pick<WebhookEndpointRow, 'preferredCloneProtocol'>,
    autoRegister: boolean,
  ): Promise<RepoResolution> =>
    await resolveWithLookup(
      async (urlHash) =>
        (await db
          .select({ id: cachedRepos.id, urlEnc: cachedRepos.urlEnc })
          .from(cachedRepos)
          .where(eq(cachedRepos.urlHash, urlHash))
          .get()) ?? null,
      secretBox,
      event,
      endpoint,
      autoRegister,
    )
}
