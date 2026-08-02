// RFC-248 T35 —— `RepoLayoutTree` 的树投影。
//
// 核心是 `buildLayoutTree`：把**已展平**的 `PlannedRepo[]` 按挂载路径的父子
// 关系还原成树。两条容易写错、且错了会静默的规则：
//
//   1. **段边界**。`vendor/sdk` 是 `vendor/sdk/ext` 的父，但**不是**
//      `vendor/sdkx` 的父——裸 `startsWith` 会把后者也吞进来，用户看到一棵
//      结构错误的树（而且不报错）。
//   2. **最长祖先才是父**。`''`（挂根）、`vendor`、`vendor/sdk` 三者都可能是
//      `vendor/sdk/ext` 的祖先，父节点必须取最长的那个，否则三层布局会被压成
//      两层。

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { PlannedRepo } from '@agent-workflow/shared'
import { RepoLayoutTree, buildLayoutTree } from '@/components/repos/RepoLayoutTree'

function repo(mountPath: string, over: Partial<PlannedRepo> = {}): PlannedRepo {
  return {
    cachedRepoId: `cr_${mountPath || 'root'}`,
    repoUrlRedacted: `https://git.example/${mountPath || 'root'}.git`,
    ref: '',
    subdir: '',
    mountPath,
    readonly: false,
    viaGroups: [],
    ...over,
  }
}

/** 树 → `mountPath` 的嵌套数组，方便一眼断言结构。 */
function shape(nodes: ReturnType<typeof buildLayoutTree>): unknown[] {
  return nodes.map((n) =>
    n.children.length === 0 ? n.repo.mountPath : [n.repo.mountPath, shape(n.children)],
  )
}

describe('buildLayoutTree —— 挂载路径的父子投影', () => {
  test('挂根成员是所有人的父', () => {
    expect(shape(buildLayoutTree([repo(''), repo('vendor/sdk'), repo('tools')]))).toEqual([
      ['', ['tools', 'vendor/sdk']],
    ])
  })

  test('三层嵌套：父取**最长**祖先，不被压层', () => {
    const tree = buildLayoutTree([
      repo(''),
      repo('vendor'),
      repo('vendor/sdk'),
      repo('vendor/sdk/ext'),
    ])
    expect(shape(tree)).toEqual([['', [['vendor', [['vendor/sdk', ['vendor/sdk/ext']]]]]]])
  })

  test('段边界：`vendor/sdkx` 不是 `vendor/sdk` 的孩子', () => {
    const tree = buildLayoutTree([repo('vendor/sdk'), repo('vendor/sdkx')])
    // 两者都没有祖先 ⇒ 都是根。裸 startsWith 会把 sdkx 挂到 sdk 下面。
    expect(shape(tree)).toEqual(['vendor/sdk', 'vendor/sdkx'])
  })

  test('没有挂根成员时，多个顶层挂载点并列', () => {
    expect(shape(buildLayoutTree([repo('frontend'), repo('backend')]))).toEqual([
      'frontend',
      'backend',
    ])
  })

  test('输入顺序不影响结果（深度排序在内部完成）', () => {
    const deep = buildLayoutTree([repo('vendor/sdk/ext'), repo(''), repo('vendor/sdk')])
    expect(shape(deep)).toEqual([['', [['vendor/sdk', ['vendor/sdk/ext']]]]])
  })
})

describe('RepoLayoutTree —— 渲染', () => {
  test('挂根成员显示「（任务根）」而不是空白', () => {
    render(<RepoLayoutTree repos={[repo('')]} />)
    // 空挂载路径直接渲染会是一个看不见的空 <code>，用户以为这行坏了。
    expect(screen.getByTestId('repo-layout-tree-row-.')).toBeTruthy()
    expect(screen.getByTestId('repo-layout-tree')).toBeTruthy()
  })

  test('只读成员带只读标记', () => {
    render(<RepoLayoutTree repos={[repo('vendor/sdk', { readonly: true })]} />)
    expect(screen.getByTestId('repo-layout-tree-readonly')).toBeTruthy()
  })

  test('空数组渲染一棵空树，**不**自造空态（RFC-214 Lock B）', () => {
    // 空态由**持有 query 的调用方**经 `QueryState.emptyText` 表达——本组件是
    // 纯投影，入参就是一个已加载好的数组，它没有「加载中 / 出错 / 为空」这三态
    // 的概念。自己写一个 `<p className="muted">` 会绕开设计系统的唯一原语。
    const { container } = render(<RepoLayoutTree repos={[]} />)
    expect(screen.getByTestId('repo-layout-tree')).toBeTruthy()
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(container.querySelector('.muted')).toBeNull()
  })

  test('testidPrefix 让同页多棵树可区分', () => {
    render(<RepoLayoutTree repos={[repo('a')]} testidPrefix="preview" />)
    expect(screen.getByTestId('preview')).toBeTruthy()
    expect(screen.getByTestId('preview-row-a')).toBeTruthy()
  })
})
