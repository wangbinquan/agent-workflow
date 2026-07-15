// RFC-177: /workgroups/by-id/$id — resolve a task's frozen `workgroupId` to the
// group's CURRENT name and redirect to its canonical page, so a subject link
// survives a rename (and never opens a same-named replacement group). The
// two-segment path never collides with /workgroups/$name (arity-distinct: a
// group literally named "by-id" still resolves at /workgroups/by-id). Rendering
// does no lookup — resolution happens here, on navigation, ACL-gated server-side.
//
// Known residuals (Codex impl-gate P2, accepted for RFC-177):
//   - the resolve→redirect→detail-load is two sequential requests; a rename+reuse
//     landing in that sub-second same-client window could still ABA. Negligible vs
//     the original permanent-after-rename bug; fully closing needs id-addressable
//     detail pages (out of scope).
//   - a group named after a literal route ("launch") redirects into that literal
//     (the task wizard), not the group — a PRE-EXISTING name-vs-literal shadow that
//     affects every /workgroups/$name link, not just this resolver; a reserved-name
//     guard is a separate change.

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
  path: '/workgroups/by-id/$id',
  component: WorkgroupByIdRedirect,
})

function WorkgroupByIdRedirect() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { name, isError, error, refetch } = useResolveResourceName('workgroups', id)

  useEffect(() => {
    if (name !== null) void navigate({ to: '/workgroups/$name', params: { name }, replace: true })
  }, [name, navigate])

  if (isError && error instanceof ApiError && error.status === 404) {
    return (
      <div className="page">
        <PageHeader title={t('workgroups.title')} />
        <EmptyState title={t('common.resourceUnavailable')} />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="page">
        <PageHeader title={t('workgroups.title')} />
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
      <PageHeader title={t('workgroups.title')} />
      <LoadingState />
    </div>
  ) // loading or resolved and redirecting
}
