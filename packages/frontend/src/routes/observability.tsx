import { createRoute } from '@tanstack/react-router'
import { TaskStatusSchema } from '@agent-workflow/shared'
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
  const status = TaskStatusSchema.safeParse(raw.status)
  const text = (key: string, max: number) =>
    typeof raw[key] === 'string' && raw[key].trim() && raw[key].length <= max ? raw[key] : undefined
  const q = text('q', 200),
    repository = text('repository', 4096),
    workflow = text('workflow', 200),
    runtime = text('runtime', 2048)
  return {
    ...(q === undefined ? {} : { q }),
    ...(repository === undefined ? {} : { repository }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(status.success ? { status: status.data } : {}),
    from,
    to,
    period:
      raw.period === 'all' || raw.period === 'month' || raw.period === 'custom'
        ? raw.period
        : 'week',
    tab:
      raw.tab === 'tasks' ||
      raw.tab === 'agents' ||
      raw.tab === 'usage' ||
      raw.tab === 'performance'
        ? raw.tab
        : 'overview',
    ...(typeof raw.after === 'string' && raw.after ? { after: raw.after } : {}),
    ...(typeof raw.task === 'string' && raw.task ? { task: raw.task } : {}),
    ...(typeof raw.agent === 'string' && raw.agent ? { agent: raw.agent } : {}),
    ...(typeof raw.quality === 'string' && raw.quality ? { quality: raw.quality } : {}),
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
      onChange={(next) => {
        const openingTask = !search.task && !!next.task
        const returningFromTask = !!search.task && !next.task
        const sameScope =
          search.from === next.from &&
          search.to === next.to &&
          search.tab === next.tab &&
          search.q === next.q &&
          search.status === next.status &&
          search.repository === next.repository &&
          search.workflow === next.workflow &&
          search.after === next.after
        void navigate({
          search: next,
          resetScroll: openingTask || (!returningFromTask && !sameScope),
        })
      }}
    />
  )
}
