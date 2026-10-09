import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { api, ApiError } from '@/api/client'
import {
  discardObservationReportBookmark,
  observationReportBookmark,
  observationReportWasRejected,
} from './completeReportBookmark'

export type ReadableObservationReport = CompleteObservationReportContent
export type ReadyObservationReport = Extract<CompleteObservationReport, { state: 'ready' }>
const displayValidityKey = (reportId: string | null) =>
  ['run-observability-complete-display-valid', reportId] as const
function checkedReportContent(
  report: CompleteObservationReport,
  filters: ObservationOverviewQuery,
  taskId: string | undefined,
  requestedId?: string,
) {
  const id = report.state === 'ready' ? report.header.reportId : report.reportId
  const content = completeObservationReportContent(report)
  if (requestedId !== undefined && requestedId !== id)
    throw new Error('Complete report identity changed')
  if (content && filters.cohort === 'usage' && taskId === undefined && !content.summary.usageWindow)
    throw new Error('Consumption window evidence is missing')
  if (
    content &&
    (content.header.reportId !== id ||
      content.header.taskId !== (taskId ?? null) ||
      JSON.stringify(CompleteObservationReportQuerySchema.parse(content.header.filters)) !==
        JSON.stringify(CompleteObservationReportQuerySchema.parse(filters)))
  )
    throw new Error('Complete report scope changed')
  if (content && observationReportWasRejected(id))
    throw new Error('Complete report was invalidated')
  return content
}
export function useCompleteObservationReport(
  filters: ObservationOverviewQuery,
  taskId: string | undefined,
  revision: number,
  enabled: boolean,
) {
  const client = useQueryClient()
  const scope = JSON.stringify(['scope-metrics/13', filters, taskId ?? null, revision])
  const refreshKey = useMemo(() => ({ scope, key: crypto.randomUUID() }), [scope]).key
  const key = [
    'run-observability-complete',
    'scope-metrics/13',
    filters,
    taskId ?? null,
    revision,
  ] as const
  const retainedIds = useRef(new Map<string, string>())
  const [previous, setPrevious] = useState<{
    scope: string
    content: ReadableObservationReport
  } | null>(null)
  const displayScope = JSON.stringify(['scope-metrics/13', filters, taskId ?? null])
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const cached = client.getQueryData<CompleteObservationReport>(key)
      const id =
        (cached?.state === 'ready' ? cached.header.reportId : cached?.reportId) ??
        retainedIds.current.get(scope)
      const bookmark = await observationReportBookmark(filters, taskId)
      const assertCurrent = () => {
        signal.throwIfAborted()
        if (!bookmark.current()) throw new Error('Complete report identity changed')
      }
      let restoredId: string | null = null
      try {
        assertCurrent()
        if (!id && revision === 0) {
          restoredId = bookmark.read()
          if (restoredId) {
            try {
              const restored = await api.get<CompleteObservationReport>(
                '/api/observability/reports/' + encodeURIComponent(restoredId),
                undefined,
                signal,
              )
              assertCurrent()
              const content = checkedReportContent(restored, filters, taskId, restoredId)
              if (!content) throw new Error('Completed report content is missing')
              client.setQueryData(displayValidityKey(restoredId), true)
              setPrevious({ scope: displayScope, content })
              retainedIds.current.set(scope, restoredId)
              return restored
            } catch (error) {
              discardObservationReportBookmark(restoredId)
              if (!(error instanceof ApiError && error.status === 404)) throw error
              assertCurrent()
              restoredId = null
            }
          }
        }
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
        assertCurrent()
        const content = checkedReportContent(report, filters, taskId, id)
        const reportId = report.state === 'ready' ? report.header.reportId : report.reportId
        retainedIds.current.set(scope, reportId)
        if (content) bookmark.remember(reportId)
        if (report.state === 'failed' || (report.state === 'not-ready' && !report.facts)) {
          if (restoredId) discardObservationReportBookmark(restoredId)
          if (previous?.scope === displayScope)
            discardObservationReportBookmark(previous.content.header.reportId)
          discardObservationReportBookmark(reportId)
        }
        return report
      } catch (error) {
        if (restoredId) discardObservationReportBookmark(restoredId)
        if (id) discardObservationReportBookmark(id)
        if (previous?.scope === displayScope)
          discardObservationReportBookmark(previous.content.header.reportId)
        setPrevious((old) =>
          old?.scope === displayScope &&
          (old.content.header.reportId === restoredId ||
            old.content.header.reportId === id ||
            old.content.header.reportId === previous?.content.header.reportId)
            ? null
            : old,
        )
        throw error
      }
    },
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.state === 'building' ? 2000 : false,
  })
  const content = query.data ? completeObservationReportContent(query.data) : null
  const retained = previous?.scope === displayScope ? previous.content : null
  const validity = useQuery({
    queryKey: displayValidityKey(content?.header.reportId ?? retained?.header.reportId ?? null),
    queryFn: async () => true,
    initialData: true,
    enabled: false,
    gcTime: 0,
  })
  useEffect(() => {
    if (
      query.error ||
      query.data?.state === 'failed' ||
      (query.data?.state === 'not-ready' && !query.data.facts)
    ) {
      if (previous?.scope === displayScope)
        discardObservationReportBookmark(previous.content.header.reportId)
      setPrevious(null)
    } else if (content && !query.isFetching) {
      // Only a successful original scope-checked response can qualify the snapshot again.
      client.setQueryData(displayValidityKey(content.header.reportId), true)
      setPrevious((old) =>
        old?.scope === displayScope && old.content === content
          ? old
          : { scope: displayScope, content },
      )
    } else {
      setPrevious((old) => (old?.scope === displayScope ? old : null))
    }
  }, [
    client,
    content,
    displayScope,
    query.data,
    query.dataUpdatedAt,
    query.error,
    query.isFetching,
    previous,
  ])
  const busy =
    query.isPending || query.isFetching || (!query.error && query.data?.state === 'building')
  const checkedContent = query.isFetching
    ? content?.header.reportId === retained?.header.reportId
      ? retained
      : null
    : content
  const displayContent =
    !query.error && validity.data !== false
      ? (checkedContent ?? (!query.data || query.data.state === 'building' ? retained : null))
      : null
  return {
    ...query,
    busy,
    displayContent,
    refreshingPrevious: !!displayContent && busy,
  }
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
          discardObservationReportBookmark(report.header.reportId)
          // The displayed old report can outlive its original query entry during a new build.
          // Keep only its invalidation flag observed; never write old facts into the new query.
          client.setQueryData(displayValidityKey(report.header.reportId), false)
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
