// RFC-312 —— `OperationsToolbar` 在加载期间**必须留在 tab 序里**。
//
// 为什么存在：CI run 32271235008（sha 084fedde）里 `e2e/ux-consistency.spec.ts:613`
// 间歇性红——`ux-consistency.spec.ts:170` 的
// `preceding.focus() → Tab → expect(tasks-filter-button).toBeFocused()` 落空
// （首跑 18.4s 红、重试 4.3s 绿，Playwright 归为 flaky）。根因不是测试写法：
// `routes/tasks.tsx` 当时给本组件传 `disabled={isLoading}`，而**被禁用的控件会离开
// tab 序**——`goto('/tasks')` 之后的加载窗口里按 Tab，焦点越过筛选按钮落到别处。
// 机器负载高时加载窗口变长，于是偶发。
//
// 这与 69b17787 修 Load more 按钮的是**同一类缺陷的第二个现场**：那次的结论就是
// 「加载态不该用 disabled 承载，它会吞点击、并把键盘焦点弹走」，当时只修了 tail
// 按钮，共享工具条漏下了。本次按同一定式改：**永不 disabled + `aria-busy`**。
// 三个控件在加载期间动作都安全（切视图＝改 URL、输入＝改草稿、开筛选＝开弹层），
// 没有需要靠禁用来挡的重复提交。
//
// 锁死四条不变量（第 4 条才是浏览器真正需要的那条）：
//   1. 加载中筛选按钮**不 disabled**；
//   2. 加载中搜索框**不 disabled**；
//   3. 加载中根容器带 `aria-busy`（加载态改由它承载）；
//   4. 加载中「搜索框 → Tab」的**下一个可聚焦控件就是筛选按钮**——即 e2e 那条断言
//      的单测等价物。用 tabbable 集合计算，不依赖 jsdom 的按键模拟。

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { OperationsToolbar } from '@/components/operations/OperationsToolbar'

function renderToolbar(busy: boolean) {
  return render(
    <OperationsToolbar<'all' | 'mine'>
      view="all"
      onViewChange={() => {}}
      views={[
        { value: 'all', label: 'All', count: 3 },
        { value: 'mine', label: 'Mine', count: 1 },
      ]}
      viewAria="Views"
      searchValue=""
      onSearchChange={() => {}}
      searchPlaceholder="Search"
      searchLabel="Search tasks"
      filterLabel="Filters"
      activeFilterCount={0}
      activeFiltersLabel={(count) => `${count} active`}
      onOpenFilters={() => {}}
      showClear={false}
      clearLabel="Clear"
      onClear={() => {}}
      testidPrefix="tasks"
      busy={busy}
    />,
  )
}

/** 文档序下可聚焦的元素——与浏览器 Tab 的推进顺序一致（本组件内无 tabindex 重排）。 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getAttribute('tabindex') !== '-1',
  )
}

describe('RFC-312 —— OperationsToolbar 加载态不得离开 tab 序', () => {
  it('加载中筛选按钮与搜索框都不 disabled', () => {
    renderToolbar(true)
    expect((screen.getByTestId('tasks-filter-button') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('tasks-search') as HTMLInputElement).disabled).toBe(false)
  })

  it('加载态由根容器的 aria-busy 承载，空闲时不留该属性', () => {
    const { container, unmount } = renderToolbar(true)
    expect(container.querySelector('.operations-toolbar')?.getAttribute('aria-busy')).toBe('true')
    unmount()

    const idle = renderToolbar(false)
    expect(idle.container.querySelector('.operations-toolbar')?.hasAttribute('aria-busy')).toBe(
      false,
    )
  })

  // 这条才是 e2e 真正需要的：搜索框之后紧邻的可聚焦控件必须是筛选按钮。
  // 一旦有人再给工具条加回 disabled（或在两者之间插入新的可聚焦元素），这里立刻红。
  it.each([true, false])('busy=%s 时搜索框的下一个可聚焦控件就是筛选按钮', (busy) => {
    const { container } = renderToolbar(busy)
    const order = tabbables(container)
    const searchIndex = order.indexOf(screen.getByTestId('tasks-search'))
    expect(searchIndex).toBeGreaterThanOrEqual(0)
    expect(order[searchIndex + 1]).toBe(screen.getByTestId('tasks-filter-button'))
  })
})
