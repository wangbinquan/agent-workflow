import type {
  RepositoryBaselineEffects,
  RepositoryBaselineEffectsFactory,
} from '../application/ports/repositoryBaselineEffects'
import { createFileRepositoryBaselineEffectsFactory } from './local/fileRepositoryBaselineEffects'
// RFC-310 / RFC-370: baseline selection and reader lifetime stay with this owner.
// The complete binary Git reader and stream hash live in the DA local adapter.

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos } from '@/db/schema'
import type { BaselineFileReader, BaselineStat } from '../application/uploadPlan'
import type { UploadBaselineContext } from '../application/commands/launchMission'
import type { RepositoryLocationRead } from '../application/ports/repositoryLocationRead'

function selectedRepositoryBaselineEffects(
  effects?: RepositoryBaselineEffectsFactory,
): RepositoryBaselineEffectsFactory {
  return effects === undefined ? createFileRepositoryBaselineEffectsFactory() : effects
}

async function withRepositoryBaselineEffects<T>(
  effects: RepositoryBaselineEffectsFactory,
  body: (scope: RepositoryBaselineEffects) => T | Promise<T>,
): Promise<T> {
  if (effects == null || typeof effects.acquire !== 'function') {
    throw new Error('repository-baseline-effects-factory-incomplete')
  }
  const scope = await effects.acquire()
  let value!: T
  let bodyFailed = false
  let bodyError: unknown
  try {
    if (
      scope == null ||
      ['readHead', 'bindFileReader', 'close'].some(
        (method) => typeof scope[method as keyof RepositoryBaselineEffects] !== 'function',
      )
    ) {
      throw new Error('repository-baseline-effects-scope-incomplete')
    }
    value = await body(scope)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }
  let closeFailed = false
  let closeError: unknown
  if (scope != null && typeof scope.close === 'function') {
    try {
      await scope.close()
    } catch (error) {
      closeFailed = true
      closeError = error
    }
  }
  if (bodyFailed && closeFailed) {
    throw new AggregateError(
      [bodyError, closeError],
      'repository-baseline-effects-body-and-close-failed',
    )
  }
  if (bodyFailed) throw bodyError
  if (closeFailed) throw closeError
  return value
}

/**
 * 生产 resolveBaseline：repositoryId（cached_repos.id）→ 本地缓存 checkout 的
 * exact HEAD sha 冻结为 baseline。仓库未缓存/HEAD 不可解析 ⇒ null（launch 侧
 * 老实 blocked('baseline-reader-not-wired')，不猜默认分支）。
 */
/** PR-4 —— attempt 编排的 baseline 定位（repoPath + exact head；无 reader）。 */
export function createActionBaselineResolver(
  repositories: RepositoryLocationRead,
  factory?: RepositoryBaselineEffectsFactory,
): (repositoryId: string) => Promise<{ repoPath: string; headSha: string } | null> {
  const effects = selectedRepositoryBaselineEffects(factory)
  return async (repositoryId) => {
    const localPath = await repositories.localPath(repositoryId)
    if (localPath === null) return null
    return withRepositoryBaselineEffects(effects, async (scope) => {
      const head = await scope.readHead(localPath)
      if (head.exitCode !== 0) return null
      const sha = head.stdout.trim()
      if (!/^[0-9a-f]{40}$/.test(sha)) return null
      return { repoPath: localPath, headSha: sha }
    })
  }
}

export function createRepositoryBaselineResolverFromLocations(
  repositories: RepositoryLocationRead,
  factory?: RepositoryBaselineEffectsFactory,
): (repositoryId: string) => Promise<UploadBaselineContext | null> {
  const effects = selectedRepositoryBaselineEffects(factory)
  return async (repositoryId) => {
    const localPath = await repositories.localPath(repositoryId)
    if (localPath === null) return null
    return withRepositoryBaselineEffects(effects, async (scope) => {
      const head = await scope.readHead(localPath)
      if (head.exitCode !== 0) return null
      const sha = head.stdout.trim()
      if (!/^[0-9a-f]{40}$/.test(sha)) return null
      return {
        repositoryRef: repositoryId,
        baselineSnapshotRef: `git:${sha}`,
        baselineSha: sha,
        reader: createGitBaselineReader(localPath, sha, effects),
      }
    })
  }
}

/** repositoryId → cached_repos.localPath：一份实现，两个 provider 共用（RFC-359 W4-D12）。 */
export function createRepositoryLocationRead(db: ProviderNeutralDatabase): RepositoryLocationRead {
  return {
    async localPath(repositoryId) {
      const row = (
        await db
          .select({ localPath: cachedRepos.localPath })
          .from(cachedRepos)
          .where(eq(cachedRepos.id, repositoryId))
          .limit(1)
      )[0]
      return row?.localPath ?? null
    },
  }
}

/** 直接吃数据库句柄的便捷工厂（focused 调用方 / 测试用）。 */
export function resolveActionBaseline(
  db: ProviderNeutralDatabase,
  factory?: RepositoryBaselineEffectsFactory,
) {
  return createActionBaselineResolver(createRepositoryLocationRead(db), factory)
}

export function createRepositoryBaselineResolver(
  db: ProviderNeutralDatabase,
  factory?: RepositoryBaselineEffectsFactory,
) {
  return createRepositoryBaselineResolverFromLocations(createRepositoryLocationRead(db), factory)
}

export function createGitBaselineReader(
  repoPath: string,
  headSha: string,
  factory?: RepositoryBaselineEffectsFactory,
): BaselineFileReader {
  const effects = selectedRepositoryBaselineEffects(factory)
  return {
    async stat(path: string): Promise<BaselineStat> {
      return withRepositoryBaselineEffects(effects, async (scope) => {
        const reader = await scope.bindFileReader(repoPath, headSha)
        if (reader == null || typeof reader.stat !== 'function') {
          throw new Error('repository-baseline-file-reader-incomplete')
        }
        return await reader.stat(path)
      })
    },
  }
}
