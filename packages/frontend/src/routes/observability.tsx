import { createRoute } from '@tanstack/react-router'
import {
  RunObservability,
  type ObservationSearch,
} from '@/components/observability/RunObservability'
import { Route as RootRoute } from './__root'

export function validateObservationSearch(raw: Record<string, unknown>): ObservationSearch {
  const fallbackTo = Date.now() + 1
  const to =
    typeof raw.to === 'number' && Number.isSafeInteger(raw.to) && raw.to > 0 ? raw.to : fallbackTo
  const from =
    typeof raw.from === 'number' && Number.isSafeInteger(raw.from) && raw.from >= 0 && raw.from < to
      ? raw.from
      : Math.max(0, to - 7 * 86400000)
  return {
    from,
    to,
    period: raw.period === 'all' || raw.period === 'month' ? raw.period : 'week',
    ...(typeof raw.after === 'string' && raw.after ? { after: raw.after } : {}),
    ...(typeof raw.task === 'string' && raw.task ? { task: raw.task } : {}),
  }
}
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/observability',
  validateSearch: validateObservationSearch,
  component: Page,
})
function Page() {
  const search = Route.useSearch(),
    navigate = Route.useNavigate()
  return (
    <RunObservability
      search={search}
      onChange={(search) => {
        void navigate({ search })
      }}
    />
  )
}
