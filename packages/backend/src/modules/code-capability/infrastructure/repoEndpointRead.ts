// RFC-359 W4-B5 —— 仓库代码托管端点解析的观察读取：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos, codeHostConnections, webhookEndpoints } from '@/db/schema'
import type { RepoEndpointReadPort } from '../application/ports/repoEndpointRead'

export function createRepoEndpointRead(db: ProviderNeutralDatabase): RepoEndpointReadPort {
  return {
    async listEnabledEndpoints() {
      return await db
        .select({ id: webhookEndpoints.id, provider: webhookEndpoints.provider })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.enabled, true))
    },
    async readRepoUrl(repoId) {
      const [repo] = await db
        .select({ urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, repoId))
        .limit(1)
      return repo?.urlRedacted ?? null
    },
    async listConnections() {
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
