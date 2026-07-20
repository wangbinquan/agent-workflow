// RFC-210 T26 — crash replay 必须带着 submodule 拓扑一起重建。
//
// 为什么这条测试存在：
//
// daemon 在「节点成功」与「merge-back」之间崩溃时，resume 会从持久化的列重建
// IsoHandle 并重放 merge-back。RFC-210 之前 `IsoRepo` 里没有任何 submodule 字段，
// 于是重放只做父仓层合并——而父仓层对「两边都动过的 gitlink」的语义是「取 theirs」，
// 兄弟节点在子仓里的提交**静默消失**，正是本 RFC 立项要修的那类丢失。
//
// 所以这里锁两件事：
//  1. persistIsoBase 写进去的形状，rebuildIsoHandle 能原样读回来（往返）；
//  2. single / multi 是**两列**，不是一列。多仓任务里两个仓各有一个 `vendor` 子仓
//     时，扁平 map 会让后写的覆盖先写的。
//
// 另外校验是**防御性**的：坏 JSON 视作「没有」而不是「半信」，因为下游的
// fail-closed 门是靠「没有」来触发拒绝重放的。

import { describe, expect, test } from 'bun:test'
import { IsoSubmodulesSchema } from '@agent-workflow/shared'
import { rebuildIsoHandle, type CanonRepo } from '@/services/nodeIsolation'

const canonRepos: CanonRepo[] = [
  { repoPath: '/r/a', worktreePath: '/wt/a', worktreeDirName: 'a', baseBranch: 'main' },
  { repoPath: '/r/b', worktreePath: '/wt/b', worktreeDirName: 'b', baseBranch: 'main' },
]

describe('RFC-210 crash replay carries submodule topology', () => {
  test('rebuildIsoHandle restores subBases and poolDirs per repo', () => {
    const handle = rebuildIsoHandle({
      appHome: '/home',
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos,
      baseSnapshots: { a: 'basea', b: 'baseb' },
      taskBaseHeads: { a: 'heada', b: 'headb' },
      submodules: {
        a: { subBases: { vendor: 'sha-a-vendor' }, poolDirs: { vendor: '/pool/a/vendor' } },
        b: { subBases: { vendor: 'sha-b-vendor' }, poolDirs: { vendor: '/pool/b/vendor' } },
      },
    })
    // Same submodule NAME in two repos must keep two distinct bases — a flat map
    // keyed only by submodule path would have collapsed these.
    expect(handle.repos[0]?.subBases).toEqual({ vendor: 'sha-a-vendor' })
    expect(handle.repos[1]?.subBases).toEqual({ vendor: 'sha-b-vendor' })
    expect(handle.repos[0]?.poolDirs['vendor']).toBe('/pool/a/vendor')
    expect(handle.repos[1]?.poolDirs['vendor']).toBe('/pool/b/vendor')
  })

  test('a repo with no recorded topology rebuilds empty rather than undefined', () => {
    const handle = rebuildIsoHandle({
      appHome: '/home',
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos,
      baseSnapshots: {},
      taskBaseHeads: {},
      submodules: { a: { subBases: { vendor: 's' }, poolDirs: {} } },
    })
    expect(handle.repos[0]?.subBases).toEqual({ vendor: 's' })
    // Repo 'b' was never recorded — downstream code checks Object.keys().length,
    // so it must be an empty object, not undefined.
    expect(handle.repos[1]?.subBases).toEqual({})
    expect(handle.repos[1]?.poolDirs).toEqual({})
  })

  test('omitting submodules entirely keeps the pre-RFC-210 shape', () => {
    const handle = rebuildIsoHandle({
      appHome: '/home',
      taskId: 't1',
      nodeRunId: 'r1',
      canonRepos,
      baseSnapshots: {},
      taskBaseHeads: {},
    })
    for (const r of handle.repos) {
      expect(r.subBases).toEqual({})
      expect(r.poolDirs).toEqual({})
    }
  })
})

describe('RFC-210 IsoSubmodules persistence schema', () => {
  test('accepts the shape persistIsoBase writes', () => {
    const parsed = IsoSubmodulesSchema.safeParse({
      poolDirs: { vendor: '/pool/vendor' },
      subBases: { vendor: 'abc123', 'vendor/inner': 'def456' },
    })
    expect(parsed.success).toBe(true)
  })

  test('poolDirs may be empty (degraded / path-mode repos)', () => {
    expect(IsoSubmodulesSchema.safeParse({ poolDirs: {}, subBases: {} }).success).toBe(true)
  })

  test('carries the optional merge-back fields', () => {
    const parsed = IsoSubmodulesSchema.safeParse({
      poolDirs: {},
      subBases: { vendor: 'abc' },
      subSnapshots: { vendor: { head: 'h', snapshot: 's', pinRef: 'refs/x' } },
      pendingSubResolves: ['vendor'],
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects a malformed payload so the caller can treat it as ABSENT', () => {
    // Absent is what arms the fail-closed replay gate; silently accepting a
    // half-parsed object would let a parent-only merge through.
    expect(IsoSubmodulesSchema.safeParse({ subBases: { vendor: 'abc' } }).success).toBe(false)
    expect(IsoSubmodulesSchema.safeParse({ poolDirs: {}, subBases: 'nope' }).success).toBe(false)
    expect(IsoSubmodulesSchema.safeParse(null).success).toBe(false)
  })
})
