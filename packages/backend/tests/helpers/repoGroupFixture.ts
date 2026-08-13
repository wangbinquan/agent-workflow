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

import {
  normalizeRepoNodePath,
  parentNodePath,
  type RepoGroupNodeInput,
} from '@agent-workflow/shared'
import type { DbClient } from '../../src/db/client'
import { createRepoGroup } from '../../src/services/repoGroup'
import { remoteUrlFor, startGitHttpRemote } from './gitHttpRemote'


export type RepoGroupAttachmentSpec =
  | {
      kind: 'repo'
      cachedRepoId?: string
      repoUrl?: string
      ref: string
      subdir: string
      mountPath: string
      readonly: boolean
    }
  | {
      kind: 'group'
      childGroupId: string
      mountPath: string
      readonly: boolean
    }

/**
 * Build the explicit directory-node closure used by the RFC-249 wire contract.
 * Keeping this adapter in tests lets older scenario descriptions stay concise
 * without reintroducing the retired production model.
 */
export function repoGroupNodesFromAttachments(
  attachments: readonly RepoGroupAttachmentSpec[],
): RepoGroupNodeInput[] {
  const nodes: RepoGroupNodeInput[] = [{ path: '', attachment: null }]
  const byPath = new Map<string, RepoGroupNodeInput>([['', nodes[0]!]])

  const ensureDirectory = (path: string): RepoGroupNodeInput => {
    const folded = path.toLowerCase()
    const existing = byPath.get(folded)
    if (existing !== undefined) return existing
    const parent = parentNodePath(path)
    if (parent !== null) ensureDirectory(parent)
    const node: RepoGroupNodeInput = { path, attachment: null }
    nodes.push(node)
    byPath.set(folded, node)
    return node
  }

  for (const spec of attachments) {
    let normalized: string
    try {
      normalized = normalizeRepoNodePath(spec.mountPath)
    } catch {
      nodes.push({
        path: spec.mountPath,
        attachment:
          spec.kind === 'repo'
            ? {
                kind: 'repo',
                ...(spec.cachedRepoId === undefined
                  ? { repoUrl: spec.repoUrl }
                  : { cachedRepoId: spec.cachedRepoId }),
                ref: spec.ref,
                subdir: spec.subdir,
                readonly: spec.readonly,
              }
            : {
                kind: 'group',
                childGroupId: spec.childGroupId,
                readonly: spec.readonly,
              },
      })
      continue
    }

    const target = ensureDirectory(normalized)
    const attachment: RepoGroupNodeInput['attachment'] =
      spec.kind === 'repo'
        ? {
            kind: 'repo',
            ...(spec.cachedRepoId === undefined
              ? { repoUrl: spec.repoUrl }
              : { cachedRepoId: spec.cachedRepoId }),
            ref: spec.ref,
            subdir: spec.subdir,
            readonly: spec.readonly,
          }
        : {
            kind: 'group',
            childGroupId: spec.childGroupId,
            readonly: spec.readonly,
          }
    if (target.attachment === null) {
      target.path = spec.mountPath
      target.attachment = attachment
    } else {
      nodes.push({ path: spec.mountPath, attachment })
    }
  }
  return nodes
}

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
  // RFC-287 T11：夹具仓经真实 git smart-HTTP 远端（`file://` 已是非法来源）。
  // 在这里 await 而不是要求每个调用方自己起——本夹具有 13 个下游，漏一个就红。
  await startGitHttpRemote()
  const readonlySet = new Set(options.readonlyIndexes ?? [])
  const group = await createRepoGroup(
    { db, cache: { db, appHome } },
    {
      name: options.name ?? `fixture-group-${sourcePaths.length}`,
      description: '',
      nodes: repoGroupNodesFromAttachments(
        sourcePaths.map((repoPath, i) => ({
          kind: 'repo' as const,
          repoUrl: remoteUrlFor(repoPath),
          ref: '',
          subdir: '',
          mountPath: options.mountPaths?.[i] ?? `r${i}`,
          readonly: readonlySet.has(i),
        })),
      ),
    },
    null,
  )
  return group.id
}
