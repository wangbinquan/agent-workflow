import { eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos } from '@/db/schema'
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

/**
 * RFC-359 AC-1 —— 两个 provider 共用这一份。
 *
 * 合一前是一对孪生体，函数体**逐字相同，只差一个 `await`**：SQLite 的 `.get()` 是同步游标、
 * PostgreSQL 的是 Promise，而 `.get()` 两个客户端都有。所以按 PG 那份的异步形状收成一份即可——
 * 在 SQLite 上 `await` 一个非 Promise 是 no-op，行为一格不动。
 *
 * **名字也已经收干净**（RFC-359 AC-1，plan §5fw）：合一那一轮为了不让导出符号数变动，
 * 正典沿用了 `createSqliteWebhookRepositoryResolver`、PG 那个名字做别名——于是一份**中立实现**
 * 顶着一个 `Sqlite` 的名字，同文件孪生账本据此把它记成「还有一对没合」。
 * 现在改名成中立的 `createWebhookRepositoryResolver` 并删掉别名：**是改名不是新增**，
 * 导出符号数从 2 降到 1，`rfc294-*` 那两本账只降不升。
 */
export function createWebhookRepositoryResolver(db: ProviderNeutralDatabase, secretBox: SecretBox) {
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
