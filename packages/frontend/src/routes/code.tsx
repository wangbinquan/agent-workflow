// RFC-310 digital employee capability home.
//
// This route owns construction and strategy configuration only. Runtime work
// is intentionally projected into the unified /tasks surface; keeping a
// second mission inbox here would recreate two competing task concepts.

import { useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { JourneyNextAction, type JourneyProjection } from '@/components/code/JourneyNextAction'
import { Route as RootRoute } from './__root'

interface CodeSearch extends Record<string, unknown> {
  repo?: string
}

/** Old activity/results bookmarks collapse to the capability construction home. */
export function validateCodeSearch(search: Record<string, unknown>): CodeSearch {
  const { tab: _tab, repo: _repo, ...adjacent } = search
  return {
    ...adjacent,
    ...(typeof search.repo === 'string' && search.repo !== '' ? { repo: search.repo } : {}),
  }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code',
  validateSearch: validateCodeSearch,
  component: CodePage,
})

function CodePage(): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="page page--operations code-page">
      <div className="operations-surface">
        <PageHeader
          title={t('code.title')}
          className="operations-surface__header"
          actions={
            <Link
              to="/code/config/$kind"
              params={{ kind: 'employees' }}
              search={{ create: true }}
              className="btn btn--sm btn--primary"
              data-testid="digital-employee-create"
            >
              {t('code.employeePlaybook.createEmployee')}
            </Link>
          }
        >
          <p className="operations-surface__subtitle">{t('code.subtitle')}</p>
        </PageHeader>

        <DigitalEmployeeSetupJourney />

        <section className="digital-employee-build-grid" aria-label={t('code.build.title')}>
          <BuildCard
            to="employees"
            title={t('code.build.employees.title')}
            body={t('code.build.employees.body')}
          />
          <BuildCard
            to="executors"
            title={t('code.build.executors.title')}
            body={t('code.build.executors.body')}
          />
          <BuildCard
            to="assignments"
            title={t('code.build.assignments.title')}
            body={t('code.build.assignments.body')}
          />
        </section>

        <aside className="digital-employee-runtime-handoff">
          <div>
            <strong>{t('code.build.runtimeTitle')}</strong>
            <p>{t('code.build.runtimeBody')}</p>
          </div>
          <Link
            to="/tasks"
            search={{ category: 'digital-employee' }}
            className="btn btn--sm"
            data-testid="digital-employee-open-tasks"
          >
            {t('code.build.openTasks')}
          </Link>
        </aside>
      </div>
    </div>
  )
}

function BuildCard(props: {
  to: 'employees' | 'executors' | 'assignments'
  title: string
  body: string
}): ReactElement {
  const content = (
    <>
      <strong>{props.title}</strong>
      <span>{props.body}</span>
      <span className="digital-employee-build-card__next" aria-hidden="true">
        →
      </span>
    </>
  )
  if (props.to === 'employees') {
    return (
      <Link
        to="/code/config/$kind"
        params={{ kind: 'employees' }}
        className="digital-employee-build-card"
        data-testid="digital-employee-build-employees"
      >
        {content}
      </Link>
    )
  }
  const path = props.to === 'executors' ? '/code/executors' : '/code/assignments'
  return (
    <Link
      to={path}
      className="digital-employee-build-card"
      data-testid={`digital-employee-build-${props.to}`}
    >
      {content}
    </Link>
  )
}

function DigitalEmployeeSetupJourney(): ReactElement {
  const journey = useQuery<JourneyProjection>({
    queryKey: ['digital-employee-setup-journey'],
    queryFn: ({ signal }) => api.get('/api/code/setup-journey', undefined, signal),
    staleTime: 10_000,
  })
  if (journey.isPending) return <LoadingState />
  if (journey.isError) return <ErrorBanner error={journey.error} />
  return <JourneyNextAction journey={journey.data} />
}
