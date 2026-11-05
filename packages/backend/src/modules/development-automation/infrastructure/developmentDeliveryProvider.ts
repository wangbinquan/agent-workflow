// RFC-359 W4-D13 —— development 交付面的仓库 / MR 事实目录：一份实现，两个 provider 共用。
// 无密钥嵌入下的「volatile 仓库 URL」按数据库句柄身份取（此前只有 SQLite 版接了这条回退）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { matchRepoProvider } from '@/modules/development-automation/domain/repositoryProviderMatch'
import type { SelectedPipelineEvidenceExecution } from '@/modules/integration/public/participants'
import { unsealRepoUrl } from '@/services/repoCredentials'
import type { DevelopmentDeliveryProvider } from '@/services/developmentDeliveryDeps'

/** RFC-449 / RFC-450: the binding this provider resolves, typed by the delivery contract itself so this
 * module imports neither the credential service nor the code-host request implementation. */
type DeliveryBinding = NonNullable<
  Awaited<ReturnType<DevelopmentDeliveryProvider['resolveBinding']>>
>
type DeliveryCodeHostConnection = DeliveryBinding['call']['connection']

/** The only thing the delivery provider needs from code-host connections. */
export interface DevelopmentCodeHostConnections {
  resolve(provider: 'gitlab' | 'github'): Promise<DeliveryCodeHostConnection | null>
}

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
  readonly connections: DevelopmentCodeHostConnections
  /** RFC-450: the code-host requests every resolved binding sends through (injected by assembly). */
  readonly requests: DeliveryBinding['requests']
  readonly pipeline: SelectedPipelineEvidenceExecution
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
        requests: input.requests,
      }
    },
    readMrFactTarget: (target: { readonly missionId: string; readonly mrClaimId: string }) =>
      input.directory.mrFactTarget(target),
    pipeline: input.pipeline,
  }
  return Object.freeze(provider)
}

function directoryOf(db: PersistenceDb): DevelopmentDeliveryDirectory {
  return {
    async repository(id) {
      const { cachedRepos } = tablesOf(db)
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
      const { developmentMissions, developmentMrClaims } = tablesOf(db)
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
  readonly db: PersistenceDb
  readonly secretBox?: SecretBox
  readonly connections: DevelopmentCodeHostConnections
  readonly requests: DeliveryBinding['requests']
  readonly pipeline: SelectedPipelineEvidenceExecution
}): DevelopmentDeliveryProvider {
  return providerFrom({
    directory: directoryOf(input.db),
    secretBox: input.secretBox,
    connections: input.connections,
    requests: input.requests,
    pipeline: input.pipeline,
    volatileRepositoryUrl: (row) => unsealRepoUrl(row, undefined, input.db),
  })
}
