// RFC-310 runtime outcome home.
//
// Outcomes are runtime evidence, so their canonical home is the
// "Operations & repositories" group rather than the digital-employee builder.
// An optional employee filter keeps this projection as the natural drill-down
// from one employee without creating a second result concept under `/code`.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createRoute, Link, redirect } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { missionStatusKind, missionStatusLabel, type MissionSummary } from './code.missions'
import { Route as RootRoute } from './__root'

interface OutcomesSearch extends Record<string, unknown> {
  employee?: string
}

export function validateOutcomesSearch(search: Record<string, unknown>): OutcomesSearch {
  return typeof search.employee === 'string' && search.employee !== ''
    ? { employee: search.employee }
    : {}
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/outcomes',
  validateSearch: validateOutcomesSearch,
  component: OutcomesPage,
})

/** Preserve old bookmarks while making the runtime-owned URL canonical. */
export const LegacyRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/outcomes',
  beforeLoad: ({ search }) => {
    const employee = (search as { employee?: unknown }).employee
    throw redirect({
      to: '/outcomes',
      search: typeof employee === 'string' && employee !== '' ? { employee } : {},
    })
  },
})

interface AdoptionRow {
  capability: string
  published: number
  adopted: number
  quietFix: number
  disagreed: number
  outstanding: number
}

interface RunRow {
  capability: string
  rounds: number
  published: number
  failed: number
  awaiting: number
  incomplete: number
}

interface NamedRow {
  id: string
  name: string
}

interface RepositoryRow {
  id: string
  urlRedacted: string | null
}

const TERMINAL_STATUSES = [
  'merged',
  'completed-no-change',
  'closed-unmerged',
  'canceled',
  'failed',
] as const

