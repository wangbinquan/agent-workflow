// RFC-177: /agents/by-id/$id — resolve a task's frozen `sourceAgentId` to the
// agent's CURRENT name and redirect to its canonical page, so a subject link
// survives a rename/reuse of the name (never opens a same-named replacement
// agent). Two-segment path never collides with /agents/$name (arity-distinct).
// Rendering does no lookup — resolution is ACL-gated server-side, on navigation.

import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { ApiError } from '@/api/client'
import { useResolveResourceName } from '@/hooks/useResolveResourceName'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents/by-id/$id',
  component: AgentByIdRedirect,
})

function AgentByIdRedirect() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { name, isError, error, refetch } = useResolveResourceName('agents', id)

  useEffect(() => {
    if (name !== null) void navigate({ to: '/agents/$name', params: { name }, replace: true })
  }, [name, navigate])

  if (isError && error instanceof ApiError && error.status === 404) {
    return (
      <div className="page">
        <PageHeader title={t('agents.title')} />
        <EmptyState title={t('common.resourceUnavailable')} />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="page">
        <PageHeader title={t('agents.title')} />
        <ErrorBanner
          error={error}
          action={
            <button type="button" className="btn btn--sm" onClick={refetch}>
              {t('common.retry')}
            </button>
          }
        />
      </div>
    )
  }
  return (
    <div className="page">
      <PageHeader title={t('agents.title')} />
      <LoadingState />
    </div>
  ) // loading or resolved and redirecting
}
