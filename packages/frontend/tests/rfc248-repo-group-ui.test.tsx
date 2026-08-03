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

describe('RFC-248 —— 编辑器：未填完的行不是错误（真实使用中发现）', () => {
  // 症状：点一下「+ 添加仓库」、还没选仓，右侧预览区立刻弹红框
  // 「members.0.cachedRepoId: exactly one of cachedRepoId / repoUrl is required」。
  // 成因：整份成员表被 debounce 后原样发去干跑预览，服务端的 XOR 校验判它非法。
  // 但「一行还没填完」根本不是错误——用户什么都还没做错。
  //
  // 修法：未填完的行**不参与预览**（与服务端对「只给 URL」的行同样思路），
  // 并且挡住保存（这个条件前端完全判得出来，不该推给服务端回 422）。

  test('预览请求里剔除未填完的行', () => {
    // 送去预览的是 `previewWire`（已过滤），不是原始 `wire`。
    expect(EDITOR_SRC).toContain('const previewWire')
    expect(EDITOR_SRC).toContain('wire.filter((m) => !isIncomplete(m))')
    expect(EDITOR_SRC).toContain('setDebounced(previewWire)')
    // 且**不能**再把未过滤的 wire 直接塞进 debounce。
    expect(codeOnly(EDITOR_SRC)).not.toMatch(/setDebounced\(wire\)/)
  })

  test('「未填完」的判据对仓与组两种成员都成立', () => {
    // 组成员看 childGroupId，仓成员看 cachedRepoId ⊕ repoUrl 是否都空。
    expect(EDITOR_SRC).toContain("m.childGroupId === ''")
    expect(EDITOR_SRC).toContain("(m.cachedRepoId ?? '') === '' && (m.repoUrl ?? '') === ''")
  })

  test('有未填完的行时保存被挡住', () => {
    expect(EDITOR_SRC).toContain('incompleteCount === 0')
  })

  test('未填完用中性 chip 提示，不是 ErrorBanner', () => {
    expect(EDITOR_SRC).toContain('repo-group-preview-incomplete')
    const at = EDITOR_SRC.indexOf('repo-group-preview-incomplete')
    // 提示挂在 StatusChip 上（中性），附近不该是错误横幅。
    expect(EDITOR_SRC.slice(at - 200, at)).toContain('StatusChip')
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
    // 空态与加载态经共享原语表达。
    expect(PANE_SRC).toContain('EmptyState')
    expect(PANE_SRC).toContain('LoadingState')
    expect(EDITOR_SRC).toContain('QueryState')
  })

  test('布局树是三处共用的**同一个**组件，不是各画一棵', () => {
    // 编辑器预览、组列表展开行、任务详情都 import 它——任何一处 fork 都会让
    // 三个界面的树慢慢长歪。
    expect(EDITOR_SRC).toContain("from '@/components/repos/RepoLayoutTree'")
    expect(PANE_SRC).toContain("from '@/components/repos/RepoLayoutTree'")
  })

  test('/repos 的视图切换走 <Segmented>，不自写 radio 组', () => {
    expect(REPOS_SRC).toContain("from '@/components/Segmented'")
    expect(REPOS_SRC).toContain('testidPrefix="repos-tab"')
    expect(codeOnly(REPOS_SRC)).not.toMatch(/type="radio"/)
  })
})