function OutcomesPage(): ReactElement {
  const { t } = useTranslation()
  const search = Route.useSearch()
  // RFC-311：终态清单由**服务端**收敛（employeeId + 原始 mission 状态），并按 keyset
  // 翻页。此前是取全量再在前端 `filter(TERMINAL.has(...))`——mission 表长起来后这一页
  // 会把整张表搬进浏览器。终态必须用**原始** mission 状态表达：任务状态映射会把
  // `blocked` 并进 `failed`，而 blocked 不是终态。
  const missions = useInfiniteQuery({
    queryKey: ['code-missions', 'outcomes', search.employee ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get<{
        items: MissionSummary[]
        nextCursor: string | null
        counts: Record<string, number>
      }>(
        '/api/code/missions',
        {
          missionStatuses: TERMINAL_STATUSES.join(','),
          employeeId: search.employee,
          limit: 50,
          cursor: pageParam ?? undefined,
        },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const employees = useQuery<{ items: NamedRow[] }>({
    queryKey: ['code-config', 'employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const repos = useQuery<{ items: RepositoryRow[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  if (missions.isPending) return <LoadingState />
  if (missions.isError) return <ErrorBanner error={missions.error} />

  const employeeName =
    search.employee === undefined
      ? null
      : (employees.data?.items?.find((employee) => employee.id === search.employee)?.name ??
        search.employee)
  // 过滤已经在服务端做完了，这里只是把已取回的页拼起来。
  const outcomes = (missions.data?.pages ?? []).flatMap((page) => page.items)
  // 统计与总数一律用服务端 counts（过滤集上的分组），不用已加载行数——后者随翻页
  // 增长且永远偏小。
  const outcomeCounts = missions.data?.pages[0]?.counts ?? {}
  const outcomeTotal = Object.values(outcomeCounts).reduce((a, b) => a + b, 0)
  const repoLabel = (id: string): string =>
    repos.data?.items?.find((repo) => repo.id === id)?.urlRedacted ?? id
  const employeeLabel = (id: string | null): string =>
    id === null
      ? t('code.outcomes.employeeFallback')
      : (employees.data?.items?.find((employee) => employee.id === id)?.name ?? id)

  return (
    <div className="page page--operations code-outcomes-page" data-testid="run-outcomes-page">
      <div className="operations-surface">
        <PageHeader
          title={
            employeeName === null
              ? t('code.outcomes.title')
              : t('code.outcomes.employeeTitle', { employee: employeeName })
          }
          className="operations-surface__header"
          actions={
            search.employee === undefined ? null : (
              <Link to="/outcomes" className="btn btn--sm">
                {t('code.outcomes.showAll')}
              </Link>
            )
          }
        >
          <p className="operations-surface__subtitle">{t('code.outcomes.subtitle')}</p>
        </PageHeader>

        <div className="employee-manual-panel">
          <OutcomeSummary counts={outcomeCounts} />

          <section className="page__section">
            <div className="mission-operations__section-title">
              <div>
                <h2>{t('code.outcomes.historyTitle')}</h2>
                <p>{t('code.outcomes.historyHint')}</p>
              </div>
              <StatusChip kind="neutral">{outcomeTotal}</StatusChip>
            </div>
            {outcomes.length === 0 ? (
              <EmptyState
                title={t('code.outcomes.emptyTitle')}
                description={t('code.outcomes.emptyBody')}
              />
            ) : (
              <>
                <TableViewport label={t('code.outcomes.historyTitle')}>
                  <table data-testid="code-outcome-history">
                    <thead>
                      <tr>
                        <th scope="col">{t('code.outcomes.colMission')}</th>
                        <th scope="col">{t('code.outcomes.colResult')}</th>
                        <th scope="col">{t('code.outcomes.colEmployee')}</th>
                        <th scope="col">{t('code.outcomes.colRepository')}</th>
                        <th scope="col">{t('code.outcomes.colCompleted')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcomes.map((mission) => (
                        <tr key={mission.id}>
                          <td>
                            <Link to="/code/missions/$missionId" params={{ missionId: mission.id }}>
                              {mission.id.slice(-8)}
                            </Link>
                          </td>
                          <td>
                            <StatusChip kind={missionStatusKind(mission.status)} size="sm">
                              {missionStatusLabel(t, mission.status)}
                            </StatusChip>
                          </td>
                          <td>{employeeLabel(mission.employeeId)}</td>
                          <td>{repoLabel(mission.repositoryId)}</td>
                          <td>{new Date(mission.updatedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
                {missions.hasNextPage && (
                  <div className="page__actions">
                    {/* 与 /tasks 同款：可及名固定、永不 disabled，加载态由 aria-busy +
                      sr-only 旁白承载（点击目标不能从指针底下消失）。 */}
                    <button
                      type="button"
                      className="btn btn--sm"
                      aria-busy={missions.isFetchingNextPage || undefined}
                      onClick={() => {
                        if (!missions.isFetchingNextPage) void missions.fetchNextPage()
                      }}
                    >
                      {t('tasks.operations.loadMore')}
                    </button>
                    {missions.isFetchingNextPage ? (
                      <span role="status" className="sr-only">
                        {t('tasks.operations.loadingMore')}
                      </span>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </section>

          {search.employee === undefined ? <CapabilityOutcomeSection /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * RFC-311：统计吃**服务端 counts**，不是已加载的行。
 *
 * 这一页接分页之后，`missions.filter(...).length` 会变成「已翻到的那几页里有多少」——
 * 数字随滚动增长、且**永远偏小**。那比慢更糟：慢看得见，错的统计看不见。counts 由
 * 服务端在过滤集上分组算出，与翻到第几页无关。
 */
function OutcomeSummary({ counts }: { counts: Record<string, number> }): ReactElement {
  const { t } = useTranslation()
  const n = (key: string): number => counts[key] ?? 0
  const cards = [
    { key: 'merged', value: n('merged'), kind: 'success' as const },
    { key: 'noChange', value: n('completed-no-change'), kind: 'info' as const },
    { key: 'closed', value: n('closed-unmerged') + n('canceled'), kind: 'neutral' as const },
    { key: 'failed', value: n('failed'), kind: 'danger' as const },
  ]
  return (
    <section className="outcome-summary" aria-label={t('code.outcomes.summaryAria')}>
      {cards.map((card) => (
        <Card
          key={card.key}
          title={t(`code.outcomes.summary.${card.key}.title`)}
          actions={<StatusChip kind={card.kind}>{card.value}</StatusChip>}
        >
          <p>{t(`code.outcomes.summary.${card.key}.body`)}</p>
        </Card>
      ))}
    </section>
  )
}

function CapabilityOutcomeSection(): ReactElement {
  const { t } = useTranslation()
  const metrics = useQuery({
    queryKey: ['code-metrics'],
    queryFn: () =>
      api.get<{ windowMs: number; adoption: AdoptionRow[]; runs: RunRow[] }>('/api/code/metrics'),
  })

  if (metrics.isPending) return <LoadingState />
  if (metrics.isError) {
    return <ErrorBanner error={metrics.error} onRetry={() => void metrics.refetch()} />
  }

  const adoption = metrics.data?.adoption ?? []
  const runs = metrics.data?.runs ?? []
  const days = Math.round((metrics.data?.windowMs ?? 0) / 86_400_000)

  return (
    <section className="page__section" data-testid="capability-outcomes">
      <div className="mission-operations__section-title">
        <div>
          <h2>{t('code.outcomes.capabilityTitle')}</h2>
          <p>{t('code.metrics.window', { days })}</p>
        </div>
      </div>
      {adoption.length === 0 && runs.length === 0 ? (
        <EmptyState title={t('code.metrics.empty')} description={t('code.metrics.emptyHint')} />
      ) : (
        <>
          <h3>{t('code.metrics.adoptionTitle')}</h3>
          <TableViewport label={t('code.metrics.adoptionTitle')}>
            <table data-testid="code-metrics-adoption">
              <thead>
                <tr>
                  <th scope="col">{t('code.metrics.capability')}</th>
                  <th scope="col">{t('code.metrics.published')}</th>
                  <th scope="col">{t('code.metrics.adopted')}</th>
                  <th scope="col">{t('code.metrics.quietFix')}</th>
                  <th scope="col">{t('code.metrics.disagreed')}</th>
                  <th scope="col">{t('code.metrics.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {adoption.map((row) => (
                  <tr key={row.capability} data-testid={`code-metrics-adoption-${row.capability}`}>
                    <td>{row.capability}</td>
                    <td>{row.published}</td>
                    <td>{row.adopted}</td>
                    <td>{row.quietFix}</td>
                    <td>{row.disagreed}</td>
                    <td>{row.outstanding}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>

          <h3>{t('code.metrics.runsTitle')}</h3>
          <TableViewport label={t('code.metrics.runsTitle')}>
            <table data-testid="code-metrics-runs">
              <thead>
                <tr>
                  <th scope="col">{t('code.metrics.capability')}</th>
                  <th scope="col">{t('code.metrics.rounds')}</th>
                  <th scope="col">{t('code.metrics.roundsPublished')}</th>
                  <th scope="col">{t('code.metrics.roundsFailed')}</th>
                  <th scope="col">{t('code.metrics.roundsAwaiting')}</th>
                  <th scope="col">{t('code.metrics.roundsIncomplete')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => (
                  <tr key={row.capability} data-testid={`code-metrics-runs-${row.capability}`}>
                    <td>{row.capability}</td>
                    <td>{row.rounds}</td>
                    <td>{row.published}</td>
                    <td>{row.failed}</td>
                    <td>{row.awaiting}</td>
                    <td>{row.incomplete}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </>
      )}
    </section>
  )
}
