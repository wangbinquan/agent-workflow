// RFC-248 T32 —— 多仓测试夹具：把「N 个本地源仓」变成一个可启动的仓库组。
//
// `repos[]` 退役后，多仓启动的**唯一**入口是 `repoGroupId`。既有的多仓测试
// （task-diff / callgraph / structural-diff / pre-worktree …）原本各自内联一段
// `repos: [{ repoPath }]`，现在统一经这里建组，避免四处重复建组样板、也避免
// 各文件对组结构的理解发生漂移。
//
// 默认布局是**平铺**（挂载点 `r0` / `r1` / …），与 RFC-066 时代的
// `worktreeDirName` 形态最接近，保证这些测试锁的仍是它们原本锁的东西。
// 需要嵌套布局的测试自己传 `mountPaths`。

import { pathToFileURL } from 'node:url'
import type { DbClient } from '../../src/db/client'
import { createRepoGroup } from '../../src/services/repoGroup'

export interface GroupFixtureOptions {
  /** 每个源仓的挂载路径；默认 `r0` / `r1` / …（平铺）。 */
  mountPaths?: readonly string[]
  /** 只读成员的下标集合（D11）。 */
  readonlyIndexes?: readonly number[]
  name?: string
}

/**
 * 用给定的本地源仓路径建一个仓库组，返回组 id。
 *
 * 源仓经 `file://` URL 走正常的导入路径落成 `cached_repos`——和生产一致，
 * 不绕过 RFC-204 的 URL 封存。
 */
export async function seedRepoGroup(
  db: DbClient,
  appHome: string,
  sourcePaths: readonly string[],
  options: GroupFixtureOptions = {},
): Promise<string> {
  const readonlySet = new Set(options.readonlyIndexes ?? [])
  const group = await createRepoGroup(
    { db, cache: { db, appHome } },
    {
      name: options.name ?? `fixture-group-${sourcePaths.length}`,
      description: '',
      members: sourcePaths.map((repoPath, i) => ({
        kind: 'repo' as const,
        repoUrl: pathToFileURL(repoPath).href,
        ref: '',
        subdir: '',
        mountPath: options.mountPaths?.[i] ?? `r${i}`,
        readonly: readonlySet.has(i),
      })),
    },
    null,
  )
  return group.id
}
