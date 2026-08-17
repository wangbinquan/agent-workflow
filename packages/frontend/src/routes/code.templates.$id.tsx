// RFC-309 T12/T13/T16 — a template's own page: what it runs, and where it came from.
//
// This route is the answer to the user's second question — 「是不是应该在模版里
// 配置流程，大家直接用模版就行了」. Before it, the flow lived on its own tab and
// asked you to pick a capability and then a configuration; the template list
// lived on another tab and showed the same configuration as JSON. Opening a
// template now shows the sequence it runs, and clicking a step configures THAT
// step of THIS template.
//
// Three things share the page, in the order somebody needs them:
//
//   the header    — name, capability, and the actions that apply to the whole
//                   template (copy, export, delete)
//   upstream      — T64's four states, wired for the first time. It sits above
//                   the flow because "your copy is three fixes behind" changes
//                   what you should do with the flow below it.
//   the flow      — the editable sequence.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { CapabilityTemplateWire } from '@agent-workflow/shared'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { ResourcePackageExportButton } from '@/components/ResourcePackageExportButton'
import { StatusChip } from '@/components/StatusChip'
import { TemplateFlowEditor } from '@/components/code/TemplateFlowEditor'
import { TemplateUpstreamPanel } from '@/components/code/TemplateUpstreamPanel'
import { LaunchRoundPanel } from '@/components/code/LaunchRoundPanel'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/templates/$id',
  component: TemplateDetailPage,
})

function TemplateDetailPage() {
  const { id } = Route.useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const template = useQuery<CapabilityTemplateWire, ApiError>({
    queryKey: ['capability-template', id],
    queryFn: () => api.get<CapabilityTemplateWire>(`/api/capability-templates/${id}`),
  })

  const copy = useMutation({
    mutationFn: () => api.post<CapabilityTemplateWire>(`/api/capability-templates/${id}/copy`, {}),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['capability-templates'] })
      // Straight to the copy: the reason to copy is to edit, and leaving the
      // reader on the original is how somebody edits the wrong one.
      await navigate({ to: '/code/templates/$id', params: { id: created.id } })
    },
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/capability-templates/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['capability-templates'] })
      await navigate({ to: '/code', search: { tab: 'templates' } })
    },
  })

  if (template.isPending) return <LoadingState />
  if (template.isError) {
    return (
      <div className="page">
        <ErrorBanner error={template.error} onRetry={() => void template.refetch()} />
        <Link className="btn btn--sm" to="/code" search={{ tab: 'templates' }}>
          {t('code.templates.backToList')}
        </Link>
      </div>
    )
  }

  const row = template.data

  return (
    <div className="page" data-testid="code-template-detail">
      <PageHeader
        title={row.name}
        meta={row.description ?? t('code.templates.detailSubtitle')}
        actions={
          <>
            <StatusChip kind="info" size="sm">
              {row.capability}
            </StatusChip>
            {row.scriptsRedacted && (
              <StatusChip kind="neutral" size="sm">
                {t('code.templates.scriptsHidden')}
              </StatusChip>
            )}
            <Link className="btn btn--sm" to="/code" search={{ tab: 'templates' }}>
              {t('code.templates.backToList')}
            </Link>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="code-template-detail-copy"
              disabled={copy.isPending}
              onClick={() => {
                copy.mutate()
              }}
            >
              {t('code.templates.copy')}
            </button>
            <ResourcePackageExportButton
              type="capability_template"
              id={row.id}
              name={row.name}
              fence={{ expectedUpdatedAt: row.updatedAt, expectedAclRevision: row.aclRevision }}
              variant="action"
            />
            {/* A built-in cannot be deleted, so the action is not offered —
                rendering it disabled would invite the question every time. */}
            {!row.builtin && (
              <ConfirmButton
                variant="danger"
                size="sm"
                data-testid="code-template-detail-delete"
                label={t('common.delete')}
                confirmationKey={row.id}
                onConfirm={() => {
                  remove.mutate()
                }}
              />
            )}
          </>
        }
      />

      {copy.isError && <ErrorBanner error={copy.error} />}
      {remove.isError && <ErrorBanner error={remove.error} />}

      <TemplateUpstreamPanel templateId={row.id} />
      <LaunchRoundPanel template={row} />
      <TemplateFlowEditor template={row} />
    </div>
  )
}
