// RFC-248 T41（设计门二轮 H8）—— 结构化 diff 的仓归属读**显式 `repoKey`**，
// 不再按第一个路径段反推。
//
// 反推在两种情况下会错，而且都是**静默**错（不报错，只是文件被归到别的仓、
// 相对路径也跟着错，于是文件内容请求打到错的仓、导航跳空）：
//
//   1. **多段挂载路径**。`vendor/sdk` 是一个挂载点，但 `split('/')[0]` 只取
//      `vendor`，rel 变成 `sdk/lib/x.rs`——标签与相对路径同时错。RFC-066 时代
//      挂载名恒为单段 basename，所以这个 bug 是随嵌套布局一起诞生的。
//   2. **容器仓产出落在子挂载前缀下的路径**。sparse checkout 不会把已跟踪的
//      路径从索引里删掉，容器仓自己完全可能改到 `vendor/sdk/...`；纯前缀反推
//      会把它判给子仓。
//
// 这条只覆盖 structural-only 分支（文本 diff 被 1 MiB 截断丢块时走它）——
// 有文本 diff 时归属来自 `# === Repo:` 分段头，那条路径由 changeReview 既有
// 测试覆盖。

import { describe, expect, test } from 'vitest'
import { buildChangeEntries } from '@/lib/changeReview'
import type { StructuralDiff } from '@agent-workflow/shared'

/** 构造一个只有结构化侧的 diff（文本侧给空数组 ⇒ 走 structural-only 分支）。 */
function structuralOnly(files: Array<{ filePath: string; repoKey?: string }>): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'multi',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: files.map((f) => ({
      filePath: f.filePath,
      ...(f.repoKey !== undefined ? { repoKey: f.repoKey } : {}),
      lang: 'ts',
      status: 'ok',
      changes: [],
      edges: [],
      impact: [],
    })),
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: { files: files.length, added: 0, removed: 0, modified: 0, renamed: 0 },
  } as unknown as StructuralDiff
}

describe('RFC-248 T41 —— 结构化 diff 的仓归属', () => {
  test('多段挂载路径：repoKey=`vendor/sdk` ⇒ 标签整段保留，rel 不含挂载前缀', () => {
    const [entry] = buildChangeEntries(
      [],
      structuralOnly([{ filePath: 'vendor/sdk/lib/x.ts', repoKey: 'vendor/sdk' }]),
    )
    expect(entry?.repoLabel).toBe('vendor/sdk')
    expect(entry?.filePath).toBe('lib/x.ts')
    // 旧的反推会给出 `vendor` + `sdk/lib/x.ts`——两者都错。
    expect(entry?.repoLabel).not.toBe('vendor')
    expect(entry?.filePath).not.toBe('sdk/lib/x.ts')
  })

  test('挂根成员：repoKey=`` ⇒ 无标签，路径原样（不能变成 `/x.ts`）', () => {
    const [entry] = buildChangeEntries([], structuralOnly([{ filePath: 'src/a.ts', repoKey: '' }]))
    expect(entry?.repoLabel).toBeNull()
    expect(entry?.filePath).toBe('src/a.ts')
  })

  test('容器仓产出落在子挂载前缀下的路径 ⇒ 仍归容器，不被前缀骗走', () => {
    // H8 的反例：路径长得像子仓的，`repoKey` 说它属于根仓。
    const [entry] = buildChangeEntries(
      [],
      structuralOnly([{ filePath: 'vendor/sdk/leaked.ts', repoKey: '' }]),
    )
    expect(entry?.repoLabel).toBeNull()
    expect(entry?.filePath).toBe('vendor/sdk/leaked.ts')
  })

  test('两个仓里的同名文件产出两条互不覆盖的条目', () => {
    const entries = buildChangeEntries(
      [],
      structuralOnly([
        { filePath: 'frontend/src/index.ts', repoKey: 'frontend' },
        { filePath: 'backend/src/index.ts', repoKey: 'backend' },
      ]),
    )
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.repoLabel).sort()).toEqual(['backend', 'frontend'])
    // 相对路径一样，但 key（以及 viewedKey）必须不同，否则「已查看」状态会串。
    expect(entries.every((e) => e.filePath === 'src/index.ts')).toBe(true)
    expect(new Set(entries.map((e) => e.viewedKey)).size).toBe(2)
  })

  test('存量数据（无 repoKey）回落到旧的单段反推——不能因为升级就丢分组', () => {
    const [entry] = buildChangeEntries([], structuralOnly([{ filePath: 'utils/a.ts' }]))
    expect(entry?.repoLabel).toBe('utils')
    expect(entry?.filePath).toBe('a.ts')
  })
})
