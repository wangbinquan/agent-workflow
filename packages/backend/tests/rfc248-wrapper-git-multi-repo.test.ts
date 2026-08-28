// RFC-248 PR-4 T28 —— wrapper-git 的多仓形态（D9）。
//
// 设计门二轮 H4 更正了这块的设计：`git_diff` 端口**从来不是完整 patch**，
// 它是 `list<path<*>>`（`shared/src/nodePorts.ts:188`，`scheduler.ts` 的注释亦
// 写明「newline-joined file paths」）。初稿写的「每仓一段拼接的 patch」照做会让
// 下游 wrapper-fanout 把 `# === Repo:` 标记行和补丁行当成文件路径。
//
// 正确契约：逐仓 `gitChangedFiles`，各自的路径用该成员的**挂载路径**前缀化后
// 合并成一个路径列表。这样：
//   - 端口类型不变，下游 fanout 一行不用改；
//   - 分片天然带仓归属（两个仓的同名文件不再撞成一个 shard_key）；
//   - agent 拿到 `vendor/sdk/lib/x.rs`，`cd` 过去就到位。
//
// 本文件锁纯函数级的前缀合并语义与只读过滤；整条包裹器链路的端到端行为由
// scheduler 的既有 wrapper 测试覆盖（它们跑单仓，保 baseline）。

import { describe, expect, test } from 'bun:test'
import { WrapperProgressSchema } from '@/modules/task-execution/domain/wrapperProgress'

/** 复刻 GitStrategy/WrapperWorkspace adapter 的合并规则，锁语义。 */
function mergePrefixed(
  perRepo: Array<{ mountPath: string; readonly?: boolean; paths: string[] }>,
): string[] {
  const out: string[] = []
  for (const r of perRepo) {
    if (r.readonly === true) continue
    for (const p of r.paths) out.push(r.mountPath === '' ? p : `${r.mountPath}/${p}`)
  }
  return out
}

describe('T28 —— git_diff 是挂载路径前缀化的 list<path>', () => {
  test('挂根的成员不加前缀；嵌套成员加自己的挂载路径', () => {
    expect(
      mergePrefixed([
        { mountPath: '', paths: ['src/a.ts', 'src/b.ts'] },
        { mountPath: 'vendor/sdk', paths: ['lib/x.rs'] },
      ]),
    ).toEqual(['src/a.ts', 'src/b.ts', 'vendor/sdk/lib/x.rs'])
  })

  test('两个仓里的同名文件产出**不同**的路径（否则分片会撞成一个）', () => {
    const merged = mergePrefixed([
      { mountPath: 'frontend', paths: ['src/index.ts'] },
      { mountPath: 'backend', paths: ['src/index.ts'] },
    ])
    expect(merged).toEqual(['frontend/src/index.ts', 'backend/src/index.ts'])
    expect(new Set(merged).size).toBe(2)
  })

  test('只读成员的改动不进 git_diff（D11）', () => {
    expect(
      mergePrefixed([
        { mountPath: '', paths: ['app.ts'] },
        { mountPath: 'vendor/sdk', readonly: true, paths: ['leaked.ts'] },
      ]),
    ).toEqual(['app.ts'])
  })

  test('单个可写仓且挂根 ⇒ 输出与今天字节级一致（无任何前缀）', () => {
    // 这条保 baseline：现存的单仓 wrapper-git 工作流不能因为本 RFC 变样。
    expect(mergePrefixed([{ mountPath: '', paths: ['a.ts', 'b/c.ts'] }])).toEqual([
      'a.ts',
      'b/c.ts',
    ])
  })

  test('三层嵌套各自带完整挂载路径', () => {
    expect(
      mergePrefixed([
        { mountPath: '', paths: ['x'] },
        { mountPath: 'vendor/sdk', paths: ['y'] },
        { mountPath: 'vendor/sdk/ext', paths: ['z'] },
      ]),
    ).toEqual(['x', 'vendor/sdk/y', 'vendor/sdk/ext/z'])
  })
})

describe('T28 —— WrapperProgress 的逐仓字段与向后兼容', () => {
  test('新增的 baselines / preDirtyByRepo 被 schema 接受', () => {
    const parsed = WrapperProgressSchema.parse({
      kind: 'git',
      baseline: 'abc',
      preDirty: { 'a.ts': 'h1' },
      baselines: { '': 'abc', 'vendor/sdk': 'def' },
      preDirtyByRepo: { '': { 'a.ts': 'h1' }, 'vendor/sdk': {} },
      phase: 'inner-running',
    })
    expect(parsed.baselines?.['vendor/sdk']).toBe('def')
    expect(parsed.preDirtyByRepo?.['']?.['a.ts']).toBe('h1')
  })

  test('RFC-248 之前的 payload（只有标量）仍能解析——升级期跑在半路的包裹器不能炸', () => {
    const parsed = WrapperProgressSchema.parse({
      kind: 'git',
      baseline: 'abc',
      preDirty: { 'a.ts': 'h1' },
      phase: 'inner-running',
    })
    expect(parsed.baseline).toBe('abc')
    expect(parsed.baselines).toBeUndefined()
    // 调用方据此回落成 `{ '': baseline }`——单仓的挂载路径正好是空串，
    // 两种形态天然对齐（见 scheduler.ts 的 resume 分支）。
    const fallback = parsed.baselines ?? { '': parsed.baseline }
    expect(fallback['']).toBe('abc')
  })

  test('标量字段仍是必留的——既有遥测与老 payload resume 都读它', () => {
    // 翻新成 map-only 会让升级瞬间跑在半路的包裹器读不到基线、把整棵工作树
    // 当成新增。这条锁住「标量不许删」这个决定。
    const shape = WrapperProgressSchema.parse({ kind: 'git', baseline: 'x', phase: 'awaiting' })
    expect(shape.baseline).toBe('x')
  })
})
