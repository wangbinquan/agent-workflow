import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'
import {
  CompleteObservationReportQuerySchema,
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  completeObservationReportContent,
  type CompleteObservationReport,
  type CompleteObservationReportPage,
  type CompleteObservationSection,
  type CompleteObservationReportContent,
  type ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { api } from '@/api/client'

export type ReadableObservationReport = CompleteObservationReportContent
export type ReadyObservationReport = Extract<CompleteObservationReport, { state: 'ready' }>
export function useCompleteObservationReport(
  filters: ObservationOverviewQuery,
  taskId: string | undefined,
  revision: number,
  enabled: boolean,
) {
  const client = useQueryClient()
  const scope = JSON.stringify(['scope-metrics/11', filters, taskId ?? null, revision])
  const refreshKey = useMemo(() => ({ scope, key: crypto.randomUUID() }), [scope]).key
  const key = [
    'run-observability-complete',
    'scope-metrics/11',
    filters,
    taskId ?? null,
    revision,
  ] as const
  const retainedIds = useRef(new Map<string, string>())
  return useQuery({
    queryKey: key,
    enabled,
    retry: false,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<CompleteObservationReport>(key)
      const id =
        (previous?.state === 'ready' ? previous.header.reportId : previous?.reportId) ??
        retainedIds.current.get(scope)
      const report = id
        ? await api.get<CompleteObservationReport>(
            '/api/observability/reports/' + encodeURIComponent(id),
            undefined,
            signal,
          )
        : await api.post<CompleteObservationReport>(
            '/api/observability/reports',
            { filters, refreshKey, ...(taskId ? { taskId } : {}) },
            signal,
          )
      const content = completeObservationReportContent(report)
      if (
        content &&
        (content.header.reportId !==
          (report.state === 'ready' ? report.header.reportId : report.reportId) ||
          content.header.taskId !== (taskId ?? null) ||
          JSON.stringify(CompleteObservationReportQuerySchema.parse(content.header.filters)) !==
            JSON.stringify(CompleteObservationReportQuerySchema.parse(filters)))
      )
        throw new Error('Complete report scope changed')
      retainedIds.current.set(
        scope,
        report.state === 'ready' ? report.header.reportId : report.reportId,
      )
      return report
    },
    refetchInterval: (query) => (query.state.data?.state === 'building' ? 2000 : false),
  })
}

/** One display page is retained at a time; the server's sealed count covers the entire population. */
export function useCompleteObservationPage<T>(
  report: ReadableObservationReport | null,
  section: CompleteObservationSection,
  parent: string | null = null,
  enabled = true,
  expectedTotal?: string,
) {
  const client = useQueryClient()
  const scope = JSON.stringify([report?.header.reportId, section, parent])
  const bookmark = ['run-observability-complete-position', scope] as const
  const position = useQuery<readonly (string | null)[]>({
    queryKey: bookmark,
    queryFn: async () => [null],
    initialData: [null],
    enabled: false,
    gcTime: Infinity,
  })
  const cursors = position.data ?? [null]
  const setPosition = (value: readonly (string | null)[]) => client.setQueryData(bookmark, value)
  const after = cursors.at(-1) ?? null
  const query = useQuery({
    queryKey: ['run-observability-complete-page', report?.header.reportId, section, parent, after],
    enabled:
      !!report &&
      enabled &&
      (report.summary.metrics.state !== 'not-ready' ||
        COMPLETE_OBSERVATION_FACT_SECTIONS.includes(section)),
    retry: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      if (!report) throw new Error('Complete report not ready')
      try {
        const page = await api.get<CompleteObservationReportPage<T>>(
          '/api/observability/reports/' + encodeURIComponent(report.header.reportId) + '/pages',
          {
            section,
            limit: 100,
            ...(parent === null ? {} : { parent }),
            ...(after === null ? {} : { after }),
          },
          signal,
        )
        if (
          page.reportId !== report.header.reportId ||
          page.section !== section ||
          page.parent !== parent ||
          (expectedTotal !== undefined && page.total !== expectedTotal) ||
          (parent === null && page.total !== (report.counts[section] ?? '0')) ||
          (page.nextCursor !== null && (page.nextCursor === after || page.items.length === 0))
        )
          throw new Error('Complete retained page identity or count changed')
        return page
      } catch (error) {
        if (!signal.aborted) {
          const matches = (query: {
            readonly queryKey: readonly unknown[]
            readonly state: { readonly data: unknown }
          }) => {
            if (query.queryKey[0] !== 'run-observability-complete') return false
            const value = query.state.data as CompleteObservationReport | undefined
            return (
              !!value &&
              completeObservationReportContent(value)?.header.reportId === report.header.reportId
            )
          }
          // A failed detail read must not leave the previous numeric summary visible.
          client.setQueriesData<CompleteObservationReport>(
            { predicate: matches },
            {
              state: 'not-ready',
              reportId: report.header.reportId,
              gaps: ['retained-report-page-unverified'],
            },
          )
          await client.invalidateQueries({ queryKey: ['run-observability-complete'] })
        }
        throw error
      }
    },
  })
  return {
    ...query,
    page: cursors.length,
    first: () => setPosition([null]),
    previous: () => setPosition(cursors.length > 1 ? cursors.slice(0, -1) : [null]),
    next: () => {
      if (query.data?.nextCursor) setPosition([...cursors, query.data.nextCursor])
    },
  }
}
