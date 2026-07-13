// RFC-177: /workgroups/by-id/$id — resolve a task's frozen `workgroupId` to the
// group's CURRENT name and redirect to its canonical page, so a subject link
// survives a rename (and never opens a same-named replacement group). The
// two-segment path never collides with /workgroups/$name (arity-distinct: a
// group literally named "by-id" still resolves at /workgroups/by-id). Rendering
// does no lookup — resolution happens here, on navigation, ACL-gated server-side.

import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { useResolveResourceName } from '@/hooks/useResolveResourceName'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/by-id/$id',
  component: WorkgroupByIdRedirect,
})

function WorkgroupByIdRedirect() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { name, isLoading, isError } = useResolveResourceName('workgroups', id)

  useEffect(() => {
    if (name !== null) void navigate({ to: '/workgroups/$name', params: { name }, replace: true })
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
