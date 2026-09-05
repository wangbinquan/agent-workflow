// RFC-359 W4-D13 —— development 交付面的仓库 / MR 事实目录：一份实现，两个 provider 共用。
// 无密钥嵌入下的「volatile 仓库 URL」按数据库句柄身份取（此前只有 SQLite 版接了这条回退）。

import { and, eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos, developmentMissions, developmentMrClaims } from '@/db/schema'
import { matchRepoProvider } from '@/modules/integration/composition/codeHostEffects'
import type { PipelineEvidenceExecution } from '@/modules/integration/infrastructure/developmentPipelineAdapter'
import type { CodeHostConnectionsService } from '@/services/codeHost/connections'
import { unsealRepoUrl } from '@/services/repoCredentials'
import type { DevelopmentDeliveryProvider } from '@/services/developmentDeliveryDeps'

interface RepositoryRecord {
  readonly id: string
  readonly urlEnc: string | null
  readonly defaultBranch: string | null
}

interface DevelopmentDeliveryDirectory {
  repository(id: string): Promise<RepositoryRecord | null>
  mrFactTarget(input: {
    readonly missionId: string
    readonly mrClaimId: string
  }): Promise<{ readonly repositoryId: string; readonly mrIid: string } | null>
}

function providerFrom(input: {
  readonly directory: DevelopmentDeliveryDirectory
  readonly secretBox?: SecretBox
  readonly connections: CodeHostConnectionsService
  readonly pipeline: PipelineEvidenceExecution
  readonly volatileRepositoryUrl?: (row: RepositoryRecord) => string | null
}): DevelopmentDeliveryProvider {
  const resolveUrl = (row: RepositoryRecord): string | null =>
    unsealRepoUrl(row, input.secretBox) ?? input.volatileRepositoryUrl?.(row) ?? null

  const provider: DevelopmentDeliveryProvider = {
    async resolveRepository(repositoryId: string) {
      const row = await input.directory.repository(repositoryId)
      if (row === null) return null
      const remoteUrl = resolveUrl(row)
      return remoteUrl === null ? null : { remoteUrl, defaultBranch: row.defaultBranch }
    },
    async resolveBinding(repositoryId: string) {
      const row = await input.directory.repository(repositoryId)
      if (row === null) return null
      const remoteUrl = resolveUrl(row)
      if (remoteUrl === null) return null
      const candidates = (
        await Promise.all(
          (['gitlab', 'github'] as const).map((provider) => input.connections.resolve(provider)),
        )
      ).filter((connection) => connection !== null)
      const matched = matchRepoProvider(remoteUrl, candidates)
      if (matched === null) return null
      const connection = candidates.find((candidate) => candidate.provider === matched.provider)
      if (connection === undefined) return null
      return {
        provider: matched.provider,
        project: matched.project,
        call: { connection, ctx: { ports: {} } },
      }
    },
    readMrFactTarget: (target: { readonly missionId: string; readonly mrClaimId: string }) =>
      input.directory.mrFactTarget(target),
    pipeline: input.pipeline,
  }
  return Object.freeze(provider)
}

function directoryOf(db: ProviderNeutralDatabase): DevelopmentDeliveryDirectory {
  return {
    async repository(id) {
      return (
        (
          await db
            .select({
              id: cachedRepos.id,
              urlEnc: cachedRepos.urlEnc,
              defaultBranch: cachedRepos.defaultBranch,
            })
            .from(cachedRepos)
            .where(eq(cachedRepos.id, id))
            .limit(1)
        )[0] ?? null
      )
    },
    async mrFactTarget(input) {
      return (
        (
          await db
            .select({
              repositoryId: developmentMissions.repositoryId,
              mrIid: developmentMrClaims.mrIid,
            })
            .from(developmentMissions)
            .innerJoin(
              developmentMrClaims,
              and(
                eq(developmentMrClaims.id, input.mrClaimId),
                eq(developmentMrClaims.missionId, developmentMissions.id),
              ),
            )
            .where(eq(developmentMissions.id, input.missionId))
            .limit(1)
        )[0] ?? null
      )
    },
  }
}

export function createDevelopmentDeliveryProvider(input: {
  readonly db: ProviderNeutralDatabase
  readonly secretBox?: SecretBox
  readonly connections: CodeHostConnectionsService
  readonly pipeline: PipelineEvidenceExecution
}): DevelopmentDeliveryProvider {
  return providerFrom({
    directory: directoryOf(input.db),
    secretBox: input.secretBox,
    connections: input.connections,
    pipeline: input.pipeline,
    volatileRepositoryUrl: (row) => unsealRepoUrl(row, undefined, input.db),
  })
}
