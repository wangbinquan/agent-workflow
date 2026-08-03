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
  disabled?: boolean
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
    <div className="operations-toolbar">
      <Segmented<V>
        value={props.view}
        onChange={props.onViewChange}
        ariaLabel={props.viewAria}
        disabled={props.disabled}
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
            disabled={props.disabled}
            inputRef={props.searchRef}
            data-testid={`${props.testidPrefix}-search`}
          />
        </span>
        <button
          ref={props.filterButtonRef}
          type="button"
          className="btn btn--sm operations-toolbar__filter"
          aria-label={props.filterLabel}
          disabled={props.disabled}
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
