// RFC-261 UI 修订 — FilterBar / FilterField 公共原语契约：
//   role=group + 可访问名（筛选栏整体可被读屏定位）、控件族与动作位分栏、
//   trailing 缺省不渲染动作容器（无激活筛选时不留空盒子）、
//   FilterField 的**可见**维度标签（选中后控件只显示值，标签是唯一的维度线索）。
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { FilterBar, FilterField } from '../src/components/FilterBar'

afterEach(cleanup)

describe('RFC-261 · FilterBar', () => {
  test('role=group + aria-label；控件渲染在 controls 分栏内', () => {
    render(
      <FilterBar ariaLabel="投递筛选" data-testid="fb">
        <FilterField label="事件">
          <button type="button">全部事件</button>
        </FilterField>
      </FilterBar>,
    )
    const group = screen.getByRole('group', { name: '投递筛选' })
    expect(group).toBeTruthy()
    expect(screen.getByTestId('fb')).toBe(group)
    const controls = group.querySelector('.filter-bar__controls')
    expect(controls).toBeTruthy()
    expect(controls!.contains(screen.getByRole('button', { name: '全部事件' }))).toBe(true)
  })

  test('trailing 有值时渲染动作位；缺省时连容器都不渲染', () => {
    const { rerender } = render(
      <FilterBar ariaLabel="筛选" trailing={<button type="button">清除筛选</button>}>
        <span>controls</span>
      </FilterBar>,
    )
    expect(screen.getByRole('button', { name: '清除筛选' })).toBeTruthy()
    expect(document.querySelector('.filter-bar__actions')).toBeTruthy()

    rerender(
      <FilterBar ariaLabel="筛选">
        <span>controls</span>
      </FilterBar>,
    )
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull()
    expect(document.querySelector('.filter-bar__actions')).toBeNull()
  })

  test('FilterField 渲染可见标签并把控件留在同一 field 内', () => {
    render(
      <FilterBar ariaLabel="筛选">
        <FilterField label="仓库">
          <button type="button">acme/api</button>
        </FilterField>
      </FilterBar>,
    )
    const label = screen.getByText('仓库')
    expect(label.className).toContain('filter-bar__label')
    const field = label.closest('.filter-bar__field')
    expect(field).toBeTruthy()
    expect(field!.contains(screen.getByRole('button', { name: 'acme/api' }))).toBe(true)
  })
})
