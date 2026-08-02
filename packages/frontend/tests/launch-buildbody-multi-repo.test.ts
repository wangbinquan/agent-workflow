// RFC-066 PR-C —— 曾经覆盖 v1（单仓）/ v2（多仓 `repos[]`）两种 body 形态。
//
// RFC-248 T38 把 v2 整条删了：多仓改由 `repoGroupId` 表达，`repos[]` 在 wire 上
// 退役（服务端 422 硬拒）。本文件现在锁两件事：
//   - `buildLaunchBodyMultiRepo` **不得复活**；
//   - 单仓 byte-baseline 与 `computePreviewDirNames` 的既有语义不变。
//
// RFC-165: rows are URL-only — the path-mode fixtures and the RFC-068
// fetchBeforeLaunch carry-through went away with the local-path launch mode.

import { describe, expect, test } from 'vitest'
import {
  buildLaunchBody,
  computePreviewDirNames,
  defaultRepoSource,
} from '@/lib/launch-repo-source'

describe('RFC-248 T38 —— `buildLaunchBodyMultiRepo` 已删除，不得复活', () => {
  test('模块不再导出多仓 body 构造器', async () => {
    // 它唯一的产出是 wire 上已退役的 `repos: [...]`（顶层 `repos` 进了
    // RETIRED_START_TASK_KEYS，服务端 422 硬拒）。任何「顺手加回来」都会让
    // 多仓启动整条挂掉，所以这里把「不存在」本身锁成契约。
    const mod = (await import('@/lib/launch-repo-source')) as Record<string, unknown>
    expect(mod.buildLaunchBodyMultiRepo).toBeUndefined()
  })

  test('单仓 body 里绝不出现 `repos` 键', () => {
    const body = buildLaunchBody(
      { kind: 'url', repoUrl: 'https://x/r.git', ref: 'main' },
      { workflowId: 'wf', name: 't', inputs: {} },
    )
    expect(body.repos).toBeUndefined()
    expect(body.repoUrl).toBe('https://x/r.git')
  })
})

describe('buildLaunchBody RFC-066 single-repo byte-baseline (regression lock)', () => {
  test('legacy url body unchanged', () => {
    const body = buildLaunchBody(
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'feature/x' },
      { workflowId: 'wf-1', name: 't', inputs: {} },
    )
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 't',
      repoUrl: 'git@h:o/r.git',
      inputs: {},
      ref: 'feature/x',
    })
    expect('repos' in body).toBe(false)
  })
})

describe('computePreviewDirNames (RFC-066)', () => {
  // F6: basename collision resolution mirrors backend resolveMultiRepoDirName.
  test('F6 same basename → -2 / -3 suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'git@github.com:b/utils.git', ref: '' },
      { kind: 'url', repoUrl: 'https://github.com/c/utils', ref: '' },
    ])
    expect(names).toEqual(['utils', 'utils-2', 'utils-3'])
  })

  test('F6b length 1 always returns [""] (no preview in single-repo mode)', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
    ])
    expect(names).toEqual([''])
  })

  test('F6c URL mode basename strips .git suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:org/repo-a.git', ref: '' },
      { kind: 'url', repoUrl: 'https://github.com/org/repo-b', ref: '' },
    ])
    expect(names).toEqual(['repo-a', 'repo-b'])
  })

  test('F6d empty row → empty preview slot (UI suppresses chip)', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:a/utils.git', ref: '' },
      defaultRepoSource(),
    ])
    expect(names).toEqual(['utils', ''])
  })
})
