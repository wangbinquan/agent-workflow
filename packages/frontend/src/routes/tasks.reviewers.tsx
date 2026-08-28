import type { ReviewNodeReviewerConfig, TaskMembers, UserPublic } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { UserPicker } from '@/components/UserPicker'
import { useAuthSessionRevision } from '@/hooks/useActor'
import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$taskId/reviewers',
  component: TaskReviewersPage,
})

type ReviewerDraft = Record<string, UserPublic[]>

function relationshipOf(members: TaskMembers | undefined, userId: string) {
  if (members?.ownerUserId === userId) return 'owner' as const
  return members?.members.find((member) => member.user.id === userId)?.role ?? null
}

function TaskReviewersPage() {
  const { taskId } = Route.useParams()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const authRevision = useAuthSessionRevision()
  const configKey = TASK_QUERY_KEYS.reviewers(taskId, authRevision)
  const membersKey = TASK_QUERY_KEYS.members(taskId, authRevision)
  const config = useQuery<ReviewNodeReviewerConfig>({
    queryKey: configKey,
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/reviewers`, undefined, signal),
  })
  const members = useQuery<TaskMembers>({
    queryKey: membersKey,
    queryFn: ({ signal }) =>
      api.get(`/api/tasks/${encodeURIComponent(taskId)}/members`, undefined, signal),
  })

  const [draft, setDraft] = useState<ReviewerDraft>({})
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (config.data === undefined || dirty) return
    setDraft(
      Object.fromEntries(config.data.nodes.map((node) => [node.reviewNodeId, [...node.reviewers]])),
    )
  }, [config.data, dirty])

  const save = useMutation({
    mutationFn: () =>
      api.put<ReviewNodeReviewerConfig>(`/api/tasks/${encodeURIComponent(taskId)}/reviewers`, {
        nodes: (config.data?.nodes ?? []).map((node) => ({
          reviewNodeId: node.reviewNodeId,
          reviewerUserIds: (draft[node.reviewNodeId] ?? []).map((user) => user.id),
        })),
      }),
    onSuccess: (next) => {
      qc.setQueryData(configKey, next)
      setDraft(
        Object.fromEntries(next.nodes.map((node) => [node.reviewNodeId, [...node.reviewers]])),
      )
      setDirty(false)
      void qc.invalidateQueries({ queryKey: ['reviews'] })
    },
  })

  const strongerReviewerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const users of Object.values(draft)) {
      for (const user of users) {
        const relation = relationshipOf(members.data, user.id)
        if (relation === 'owner' || relation === 'collaborator') ids.add(user.id)
      }
    }
    return ids
  }, [draft, members.data])

  const relationshipChip = (userId: string) => {
    const relationship = relationshipOf(members.data, userId)
    if (relationship === null) return null
    return (
      <StatusChip kind={relationship === 'observer' ? 'neutral' : 'info'} size="sm">
        {t(`reviewers.relationship.${relationship}` as const)}
      </StatusChip>
    )
  }

  return (
    <div className="page task-reviewers" data-testid="task-reviewers-page">
      <PageHeader
        title={t('reviewers.title')}
        back={
          <Link to="/tasks/$id" params={{ id: taskId }} className="link">
            ← {t('reviewers.backToTask')}
          </Link>
        }
      />

      <NoticeBanner tone="info">{t('reviewers.capabilityNotice')}</NoticeBanner>

      {config.data === undefined ? (
        config.error !== null && config.error !== undefined ? (
          <ErrorBanner error={config.error} onRetry={() => void config.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : config.data.nodes.length === 0 ? (
        <EmptyState
          title={t('reviewers.emptyTitle')}
          description={t('reviewers.emptyDescription')}
        />
      ) : (
        <div className="task-reviewers__nodes">
          {config.data.nodes.map((node) => {
            const value = draft[node.reviewNodeId] ?? []
            return (
              <section className="card task-reviewers__node" key={node.reviewNodeId}>
                <div className="card__header">
                  <div className="card__title-row">
                    <h2 className="card__title">{node.title || node.reviewNodeId}</h2>
                    <code>{node.reviewNodeId}</code>
                  </div>
                </div>
                <div className="card__body">
                  {node.description !== '' && <p className="muted">{node.description}</p>}
                  <Field group label={t('reviewers.nodeReviewers')} hint={t('reviewers.nodeHint')}>
                    <UserPicker
                      value={value}
                      onChange={(next) => {
                        setDraft((current) => ({ ...current, [node.reviewNodeId]: next }))
                        setDirty(true)
                        save.reset()
                      }}
                      activeOnly
                      disabled={save.isPending}
                      placeholder={t('reviewers.pickerPlaceholder')}
                      aria-label={t('reviewers.pickerAria', {
                        node: node.title || node.reviewNodeId,
                      })}
                      testidPrefix={`reviewers-${node.reviewNodeId}`}
                      renderAdornment={relationshipChip}
                      renderOptionMeta={(user) => relationshipChip(user.id)}
                    />
                  </Field>
                </div>
              </section>
            )
          })}
        </div>
      )}

      {strongerReviewerIds.size > 0 && (
        <p className="page__hint" data-testid="reviewers-stronger-role-hint">
          {t('reviewers.strongerRoleHint')}
        </p>
      )}
      {members.error !== null && members.error !== undefined && (
        <ErrorBanner error={members.error} onRetry={() => void members.refetch()} />
      )}
      {save.error !== null && save.error !== undefined && (
        <ErrorBanner error={save.error} onDismiss={() => save.reset()} />
      )}
      {save.isSuccess && !dirty && (
        <NoticeBanner tone="success">{t('reviewers.saved')}</NoticeBanner>
      )}

      {config.data !== undefined && config.data.nodes.length > 0 && (
        <div className="task-reviewers__actions">
          <span className="page__hint">{t('reviewers.replaceHint')}</span>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      )}
    </div>
  )
}
