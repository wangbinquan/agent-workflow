import { createRoute, type SearchSchemaInput, type ValidatorFn } from '@tanstack/react-router'
import { TaskStatusSchema } from '@agent-workflow/shared'
import {
  OBSERVATION_TABS,
  RunObservability,
  type ObservationSearch,
  type ObservationTab,
} from '@/components/observability/RunObservability'
import { isObservationRange } from '@/components/observability/observationFormat'
import { Route as RootRoute } from './__root'

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : undefined

/** RFC-371 v2 §6 — every field is optional in the URL; invalid values fall back to defaults. */
export function validateObservationSearch(raw: Record<string, unknown>): ObservationSearch {
  const status = TaskStatusSchema.safeParse(raw.status)
  const task = text(raw.task, 200)
  const q = text(raw.q, 200)
  const kind = text(raw.kind, 100)
  return {
    range: isObservationRange(raw.range) ? raw.range : '7d',
    tab: OBSERVATION_TABS.includes(raw.tab as ObservationTab)
      ? (raw.tab as ObservationTab)
      : 'overview',
    ...(task === undefined ? {} : { task }),
    ...(q === undefined ? {} : { q }),
    ...(status.success ? { status: status.data } : {}),
    ...(kind === undefined ? {} : { kind }),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/observability',
  validateSearch: validateObservationSearch as ValidatorFn<
    Partial<ObservationSearch> & SearchSchemaInput,
    ObservationSearch
  >,
  component: Page,
})

function Page() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <RunObservability
      search={search}
      onChange={(next) =>
        void navigate({
          search: next,
          resetScroll: next.task !== search.task || next.tab !== search.tab,
        })
      }
    />
  )
}
