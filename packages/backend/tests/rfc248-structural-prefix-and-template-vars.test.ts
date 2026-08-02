// RFC-248 PR-4 T29b/T33 —— 结构化 diff 的根成员前缀 + 模板变量。
//
// **T29b（设计门一轮 G3）** 现状不变量是「加前缀 ⟺ 多仓」：单仓走
// `structuralDiff/service.ts:95-118` 的早分支、完全不加前缀，与文本 diff 单仓
// 无分段头的形态一致。仓库组引入「挂根成员」后它的规范 key 是空串——无条件拼
// `${label}/` 会产出 `/src/a.ts`，而文本 diff 那边是 `src/a.ts`；前端
// `lib/changeReview.ts` 靠路径**逐字符相等**来 join 两侧，于是根仓的符号、
// 严重度、文件内容、导航会**静默脱节**（不是报错，是悄悄对不上）。
//
// **T33** `{{__repo_names__}}` 从 basename 改渲染挂载路径：嵌套布局下 basename
// 彻底丢失方位——agent 拿到 `utils-2` 不知道该去哪个目录。

import { describe, expect, test } from 'bun:test'
import { mergeStructuralDiffs, prefixIdPath } from '@/services/structuralDiff/assemble'
import type { StructuralDiff } from '@agent-workflow/shared'

/** 最小可用的单文件结构化 diff 夹具。 */
function mkDiff(filePath: string): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'b',
    engine: 'baseline',
    status: 'ok',
    files: [{ filePath, lang: 'other', status: 'ok', changes: [], edges: [], impact: [] }],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: { files: 0, added: 0, removed: 0, modified: 0, renamed: 0 },
  } as unknown as StructuralDiff
}
import { renderUserPrompt } from '@agent-workflow/shared'

describe('T29b —— 结构化 diff 的根成员不加前缀', () => {
  test('空 label 原样返回，非空 label 才拼前缀', () => {
    // prefixPath 不导出，用经由它的 prefixIdPath 间接验证。
    expect(prefixIdPath('', 'src/a.ts#fn:parse', '#')).toBe('src/a.ts#fn:parse')
    expect(prefixIdPath('vendor/b', 'lib/x.rs#fn:go', '#')).toBe('vendor/b/lib/x.rs#fn:go')
  })

  test('绝不产出 `/src/...` 这种以斜杠开头的路径', () => {
    // 这正是 bug 的形状：`'' + '/' + 'src/a.ts'`。
    const out = prefixIdPath('', 'src/a.ts', '#')
    expect(out.startsWith('/')).toBe(false)
    expect(out).toBe('src/a.ts')
  })

  test('无分隔符的裸路径同样遵守', () => {
    expect(prefixIdPath('', 'README.md', '::')).toBe('README.md')
    expect(prefixIdPath('a/b', 'README.md', '::')).toBe('a/b/README.md')
  })

  test('分隔符之后的部分不受影响', () => {
    expect(prefixIdPath('', 'src/a.ts::Card#1', '::')).toBe('src/a.ts::Card#1')
    expect(prefixIdPath('m', 'src/a.ts::Card#1', '::')).toBe('m/src/a.ts::Card#1')
  })
})

describe('T28b —— 结构化实体显式携带 repoKey（设计门二轮 H8）', () => {
  test('mergeStructuralDiffs 给每个文件项打上 repoKey，且与前缀一致', () => {
    const merged = mergeStructuralDiffs(
      {
        scope: 'task',
        taskId: 't',
        fromRef: 'multi',
        toRef: 'WORKTREE',
        engine: 'baseline',
        status: 'ok',
      } as never,
      [
        { label: '', diff: mkDiff('src/a.ts') },
        { label: 'vendor/sdk', diff: mkDiff('lib/x.rs') },
      ],
    )
    expect(merged.files.map((f) => [f.repoKey, f.filePath])).toEqual([
      ['', 'src/a.ts'],
      ['vendor/sdk', 'vendor/sdk/lib/x.rs'],
    ])
  })

  test('归属不再依赖路径反推——即便容器仓产出了落在子挂载前缀下的路径', () => {
    // 这正是 H8 的反例：sparse 不删索引里的已跟踪路径，容器仍可能产出
    // `vendor/sdk/...`。纯前缀反推会把它判给子仓；显式 repoKey 不会。
    const merged = mergeStructuralDiffs(
      {
        scope: 'task',
        taskId: 't',
        fromRef: 'multi',
        toRef: 'WORKTREE',
        engine: 'baseline',
        status: 'ok',
      } as never,
      [{ label: '', diff: mkDiff('vendor/sdk/leaked.ts') }],
    )
    expect(merged.files[0]?.repoKey).toBe('') // 属于根仓，不是 vendor/sdk
    expect(merged.files[0]?.filePath).toBe('vendor/sdk/leaked.ts')
  })
})

describe('T33 —— 模板变量', () => {
  const base = {
    promptTemplate: '',
    inputs: {},
    // 零输出端口 ⇒ 不追加协议块，断言只看模板变量本身的渲染结果。
    agentOutputs: [] as string[],
    meta: { repoPath: '/src/app', baseBranch: 'main', taskId: 't1', nodeId: 'n1' },
  }

  test('__repo_names__ 渲染挂载路径而不是 basename', () => {
    const out = renderUserPrompt({
      ...base,
      promptTemplate: '{{__repo_names__}}',
      meta: {
        ...base.meta,
        repos: [
          {
            repoPath: '/s/app',
            worktreePath: '/w',
            worktreeDirName: '',
            mountPath: '',
            baseBranch: 'main',
          },
          {
            repoPath: '/s/sdk',
            worktreePath: '/w/vendor/sdk',
            worktreeDirName: 'sdk',
            mountPath: 'vendor/sdk',
            baseBranch: 'main',
          },
        ],
      },
    })
    // 挂根的成员渲染空行——它就在 cwd，没有相对路径可 cd。
    expect(out).toContain('vendor/sdk')
    // basename 形态（`sdk` 单独成行）必须**不再**出现。
    expect(out.split('\n').some((l) => l.trim() === 'sdk')).toBe(false)
  })

  test('未带 mountPath 的调用方回落到 worktreeDirName（存量平铺取值一致）', () => {
    const out = renderUserPrompt({
      ...base,
      promptTemplate: '{{__repo_names__}}',
      meta: {
        ...base.meta,
        repos: [
          { repoPath: '/s/a', worktreePath: '/w/a', worktreeDirName: 'a', baseBranch: 'main' },
        ],
      },
    })
    expect(out).toContain('a')
  })

  test('__repo_group__ 渲染组名；非组启动渲染空串', () => {
    const withGroup = renderUserPrompt({
      ...base,
      promptTemplate: '[{{__repo_group__}}]',
      meta: { ...base.meta, repoGroupName: '全栈' },
    })
    expect(withGroup.split('\n')[0]).toBe('[全栈]')

    const without = renderUserPrompt({ ...base, promptTemplate: '[{{__repo_group__}}]' })
    expect(without.split('\n')[0]).toBe('[]')
  })

  test('单仓 baseline：不带 repos 时三个多仓占位符仍渲染空/零', () => {
    const out = renderUserPrompt({
      ...base,
      promptTemplate: 'N={{__repo_count__}} G=[{{__repo_group__}}]',
    })
    // renderUserPrompt 总会追加输出协议块，所以只断言模板渲染出的首行。
    expect(out.split('\n')[0]).toBe('N=0 G=[]')
  })
})
