// RFC-310 executor library — the business-facing inventory used by every
// digital-employee step card. ActionTemplate remains an internal persistence
// term; this page speaks only in AI executors, programs, employees and systems.

import { useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { PLATFORM_ACTIONS, type PublishedResourceOption } from '@/components/code/employeePlaybook'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/executors',
  component: ExecutorLibraryPage,
})

interface ExecutorRow extends PublishedResourceOption {
  archivedAt?: number | null
  businessStatus?: 'enabled' | 'disabled'
}

function ExecutorLibraryPage(): ReactElement {
  const { t } = useTranslation()
  const canCreateImplementation = usePermission('action-templates:create')
  const canCreateEmployee = usePermission('digital-employees:create')
  const canCreateAdapter = usePermission('adapter-definitions:create')
  const templates = useQuery<{ items: ExecutorRow[] }>({
    queryKey: ['code-config', 'action-templates'],
    queryFn: ({ signal }) => api.get('/api/code/action-templates', undefined, signal),
  })
  const employees = useQuery<{ items: ExecutorRow[] }>({
    queryKey: ['code-config', 'employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const adapters = useQuery<{ items: ExecutorRow[] }>({
    queryKey: ['code-config', 'adapters'],
    queryFn: ({ signal }) => api.get('/api/integrations/development-adapters', undefined, signal),
  })
  const errors = [templates.error, employees.error, adapters.error].filter(
    (value): value is Error => value instanceof Error,
  )
  const implementations = templates.data?.items ?? []

  return (
    <div className="page page--operations executor-library-page">
      <div className="operations-surface">
        <PageHeader title={t('code.executors.title')} className="operations-surface__header">
          <p className="operations-surface__subtitle">{t('code.executors.subtitle')}</p>
        </PageHeader>

        {errors.length > 0 ? <ErrorBanner error={errors[0]} /> : null}
        {templates.isPending || employees.isPending || adapters.isPending ? <LoadingState /> : null}

        <div className="executor-library-grid">
          <ExecutorGroup
            title={t('code.executors.ai.title')}
            description={t('code.executors.ai.body')}
            rows={implementations.filter((row) => row.executorKind !== 'script')}
            empty={t('code.executors.ai.empty')}
            action={
              canCreateImplementation ? (
                <Link
                  to="/code/config/$kind"
                  params={{ kind: 'action-templates' }}
                  search={{ create: true }}
                  className="btn btn--xs"
                >
                  {t('code.executors.addAi')}
                </Link>
              ) : null
            }
            href={(row) => ({ kind: 'action-templates', id: row.id })}
          />
          <ExecutorGroup
            title={t('code.executors.program.title')}
            description={t('code.executors.program.body')}
            rows={implementations.filter((row) => row.executorKind === 'script')}
            empty={t('code.executors.program.empty')}
            action={
              canCreateImplementation ? (
                <Link
                  to="/code/config/$kind"
                  params={{ kind: 'action-templates' }}
                  search={{ create: true }}
                  className="btn btn--xs"
                >
                  {t('code.executors.addProgram')}
                </Link>
              ) : null
            }
            href={(row) => ({ kind: 'action-templates', id: row.id })}
          />
          <ExecutorGroup
            title={t('code.executors.employee.title')}
            description={t('code.executors.employee.body')}
            rows={employees.data?.items ?? []}
            empty={t('code.executors.employee.empty')}
            action={
              canCreateEmployee ? (
                <Link
                  to="/code/config/$kind"
                  params={{ kind: 'employees' }}
                  search={{ create: true }}
                  className="btn btn--xs"
                >
                  {t('code.executors.addEmployee')}
                </Link>
              ) : null
            }
            href={(row) => ({ kind: 'employees', id: row.id })}
          />
          <ExecutorGroup
            title={t('code.executors.system.title')}
            description={t('code.executors.system.body')}
            rows={adapters.data?.items ?? []}
            empty={t('code.executors.system.empty')}
            action={
              canCreateAdapter ? (
                <Link
                  to="/code/config/$kind"
                  params={{ kind: 'adapters' }}
                  search={{ create: true }}
                  className="btn btn--xs"
                >
                  {t('code.executors.addSystem')}
                </Link>
              ) : null
            }
            href={(row) => ({ kind: 'adapters', id: row.id })}
          />
        </div>

        <section className="executor-library-builtins">
          <div>
            <h2>{t('code.executors.platform.title')}</h2>
            <p>{t('code.executors.platform.body')}</p>
          </div>
          <div className="executor-library-builtins__items">
            {PLATFORM_ACTIONS.map((action) => (
              <StatusChip key={action} kind="neutral" size="sm">
                {t(`code.employeePlaybook.platform.${action.replace('.', '_')}`)}
              </StatusChip>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function ExecutorGroup(props: {
  title: string
  description: string
  rows: ExecutorRow[]
  empty: string
  action: ReactNode
  href: (row: ExecutorRow) => { kind: 'employees' | 'action-templates' | 'adapters'; id: string }
}): ReactElement {
  return (
    <section className="executor-library-group">
      <header className="executor-library-group__header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
        </div>
        {props.action}
      </header>
      {props.rows.length === 0 ? (
        <EmptyState size="compact" title={props.empty} />
      ) : (
        <ul className="executor-library-list">
          {props.rows.map((row) => {
            const target = props.href(row)
            return (
              <li key={row.id}>
                <Link
                  to="/code/config/$kind/$id"
                  params={{ kind: target.kind, id: target.id }}
                  className="executor-library-row"
                >
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.capabilityId ?? row.purpose ?? row.id}</small>
                  </span>
                  <StatusChip kind={row.publishedRevision === null ? 'warn' : 'success'} size="sm">
                    {row.publishedRevision === null ? '—' : `v${row.publishedRevision}`}
                  </StatusChip>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
