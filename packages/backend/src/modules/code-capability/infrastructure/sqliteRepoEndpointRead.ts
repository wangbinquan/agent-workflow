// RFC-349 — SQLite observations for repository code-host resolution.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { cachedRepos, codeHostConnections, webhookEndpoints } from '@/db/schema'
import type { RepoEndpointReadPort } from '../application/ports/repoEndpointRead'

export function createSqliteRepoEndpointRead(db: DbClient): RepoEndpointReadPort {
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
