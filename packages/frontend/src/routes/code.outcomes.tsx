// RFC-310 runtime outcome home.
//
// Outcomes are runtime evidence, so their canonical home is the
// "Operations & repositories" group rather than the digital-employee builder.
// An optional employee filter keeps this projection as the natural drill-down
// from one employee without creating a second result concept under `/code`.

import { useQuery } from '@tanstack/react-query'
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

const TERMINAL = new Set(['merged', 'completed-no-change', 'closed-unmerged', 'canceled', 'failed'])

function OutcomesPage(): ReactElement {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const missions = useQuery<{ items: MissionSummary[] }>({
    queryKey: ['code-missions'],
    queryFn: ({ signal }) => api.get('/api/code/missions', undefined, signal),
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
  const scoped = (missions.data?.items ?? []).filter(
    (mission) => search.employee === undefined || mission.employeeId === search.employee,
  )
  const outcomes = scoped.filter((mission) => TERMINAL.has(mission.status))
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
          <OutcomeSummary missions={outcomes} />

          <section className="page__section">
            <div className="mission-operations__section-title">
              <div>
                <h2>{t('code.outcomes.historyTitle')}</h2>
                <p>{t('code.outcomes.historyHint')}</p>
              </div>
              <StatusChip kind="neutral">{outcomes.length}</StatusChip>
            </div>
            {outcomes.length === 0 ? (
              <EmptyState
                title={t('code.outcomes.emptyTitle')}
                description={t('code.outcomes.emptyBody')}
              />
            ) : (
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
            )}
          </section>

          {search.employee === undefined ? <CapabilityOutcomeSection /> : null}
        </div>
      </div>
    </div>
  )
}

function OutcomeSummary({ missions }: { missions: readonly MissionSummary[] }): ReactElement {
  const { t } = useTranslation()
  const cards = [
    {
      key: 'merged',
      value: missions.filter((mission) => mission.status === 'merged').length,
      kind: 'success' as const,
    },
    {
      key: 'noChange',
      value: missions.filter((mission) => mission.status === 'completed-no-change').length,
      kind: 'info' as const,
    },
    {
      key: 'closed',
      value: missions.filter(
        (mission) => mission.status === 'closed-unmerged' || mission.status === 'canceled',
      ).length,
      kind: 'neutral' as const,
    },
    {
      key: 'failed',
      value: missions.filter((mission) => mission.status === 'failed').length,
      kind: 'danger' as const,
    },
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
