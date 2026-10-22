// RFC-359 W4-B5 —— 仓库代码托管端点解析的观察读取：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { RepoEndpointReadPort } from '../application/ports/repoEndpointRead'

export function createRepoEndpointRead(db: PersistenceDb): RepoEndpointReadPort {
  return {
    async listEnabledEndpoints() {
      const { webhookEndpoints } = tablesOf(db)
      return await db
        .select({ id: webhookEndpoints.id, provider: webhookEndpoints.provider })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.enabled, true))
    },
    async readRepoUrl(repoId) {
      const { cachedRepos } = tablesOf(db)
      const [repo] = await db
        .select({ urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, repoId))
        .limit(1)
      return repo?.urlRedacted ?? null
    },
    async listConnections() {
      const { codeHostConnections } = tablesOf(db)
      return await db
        .select({
          provider: codeHostConnections.provider,
          baseUrl: codeHostConnections.baseUrl,
          repositoryUrlPrefixesJson: codeHostConnections.repositoryUrlPrefixesJson,
        })
        .from(codeHostConnections)
    },
  }
}
