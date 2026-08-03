// RFC-248 T35 —— `RepoLayoutTree` 的树投影。
//
// 核心是 `buildLayoutTree`：以服务端返回的显式目录节点为骨架，再用
// `PlannedRepo[]` 装饰同路径节点。两条容易写错、且错了会静默的规则：
//
//   1. **段边界**。`vendor/sdk` 是 `vendor/sdk/ext` 的父，但**不是**
//      `vendor/sdkx` 的父——裸 `startsWith` 会把后者也吞进来，用户看到一棵
//      结构错误的树（而且不报错）。
//   2. **最长祖先才是父**。`''`（挂根）、`vendor`、`vendor/sdk` 三者都可能是
//      `vendor/sdk/ext` 的祖先，父节点必须取最长的那个，否则三层布局会被压成
//      两层。

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { PlannedDirectoryNode, PlannedRepo } from '@agent-workflow/shared'
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
  return nodes.map((n) => (n.children.length === 0 ? n.path : [n.path, shape(n.children)]))
}

const node = (path: string): PlannedDirectoryNode => ({ path, origins: [] })

function nodesFor(repos: readonly PlannedRepo[]): PlannedDirectoryNode[] {
  const paths = new Map<string, string>()
  for (const item of repos) {
    paths.set('', '')
    let path = ''
    for (const segment of item.mountPath.split('/').filter(Boolean)) {
      path = path === '' ? segment : `${path}/${segment}`
      if (!paths.has(path.toLowerCase())) paths.set(path.toLowerCase(), path)
    }
  }
  return [...paths.values()].map(node)
}

function layout(repos: readonly PlannedRepo[]) {
  return buildLayoutTree(nodesFor(repos), repos)
}

describe('buildLayoutTree —— 挂载路径的父子投影', () => {
  test('挂根成员是所有人的父', () => {
    expect(shape(layout([repo(''), repo('vendor/sdk'), repo('tools')]))).toEqual([
      ['', ['tools', ['vendor', ['vendor/sdk']]]],
    ])
  })

  test('三层嵌套：父取**最长**祖先，不被压层', () => {
    const tree = layout([repo(''), repo('vendor'), repo('vendor/sdk'), repo('vendor/sdk/ext')])
    expect(shape(tree)).toEqual([['', [['vendor', [['vendor/sdk', ['vendor/sdk/ext']]]]]]])
  })

  test('段边界：`vendor/sdkx` 不是 `vendor/sdk` 的孩子', () => {
    const tree = layout([repo('vendor/sdk'), repo('vendor/sdkx')])
    // 显式目录闭包补出共同的 vendor 父；两仓仍是兄弟，不能互相吞并。
    expect(shape(tree)).toEqual([['', [['vendor', ['vendor/sdk', 'vendor/sdkx']]]]])
  })

  test('没有挂根成员时，多个顶层挂载点并列', () => {
    expect(shape(layout([repo('frontend'), repo('backend')]))).toEqual([
      ['', ['backend', 'frontend']],
    ])
  })

  test('大小写不敏感的嵌套（macOS）：`Vendor` 是 `vendor/sdk` 的父', () => {
    // 服务端的排除计划用的是**折叠**比较（`isUnder`），树这边如果区分大小写就
    // 会把实际嵌套的两个仓画成兄弟——用户看到的结构与真正物化出来的不一样。
    expect(shape(layout([repo('Vendor'), repo('vendor/sdk')]))).toEqual([
      ['', [['Vendor', ['vendor/sdk']]]],
    ])
  })

  test('挂根成员深度为 0：即便排在一段挂载点之后也仍是父', () => {
    // 自写 `''.split('/').length` 会算成 1，与一段挂载点同深 ⇒ `tools` 先被
    // 处理时挂根成员就当不成它的父了。
    expect(shape(layout([repo('tools'), repo('')]))).toEqual([['', ['tools']]])
  })

  test('输入顺序不影响结果（深度排序在内部完成）', () => {
    const deep = layout([repo('vendor/sdk/ext'), repo(''), repo('vendor/sdk')])
    expect(shape(deep)).toEqual([['', [['vendor', [['vendor/sdk', ['vendor/sdk/ext']]]]]]])
  })

  test('RFC-249：没有仓挂载的纯目录也保留在树中', () => {
    const tree = buildLayoutTree(
      [node(''), node('apps'), node('apps/web'), node('docs'), node('docs/adr')],
      [repo('apps/web')],
    )
    expect(shape(tree)).toEqual([
      [
        '',
        [
          ['apps', ['apps/web']],
          ['docs', ['docs/adr']],
        ],
      ],
    ])
    expect(tree[0]?.children.find((child) => child.path === 'docs')?.repo).toBeNull()
  })
})

describe('RepoLayoutTree —— 渲染', () => {
  test('挂根成员显示「（任务根）」而不是空白', () => {
    const repos = [repo('')]
    render(<RepoLayoutTree nodes={nodesFor(repos)} repos={repos} />)
    // 空挂载路径直接渲染会是一个看不见的空 <code>，用户以为这行坏了。
    expect(screen.getByTestId('repo-layout-tree-row-.')).toBeTruthy()
    expect(screen.getByTestId('repo-layout-tree')).toBeTruthy()
  })

  test('只读成员带只读标记', () => {
    const repos = [repo('vendor/sdk', { readonly: true })]
    render(<RepoLayoutTree nodes={nodesFor(repos)} repos={repos} />)
    expect(screen.getByTestId('repo-layout-tree-readonly')).toBeTruthy()
  })

  test('空数组渲染一棵空树，**不**自造空态（RFC-214 Lock B）', () => {
    // 空态由**持有 query 的调用方**经 `QueryState.emptyText` 表达——本组件是
    // 纯投影，入参就是一个已加载好的数组，它没有「加载中 / 出错 / 为空」这三态
    // 的概念。自己写一个 `<p className="muted">` 会绕开设计系统的唯一原语。
    const { container } = render(<RepoLayoutTree nodes={[]} repos={[]} />)
    expect(screen.getByTestId('repo-layout-tree')).toBeTruthy()
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(container.querySelector('.muted')).toBeNull()
  })

  test('testidPrefix 让同页多棵树可区分', () => {
    const repos = [repo('a')]
    render(<RepoLayoutTree nodes={nodesFor(repos)} repos={repos} testidPrefix="preview" />)
    expect(screen.getByTestId('preview')).toBeTruthy()
    expect(screen.getByTestId('preview-row-a')).toBeTruthy()
  })
})
