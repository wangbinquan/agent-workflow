import { and, eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { cachedRepos, developmentMissions, developmentMrClaims } from '@/db/schema'
import { matchRepoProvider } from '@/modules/integration/composition/codeHostEffects'
import type { PipelineEvidenceExecution } from '@/modules/integration/infrastructure/developmentPipelineAdapter'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
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

function sqliteDirectory(db: DbClient): DevelopmentDeliveryDirectory {
  return {
    async repository(id) {
      return (
        db
          .select({
            id: cachedRepos.id,
            urlEnc: cachedRepos.urlEnc,
            defaultBranch: cachedRepos.defaultBranch,
          })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, id))
          .get() ?? null
      )
    },
    async mrFactTarget(input) {
      const row = db
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
        .get()
      return row ?? null
    },
  }
}

function postgresqlDirectory(db: PostgresqlDatabaseClient): DevelopmentDeliveryDirectory {
  return {
    async repository(id) {
      return (
        (await db
          .select({
            id: cachedRepos.id,
            urlEnc: cachedRepos.urlEnc,
            defaultBranch: cachedRepos.defaultBranch,
          })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, id))
          .limit(1)
          .get()) ?? null
      )
    },
    async mrFactTarget(input) {
      const row = await db
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
        .get()
      return row ?? null
    },
  }
}

export function createSqliteDevelopmentDeliveryProvider(input: {
  readonly db: DbClient
  readonly secretBox?: SecretBox
  readonly connections: CodeHostConnectionsService
  readonly pipeline: PipelineEvidenceExecution
}): DevelopmentDeliveryProvider {
  return providerFrom({
    directory: sqliteDirectory(input.db),
    secretBox: input.secretBox,
    connections: input.connections,
    pipeline: input.pipeline,
    volatileRepositoryUrl: (row) => unsealRepoUrl(row, undefined, input.db),
  })
}

export function createPostgresqlDevelopmentDeliveryProvider(input: {
  readonly db: PostgresqlDatabaseClient
  readonly secretBox?: SecretBox
  readonly connections: CodeHostConnectionsService
  readonly pipeline: PipelineEvidenceExecution
}): DevelopmentDeliveryProvider {
  return providerFrom({
    directory: postgresqlDirectory(input.db),
    secretBox: input.secretBox,
    connections: input.connections,
    pipeline: input.pipeline,
  })
}
