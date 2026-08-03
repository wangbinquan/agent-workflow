// RFC-248 T37/T44 —— 仓库组管理界面的行为锁 + 设计系统兜底断言。
//
// 两类断言：
//
//  1. **行为**：`/repos` 的分段在两个视图间切换、组列表把展平仓数与绑定记忆数
//     显示出来、编辑 / 删除按钮把 id 传出去。
//  2. **源代码层兜底**（CLAUDE.md 强制条款的机器化）：新界面不得自造 modal
//     chrome / 表单原语 / 原生 `<select>` / 自写空态。这类回归在运行时看起来
//     「能用」，只有对着源码才查得出来——所以留一条文本断言。

import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RepoGroup } from '@agent-workflow/shared'
import { RepoGroupsPane } from '@/components/repos/RepoGroupsPane'

const EDITOR_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'repos', 'RepoGroupEditor.tsx'),
  'utf8',
)
const PANE_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'repos', 'RepoGroupsPane.tsx'),
  'utf8',
)
const TREE_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'repos', 'RepoLayoutTree.tsx'),
  'utf8',
)
const REPOS_SRC = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'repos.tsx'), 'utf8')

/**
 * 剥掉 `//` 行注释后再做「不得出现某个原生标签」的匹配。
 *
 * 不剥的话，文件头那句「**不用**原生 `<select>`」自己就会把守卫打红——一条
 * 因为**解释了规则**而失败的守卫，只会教人把注释删掉，而不是把代码改对。
 */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

function group(over: Partial<RepoGroup> = {}): RepoGroup {
  return {
    id: 'g1',
    name: '全栈',
    description: '前后端一起跑',
    version: 1,
    createdByUserId: null,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    nodes: [{ path: '', attachment: null }],
    members: [],
    flatRepoCount: 3,
    boundMemories: 2,
    ...over,
  }
}

function renderPane(props: Partial<Parameters<typeof RepoGroupsPane>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list = {
    data: { items: [group()] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as Parameters<typeof RepoGroupsPane>[0]['list']
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <RepoGroupsPane
        list={list}
        onEdit={onEdit}
        onDelete={onDelete}
        deleteError={null}
        newAction={<button type="button">new</button>}
        search=""
        onSearchChange={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  )
  return { onEdit, onDelete }
}

describe('RepoGroupsPane —— 列表行为', () => {
  test('显示名称、展平仓数与绑定记忆数', () => {
    renderPane()
    const row = screen.getByTestId('repo-group-row-g1')
    expect(row.textContent).toContain('全栈')
    // 展平仓数是「这个组实际会物化几个仓」——组套组后与成员数不是一回事，
    // 列表里必须显示展平后的那个数。
    expect(row.textContent).toContain('3')
    // 绑定记忆数是删组确认弹窗要用的信息（设计门 G5）。
    expect(row.textContent).toContain('2')
  })

  test('编辑 / 删除把这一行的组传出去', () => {
    const { onEdit, onDelete } = renderPane()
    fireEvent.click(screen.getByTestId('repo-group-edit-g1'))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }))
    fireEvent.click(screen.getByTestId('repo-group-delete-g1'))
    // RFC-248: 删除回调传的是**整个组**（确认弹窗要显示组名与绑定记忆数）。
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }))
  })

  test('展开目录树复用任务列表按钮，并暴露可访问的展开状态', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ nodes: [{ path: '', origins: [] }], repos: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    try {
      renderPane()
      const button = screen.getByTestId('repo-group-expand-g1')
      expect(button.classList.contains('task-operations__expand-button')).toBe(true)
      expect(button.getAttribute('aria-expanded')).toBe('false')

      fireEvent.click(button)
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeNull()
      expect(await screen.findByTestId('repo-group-layout-g1')).not.toBeNull()
      expect(PANE_SRC).toContain("from '@/components/operations/OperationsExpandButton'")
    } finally {
      fetchMock.mockRestore()
    }
  })

  test('搜索过滤名称与描述（大小写不敏感）', () => {
    renderPane({
      list: {
        data: { items: [group(), group({ id: 'g2', name: 'infra', description: '' })] },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as Parameters<typeof RepoGroupsPane>[0]['list'],
      search: 'INFRA',
    })
    expect(screen.queryByTestId('repo-group-row-g1')).toBeNull()
    expect(screen.getByTestId('repo-group-row-g2')).toBeTruthy()
  })

  test('搜不到 ⇒ noMatches 空态（给清空搜索，不是给新建）', () => {
    renderPane({ search: 'zzz' })
    expect(screen.getByTestId('repo-groups-no-matches')).toBeTruthy()
    expect(screen.queryByTestId('repo-groups-empty')).toBeNull()
  })

  test('空列表走 EmptyState 并带上新建入口', () => {
    renderPane({
      list: {
        data: { items: [] },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as Parameters<typeof RepoGroupsPane>[0]['list'],
    })
    expect(screen.getByTestId('repo-groups-empty')).toBeTruthy()
  })
})

