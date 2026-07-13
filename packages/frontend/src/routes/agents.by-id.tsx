// RFC-177: /agents/by-id/$id — resolve a task's frozen `sourceAgentId` to the
// agent's CURRENT name and redirect to its canonical page, so a subject link
// survives a rename/reuse of the name (never opens a same-named replacement
// agent). Two-segment path never collides with /agents/$name (arity-distinct).
// Rendering does no lookup — resolution is ACL-gated server-side, on navigation.

import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
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
  const { name, isLoading, isError } = useResolveResourceName('agents', id)

  useEffect(() => {
    if (name !== null) void navigate({ to: '/agents/$name', params: { name }, replace: true })
  }, [name, navigate])

  if (isLoading) return <LoadingState />
  if (isError || name === null) {
    return (
      <div className="page">
        <EmptyState title={t('common.resourceUnavailable')} />
      </div>
    )
  }
  return <LoadingState /> // resolved — redirecting
}
