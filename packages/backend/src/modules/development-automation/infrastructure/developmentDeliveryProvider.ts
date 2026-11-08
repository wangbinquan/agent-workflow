// RFC-359 W4-D13 —— development 交付面的仓库 / MR 事实目录：一份实现，两个 provider 共用。
// 无密钥嵌入下的「volatile 仓库 URL」按数据库句柄身份取（此前只有 SQLite 版接了这条回退）。
//
// RFC-471（RFC-294 W9-D）：代码托管绑定（按远端 URL 选连接、拼调用依赖）归 integration 的
// `composeDevelopmentCodeHostBinding`，它经本 provider 的 `resolveRepository` 取远端；这里只答仓库远端、
// MR 事实目标与 pipeline 执行。接口定义从 `services/developmentDeliveryDeps.ts` 迁来。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SelectedPipelineEvidenceExecution } from '@/modules/integration/public/participants'
import { unsealRepoUrl } from '@/services/repoCredentials'

export interface DevelopmentDeliveryProvider {
  resolveRepository(repositoryId: string): Promise<{
    readonly remoteUrl: string
    readonly defaultBranch: string | null
  } | null>
  readMrFactTarget(input: {
    readonly missionId: string
    readonly mrClaimId: string
  }): Promise<{ readonly repositoryId: string; readonly mrIid: string } | null>
  readonly pipeline: SelectedPipelineEvidenceExecution
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
  readonly pipeline: SelectedPipelineEvidenceExecution
}): DevelopmentDeliveryProvider {
  return providerFrom({
    directory: directoryOf(input.db),
    secretBox: input.secretBox,
    pipeline: input.pipeline,
    volatileRepositoryUrl: (row) => unsealRepoUrl(row, undefined, input.db),
  })
}