describe('RFC-249 —— 紧凑目录树编辑主路径', () => {
  test('写接口只发送显式 nodes，root 是普通节点而非主仓', () => {
    expect(EDITOR_SRC).toContain("return [{ path: '', attachment: null }]")
    expect(EDITOR_SRC).toContain('const body = { name, description, nodes }')
    expect(EDITOR_SRC).toContain('{ nodes: debouncedNodes }')
    expect(codeOnly(EDITOR_SRC)).not.toContain('members: wire')
  })

  test('平铺大量仓库有批量选择与批量 URL 两条快速入口', () => {
    expect(EDITOR_SRC).toContain('repo-group-bulk-repos')
    expect(EDITOR_SRC).toContain('repo-group-paste-urls')
    expect(EDITOR_SRC).toContain('allocateRepoNodePath')
    expect(EDITOR_SRC).toContain('bulkRepoIds')
    expect(EDITOR_SRC).toContain('repo-group-select-all-attachments')
    expect(EDITOR_SRC).toContain('selectVisibleRepos')
    expect(EDITOR_SRC).toContain('parseGitUrl')
    expect(EDITOR_SRC).toContain('repo-group-paste-errors')
  })

  test('多选节点支持只读、可写、摘挂载、移动与删除', () => {
    for (const operation of ['readonly', 'writable', 'detach', 'move']) {
      expect(EDITOR_SRC).toContain(`applyBatch('${operation}')`)
    }
    expect(EDITOR_SRC).toContain('requestDelete([...checked])')
    expect(EDITOR_SRC).toContain('repo-group-batch-bar')
  })

  test('删除子树先显示节点与挂载影响数，再原子删除', () => {
    expect(EDITOR_SRC).toContain("from '@/components/ConfirmDialog'")
    expect(EDITOR_SRC).toContain('<ConfirmDialog')
    expect(EDITOR_SRC).toContain('attachmentCount')
    expect(EDITOR_SRC).toContain('deleteSubtrees(deleteIntent.paths)')
  })

  test('桌面拖放与键盘可达的上级目录选择共用 moveNodeSubtree', () => {
    expect(EDITOR_SRC).toContain('onDragStart')
    expect(EDITOR_SRC).toContain('onDrop')
    expect(EDITOR_SRC.match(/moveNodeSubtree/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(EDITOR_SRC).toContain("t('repoGroups.editor.parentDirectory')")
  })
})

describe('RFC-248 设计系统兜底（源代码层）', () => {
  test('编辑器走 <Dialog>，不自造 overlay / panel chrome', () => {
    expect(EDITOR_SRC).toContain("from '@/components/Dialog'")
    expect(EDITOR_SRC).not.toMatch(/className="[^"]*__overlay/)
    expect(EDITOR_SRC).not.toMatch(/className="[^"]*__panel/)
  })

  test('编辑器的下拉走 <Select>，绝不落原生 <select>', () => {
    // 原生弹层无法与周围 UI 风格对齐（CLAUDE.md 点名禁止）。
    expect(EDITOR_SRC).toContain("from '@/components/Select'")
    expect(codeOnly(EDITOR_SRC)).not.toMatch(/<select[\s>]/)
  })

  test('编辑器的表单字段走 Form 原语，不落裸 <input>', () => {
    expect(EDITOR_SRC).toContain("from '@/components/Form'")
    expect(codeOnly(EDITOR_SRC)).not.toMatch(/<input[\s>]/)
  })

  test('三个新组件都不自写错误 / 空 / 加载态', () => {
    for (const src of [EDITOR_SRC, PANE_SRC, TREE_SRC]) {
      expect(codeOnly(src)).not.toMatch(/className="error-box"/)
      expect(codeOnly(src)).not.toMatch(/<div className="muted">\s*\{t\(/)
    }
    // 空态与加载态经共享原语表达；编辑器的校验失败走 ErrorBanner。
    expect(PANE_SRC).toContain('EmptyState')
    expect(PANE_SRC).toContain('LoadingState')
    expect(EDITOR_SRC).toContain('ErrorBanner')
  })

  test('只读布局树由组列表与任务详情共用；编辑器不再重复画预览树', () => {
    expect(PANE_SRC).toContain("from '@/components/repos/RepoLayoutTree'")
    expect(EDITOR_SRC).not.toContain("from '@/components/repos/RepoLayoutTree'")
    expect(EDITOR_SRC).toContain('repo-group-editor__workspace')
  })

  test('/repos 的资源视图走标准下划线 <TabBar>，不再做成表单分段按钮', () => {
    expect(REPOS_SRC).toContain("from '@/components/TabBar'")
    expect(REPOS_SRC).toContain('rootTestid="repos-tab"')
    expect(REPOS_SRC).toContain('idPrefix="repos-resource"')
    expect(REPOS_SRC).toContain("tabDomIds('repos-resource', 'repos')")
    expect(REPOS_SRC).toContain('className="repo-kind-tabs"')
    expect(codeOnly(REPOS_SRC)).not.toMatch(/type="radio"/)
  })
})
