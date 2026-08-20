// RFC-246 — shared high-density operations toolbar used by Tasks, Scheduled,
// and Cached Repos. Business filters stay in each route; this component owns
// the common view/search/filter/clear interaction and visual contract.

import type { ReactNode, RefObject } from 'react'

import { TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'

export { OperationsChevronIcon } from './OperationsExpandButton'

export interface OperationsViewOption<V extends string> {
  value: V
  label: ReactNode
  count: number
  testid?: string
}

interface OperationsToolbarProps<V extends string> {
  view: V
  onViewChange: (view: V) => void
  views: ReadonlyArray<OperationsViewOption<V>>
  viewAria: string
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchLabel: string
  filterLabel: string
  activeFilterCount: number
  activeFiltersLabel: (count: number) => string
  onOpenFilters: () => void
  showClear: boolean
  clearLabel: string
  onClear: () => void
  testidPrefix: string
  /**
   * 列表正在加载。**只置 `aria-busy`，绝不 `disabled`**（RFC-312 e2e 实撞）：
   * 被禁用的控件会**离开 tab 序**，于是「搜索框 → Tab → 筛选按钮」在加载窗口里
   * 落到别处，键盘用户的焦点被凭空弹走。这与 69b17787 修 Load more 按钮的是同一
   * 类缺陷（那次症状是 webkit e2e 活锁），此处是它的第二个现场。
   * 本工具条的三个控件在加载期间动作都是安全的（切视图＝改 URL、输入＝改草稿、
   * 开筛选＝开弹层），没有需要靠禁用来挡的重复提交，故直接保持可用。
   */
  busy?: boolean
  searchRef?: RefObject<HTMLInputElement | null>
  filterButtonRef?: RefObject<HTMLButtonElement | null>
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  )
}

export function OperationsToolbar<V extends string>(props: OperationsToolbarProps<V>) {
  return (
    <div className="operations-toolbar" aria-busy={props.busy === true ? true : undefined}>
      <Segmented<V>
        className="list-view-switch"
        value={props.view}
        onChange={props.onViewChange}
        ariaLabel={props.viewAria}
        rootTestid={`${props.testidPrefix}-views`}
        options={props.views.map((view) => ({
          value: view.value,
          testid: view.testid ?? `${props.testidPrefix}-view-${view.value}`,
          label: (
            <span className="operations-toolbar__view-label">
              <span>{view.label}</span>
              <span className="operations-toolbar__count" aria-hidden="true">
                {view.count}
              </span>
            </span>
          ),
        }))}
      />
      <div className="operations-toolbar__actions">
        <span className="operations-toolbar__search-wrap">
          <SearchIcon />
          <TextInput
            type="search"
            value={props.searchValue}
            onChange={props.onSearchChange}
            maxLength={100}
            placeholder={props.searchPlaceholder}
            aria-label={props.searchLabel}
            className="operations-toolbar__search"
            inputRef={props.searchRef}
            data-testid={`${props.testidPrefix}-search`}
          />
        </span>
        <button
          ref={props.filterButtonRef}
          type="button"
          className="btn btn--sm operations-toolbar__filter"
          aria-label={props.filterLabel}
          onClick={props.onOpenFilters}
          data-testid={`${props.testidPrefix}-filter-button`}
        >
          <FilterIcon />
          <span className="operations-toolbar__filter-label">{props.filterLabel}</span>
          {props.activeFilterCount > 0 && (
            <span
              className="chip chip--tight"
              aria-label={props.activeFiltersLabel(props.activeFilterCount)}
            >
              {props.activeFilterCount}
            </span>
          )}
        </button>
        {props.showClear && (
          <button
            type="button"
            className="btn btn--sm operations-toolbar__clear"
            onClick={props.onClear}
          >
            {props.clearLabel}
          </button>
        )}
      </div>
    </div>
  )
}
