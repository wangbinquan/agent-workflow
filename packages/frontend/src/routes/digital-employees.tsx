import { useQuery } from '@tanstack/react-query'
import { createRoute, Link, redirect } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import type { EmployeeTypePackage } from '@/components/digital-employees/types'
import { localized, typeRefKey } from '@/components/digital-employees/types'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Route as RootRoute } from './__root'

interface DigitalEmployeesSearch extends Record<string, unknown> {
  view?: 'events'
}

function validateSearch(raw: Record<string, unknown>): DigitalEmployeesSearch {
  return raw.view === 'events' ? { view: 'events' } : {}
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/digital-employees',
  validateSearch,
  beforeLoad: ({ search }) => {
    if (search.view === 'events') throw redirect({ to: '/events' })
  },
  component: DigitalEmployeesPage,
})

function DigitalEmployeesPage(): ReactElement {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const query = useQuery<{ items: EmployeeTypePackage[] }>({
    queryKey: ['digital-employee-types'],
    queryFn: ({ signal }) => api.get('/api/digital-employee-types', undefined, signal),
  })
  const zh = language.startsWith('zh')

  return (
    <div className="page page--operations digital-employees-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={zh ? '数字员工' : 'Digital employees'}
          actions={
            <Link to="/tasks/employee-cases/new" className="btn btn--primary">
              {zh ? '交给数字员工' : 'Assign work'}
            </Link>
          }
        >
          <p className="operations-surface__subtitle">
            {zh
              ? '先选择员工分类，再在固定职责图上配置每个工作项使用的工具。运行统一进入任务列表。'
              : 'Choose an employee type, then configure each work item on its fixed responsibility map. Runs stay in the unified task list.'}
          </p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          {query.isPending ? <LoadingState /> : null}
          {query.isError ? <ErrorBanner error={query.error} /> : null}
          {query.data?.items.length === 0 ? (
            <EmptyState
              title={zh ? '还没有员工分类' : 'No employee types'}
              description={
                zh
                  ? '员工分类由程序化类型包注册。'
                  : 'Employee types are registered by programmable type packages.'
              }
            />
          ) : null}
          <div className="employee-type-grid" data-testid="digital-employee-type-list">
            {query.data?.items.map((type) => (
              <Link
                key={typeRefKey(type.typeRef)}
                to="/digital-employees/$typeRef"
                params={{ typeRef: typeRefKey(type.typeRef) }}
                search={{ view: 'employees' }}
                className="employee-type-card"
                data-testid={`digital-employee-type-${type.typeRef.typeId}`}
              >
                <span className="employee-type-card__eyebrow">
                  {zh ? '数字员工分类' : 'Employee type'}
                </span>
                <strong>{localized(type.displayName, language)}</strong>
                <p>{localized(type.description, language)}</p>
                <dl>
                  <div>
                    <dt>{zh ? '职责' : 'Work items'}</dt>
                    <dd>{type.authoringManifest.workItems.length}</dd>
                  </div>
                  <div>
                    <dt>{zh ? '生命周期' : 'Lifecycle regions'}</dt>
                    <dd>{type.authoringManifest.lifecycleRegions.length}</dd>
                  </div>
                </dl>
                <span className="employee-type-card__open">{zh ? '进入配置' : 'Configure'} →</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
