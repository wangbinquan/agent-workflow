// RFC-310 PR-5 T53 —— RepositoryFactsCollectorPort 的生产实现。
//
// repositoryId → cached_repos.localPath（gitBaselineReader 同款定位）→ 真仓库
// 启发式探测：languages（扩展名）/ buildSystems（构建文件）/ moduleIds
// （maven <modules> 或含构建文件的顶层子目录，根含构建文件记 'root'）。
// cells 的 sourceRevision = exact HEAD sha：HEAD 前进后 re-collect 产生新
// sourceRevision ⇒ cells 内容变化 ⇒ decision dedup 键自然重开（refresh/失效
// 不需要专用逻辑，design §2.6）。
//
// context projection（T53 后半）：module catalog 之外把 contributor 指令文档
// （CONTRIBUTING/AGENTS/CLAUDE 类根文档）与 per-module 语言归属投影为 `__`
// 前缀内部 cells——它们是 prompt/上下文素材而非规则 facts（catalog 之外的键
// 一律走 `__` 内部投影约定；正文永不进 cells，只投影相对路径/归属对）。
//
// RFC-370 §10 V18 (a)：探测读 HEAD 的提交树（`repositoryFactsScan.ts`），由所选
// 实现执行——单机在进程内，托管在开发卷内（`repository-facts-scan`）；cells 投影
// 只在这里一份。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { FactCell } from '../domain/factCell'
import type { FactCellValue } from '../domain/facts'
import type { RepositoryFactsCollectorPort } from '../application/ports/reconcilerPorts'
import type { RepositoryLocationRead } from '../application/ports/repositoryLocationRead'
import { createRepositoryLocationRead } from './gitBaselineReader'
import { scanRepositoryFacts, type RepositoryFactsScan } from './repositoryFactsScan'

/** Scans the repository at its stored location (a local path or a volume reference). */
export type RepositoryFactsScanner = (localPath: string) => Promise<RepositoryFactsScan>

export function createRepositoryFactsCollectorFromLocations(
  repositories: RepositoryLocationRead,
  scan: RepositoryFactsScanner = scanRepositoryFacts,
): RepositoryFactsCollectorPort {
  return {
    async collect(input) {
      const localPath = await repositories.localPath(input.repositoryId)
      if (localPath === null) {
        throw new Error(`repository not cached: ${input.repositoryId}`)
      }
      let facts: RepositoryFactsScan
      try {
        facts = await scan(localPath)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}: ${input.repositoryId}`,
        )
      }
      const headSha = facts.headSha
      const moduleIds =
        facts.mavenModules.length > 0
          ? facts.mavenModules
          : facts.moduleBuildDirs.map((dir) => (dir === '' ? 'root' : dir))
      const known = (value: FactCellValue): FactCell<FactCellValue> => ({
        state: 'known',
        value,
        sourceRevision: headSha,
      })
      const cells: Record<string, FactCell<FactCellValue>> = {
        'repository.languages': known([...facts.languages]),
        'repository.buildSystems': known([...facts.buildSystems]),
        'repository.moduleIds': known([...new Set(moduleIds)].sort()),
        'repository.defaultBranchKnown': known(true),
        // context projection（内部 `__` cells：素材，不是规则 facts）。
        '__repository.contributorDocs': known([...facts.contributorDocs]),
        '__repository.languageByModule': known([...facts.languageByModule]),
      }
      return { cells, factsRef: `repo:${headSha}` }
    },
  }
}

/** 一份实现，两个 provider 共用（RFC-359 W4-D12）；托管装配交入卷内扫描。 */
export function createRepositoryFactsCollector(
  db: ProviderNeutralDatabase,
  scan?: RepositoryFactsScanner,
): RepositoryFactsCollectorPort {
  return createRepositoryFactsCollectorFromLocations(createRepositoryLocationRead(db), scan)
}
