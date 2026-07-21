// RFC-214 — shared query three-state gate. Composes LoadingState / ErrorBanner
// / EmptyState so a "one query → one list/detail" render point expresses
//   loading → error(+retry) → empty → data
// in ONE place instead of hand-wiring the cascade at every call site
// (audit: design/frontend-primitive-audit-2026-07-21.md §2 P0, 41 confirmed).

import type { ReactElement, ReactNode } from 'react'
import { ErrorBanner } from './ErrorBanner'
import { LoadingState, type LoadingStateSize } from './LoadingState'

/** The subset of a TanStack Query result QueryState reads. Kept minimal so
 *  hand-built objects (and tests) can satisfy it without the full type. */
export interface QueryLike {
  isPending?: boolean
  isLoading?: boolean
  error?: unknown
  refetch?: () => unknown
}

export interface QueryStateProps<T> {
  query: QueryLike
  /** The (possibly derived/filtered) value — decides empty + children input.
   *  Pass `running` not `query.data` when the empty state is derived. */
  data: T
  /** Default: empty array → empty; else null/undefined → empty. */
  isEmpty?: (data: T) => boolean
  /** Rendered only when not loading / not errored / not empty. */
  children: (data: T) => ReactNode

  // loading
  loadingLabel?: string
  loadingSize?: LoadingStateSize

  // error
  errorMessage?: string
  errorOverrides?: Record<string, string>
  retryLabel?: string
  /** Default: () => void query.refetch(). */
  onRetry?: () => void

  // empty — two weights; default lightweight
  /** Lightweight: <div className="muted">{emptyText}</div>. */
  emptyText?: string
  /** Heavyweight: caller supplies <EmptyState …/>. Wins over emptyText. */
  empty?: ReactNode

  /** BLOCKER-1: when true, an error WITH non-empty cached data overlays the
   *  ErrorBanner ON TOP of children(data) instead of short-circuiting —
   *  the memory panels' "a refetch failure keeps cached rows" contract. */
  keepDataOnError?: boolean

  testid?: string
}

function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0
  return data === null || data === undefined
}

export function QueryState<T>(props: QueryStateProps<T>): ReactElement | null {
  const { query, data, children } = props
  const isEmptyFn = props.isEmpty ?? (defaultIsEmpty as (d: T) => boolean)

  // MAJOR-4: isLoading first. A disabled query (enabled:false) is
  // status='pending' + fetchStatus='idle' → isPending===true but
  // isLoading===false; isPending-first would spin it forever.
  const loading = query.isLoading ?? query.isPending ?? false
  if (loading) {
    return (
      <LoadingState
        label={props.loadingLabel}
        size={props.loadingSize}
        data-testid={props.testid}
      />
    )
  }

  const errored = query.error !== null && query.error !== undefined
  if (errored) {
    const onRetry =
      props.onRetry ??
      (query.refetch !== undefined
        ? () => {
            void query.refetch?.()
          }
        : undefined)
    const banner = (
      <ErrorBanner
        error={query.error}
        message={props.errorMessage}
        overrides={props.errorOverrides}
        onRetry={onRetry}
        retryLabel={props.retryLabel}
        testid={props.testid}
      />
    )
    if (props.keepDataOnError === true && !isEmptyFn(data)) {
      return (
        <>
          {banner}
          {children(data)}
        </>
      )
    }
    return banner
  }

  if (isEmptyFn(data)) {
    if (props.empty !== undefined) return <>{props.empty}</>
    if (props.emptyText !== undefined) return <div className="muted">{props.emptyText}</div>
    return null
  }

  return <>{children(data)}</>
}
