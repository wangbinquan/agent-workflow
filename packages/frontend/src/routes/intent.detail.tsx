// RFC-234 (T8) — intent session detail: conversation timeline (messages /
// structured questions / changeset summaries / retryable errors), composer,
// mounted working-set, the current-draft panel (per-op cards + validation +
// stale banner) and the commit dialog (server-issued slots: finalName /
// secret / waiver / humanBinding + per-update modify-vs-copy choice).

import {
  IntentChangesetSchema,
  IntentMountApprovalReceiptSchema,
  IntentQuestionsSchema,
  IntentSessionDetailSchema,
  PostIntentAnswersSchema,
  type IntentChangeset,
  type IntentMountSuggestionBatch,
  type IntentSessionDetail,
  type IntentSlotDto,
  type UserPublic,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ulid } from 'ulid'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Checkbox, Field, TextArea, TextInput } from '@/components/Form'
import { IntentMountDialog } from '@/components/IntentMountDialog'
import { IntentJourneyProgress } from '@/components/intent/IntentJourneyProgress'
import { IntentOpPreview } from '@/components/intent/IntentOpPreview'
import { IntentTurnSession } from '@/components/intent/IntentTurnSession'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TabBar, tabDomIds } from '@/components/TabBar'
import { UserPicker } from '@/components/UserPicker'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { INTENT_QUERY_KEYS, useIntentSessionsWs } from '@/hooks/useIntentSessionsWs'
import { intentFailureDiagnostic } from '@/lib/intent-failure-diagnostic'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/intent/$sessionId',
  component: IntentSessionDetailPage,
})

interface QuestionDraft {
  [questionId: string]: string[]
}

type WorkspaceTab = 'build' | 'review'

const REVIEW_FIRST_REASONS = new Set<IntentSessionDetail['session']['journey']['reason']>([
  'review-draft',
  'draft-stale',
  'draft-invalid',
  'apply-running',
  'apply-failed',
  'applied',
])

function IntentSessionDetailPage() {
  const { t } = useTranslation()
  const { sessionId } = Route.useParams()
  const qc = useQueryClient()
  useIntentSessionsWs()

  const detailQuery = useQuery<IntentSessionDetail, ApiError>({
    queryKey: INTENT_QUERY_KEYS.detail(sessionId),
    queryFn: async () =>
      IntentSessionDetailSchema.parse(await api.get<unknown>(`/api/intent-sessions/${sessionId}`)),
    refetchInterval: (query) => (query.state.data?.session.inFlight === true ? 1500 : false),
  })
  const detail = detailQuery.data

  const [message, setMessage] = useState('')
  const [answers, setAnswers] = useState<QuestionDraft>({})
  const [commitOpen, setCommitOpen] = useState(false)
  const [mountOpen, setMountOpen] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('build')
  const initializedWorkspaceSessionRef = useRef<string | null>(null)
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null)
  const selectedDraftIdentityRef = useRef<string | null>(null)
  const openedCommitDraftIdentityRef = useRef<string | null>(null)
  const isAuditView = detail?.session.ownerUserId !== undefined
  const canManageLifecycle = detail !== undefined && !isAuditView
  const canEdit =
    detail !== undefined && detail.session.status === 'active' && isAuditView === false

  const invalidate = () => qc.invalidateQueries({ queryKey: INTENT_QUERY_KEYS.detail(sessionId) })

  const sendMessage = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api.post(`/api/intent-sessions/${sessionId}/messages`, { message: message.trim() }),
    onSuccess: async () => {
      setMessage('')
      await invalidate()
    },
  })
  const sendAnswers = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api.post(`/api/intent-sessions/${sessionId}/answers`, {
        answers: Object.entries(answers).map(([id, picked]) => ({ id, picked })),
      }),
    onSuccess: async () => {
      setAnswers({})
      await invalidate()
    },
  })
  const retryTurn = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.post(`/api/intent-sessions/${sessionId}/retry`),
    onSuccess: invalidate,
  })
  const cancelTurn = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.post(`/api/intent-sessions/${sessionId}/cancel-turn`),
    onSuccess: invalidate,
  })
  const updateStatus = useMutation<unknown, ApiError, 'archive' | 'reopen'>({
    mutationFn: (action) => api.post(`/api/intent-sessions/${sessionId}/${action}`),
    onSuccess: async () => {
      await Promise.all([invalidate(), qc.invalidateQueries({ queryKey: INTENT_QUERY_KEYS.list })])
    },
  })
  const rebase = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.post(`/api/intent-sessions/${sessionId}/rebase`),
    onSuccess: invalidate,
  })
  const unmount = useMutation<unknown, ApiError, string>({
    mutationFn: (handle) =>
      api.delete(`/api/intent-sessions/${sessionId}/mounts/${encodeURIComponent(handle)}`),
    onSuccess: invalidate,
  })

  useEffect(() => {
    if (detail === undefined || canEdit) return
    setMountOpen(false)
    setCommitOpen(false)
  }, [canEdit, detail])

  const lastAgentTurn = useMemo(
    () => [...(detail?.turns ?? [])].reverse().find((turn) => turn.role === 'agent'),
    [detail?.turns],
  )
  const pendingQuestions = useMemo(() => {
    if (lastAgentTurn?.kind !== 'questions') return []
    const parsed = IntentQuestionsSchema.safeParse(lastAgentTurn.content.questions)
    return parsed.success ? parsed.data : []
  }, [lastAgentTurn])
  const latestRunningTurnId = lastAgentTurn?.kind === 'running' ? lastAgentTurn.id : null

  const draft = detail?.currentDraft ?? null
  const parsedChangeset = useMemo(() => {
    if (draft === null) return null
    const parsed = IntentChangesetSchema.safeParse(draft.changeset)
    return parsed.success ? parsed.data : null
  }, [draft])
  const draftOps = useMemo(() => parsedChangeset?.ops ?? [], [parsedChangeset])
  const draftIdentity = draft === null ? null : `${draft.id}:${draft.draftHash}`

  useEffect(() => {
    if (!commitOpen) {
      openedCommitDraftIdentityRef.current = null
      return
    }
    if (draftIdentity === null) {
      setCommitOpen(false)
      return
    }
    if (openedCommitDraftIdentityRef.current === null) {
      openedCommitDraftIdentityRef.current = draftIdentity
      return
    }
    if (openedCommitDraftIdentityRef.current !== draftIdentity) setCommitOpen(false)
  }, [commitOpen, draftIdentity])

  useEffect(() => {
    if (detail === undefined || initializedWorkspaceSessionRef.current === sessionId) return
    initializedWorkspaceSessionRef.current = sessionId
    setWorkspaceTab(REVIEW_FIRST_REASONS.has(detail.session.journey.reason) ? 'review' : 'build')
  }, [detail, sessionId])

  useEffect(() => {
    if (selectedDraftIdentityRef.current === draftIdentity) return
    selectedDraftIdentityRef.current = draftIdentity
    if (draft === null || draftOps.length === 0) {
      setSelectedOpId(null)
      return
    }
    const firstBlocking = draftOps.find((op) =>
      draft.validation.errors.some((error) => error.startsWith(`${op.opId}:`)),
    )
    setSelectedOpId((firstBlocking ?? draftOps[0])?.opId ?? null)
  }, [draft, draftIdentity, draftOps])

  if (detailQuery.isLoading) return <LoadingState />
  if (detailQuery.isError) return <ErrorBanner error={detailQuery.error} />
  if (detail === undefined) return null
  const selectedOp = draftOps.find((op) => op.opId === selectedOpId) ?? draftOps[0] ?? null
  // tempRef → proposed name, so previews can label bundle-internal references.
  const bundleNames = new Map(
    draftOps
      .filter((op) => 'tempRef' in op && typeof op.tempRef === 'string')
      .map((op) => [
        String('tempRef' in op ? op.tempRef : ''),
        String(
          (op.payload as { name?: string } | undefined)?.name ??
            String('tempRef' in op ? op.tempRef : ''),
        ),
      ]),
  )
  const buildPanelIds = tabDomIds('intent-workspace', 'build')
  const reviewPanelIds = tabDomIds('intent-workspace', 'review')
  const actionError =
    updateStatus.error ??
    cancelTurn.error ??
    retryTurn.error ??
    rebase.error ??
    unmount.error ??
    sendAnswers.error

  return (
    <div className="page intent-session-page">
      <PageHeader
        className="intent-session__header"
        title={detail.session.title}
        headingLevel={1}
        actions={
          <>
            {canEdit && detail.session.inFlight ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => cancelTurn.mutate()}
                disabled={cancelTurn.isPending}
              >
                {t('intent.cancelTurn')}
              </button>
            ) : null}
            {canEdit && detail.session.journey.reason === 'draft-stale' ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => rebase.mutate()}
                disabled={detail.session.inFlight || rebase.isPending}
              >
                {t('intent.rebase')}
              </button>
            ) : null}
            {canManageLifecycle ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  updateStatus.mutate(detail.session.status === 'archived' ? 'reopen' : 'archive')
                }
                disabled={updateStatus.isPending || detail.session.inFlight}
              >
                {detail.session.status === 'archived'
                  ? t('intent.reopenAction')
                  : t('intent.archiveAction')}
              </button>
            ) : null}
          </>
        }
      />

      {actionError !== null ? <ErrorBanner error={actionError} /> : null}

      <IntentJourneyProgress detail={detail} />

      {isAuditView ? <NoticeBanner tone="info">{t('intent.auditReadOnly')}</NoticeBanner> : null}
      {detail.session.status === 'archived' ? (
        <NoticeBanner tone="info">{t('intent.archivedReadOnly')}</NoticeBanner>
      ) : null}

      <TabBar<WorkspaceTab>
        className="intent-session__mobile-tabs"
        tabs={[
          { key: 'build', label: t('intent.buildWorkspace') },
          draft !== null && draft.validation.errors.length > 0
            ? {
                key: 'review',
                label: t('intent.reviewWorkspace'),
                badge: draft.validation.errors.length,
                badgeTone: 'danger' as const,
                badgeAriaLabel: t('intent.blockingErrors', {
                  count: draft.validation.errors.length,
                }),
              }
            : { key: 'review', label: t('intent.reviewWorkspace') },
        ]}
        active={workspaceTab}
        onSelect={setWorkspaceTab}
        variant="segment"
        ariaLabel={t('intent.workspaceTabs')}
        idPrefix="intent-workspace"
      />

      <div className="intent-session__workspace">
        <section
          className="intent-session__conversation"
          aria-labelledby="intent-conversation-heading"
          id={buildPanelIds.panelId}
          role="tabpanel"
          data-mobile-active={workspaceTab === 'build'}
          data-testid="intent-build-workspace"
        >
          <header className="intent-session__section-header">
            <div>
              <span className="intent-session__eyebrow">{t('intent.buildWorkspace')}</span>
              <h2 id="intent-conversation-heading">{t('intent.timeline')}</h2>
            </div>
            <StatusChip kind="neutral" size="sm">
              {t('intent.roundsCount', { count: detail.turns.length })}
            </StatusChip>
          </header>

          <div className="intent-session__timeline">
            {detail.turns.map((turn) => (
              <article
                key={turn.id}
                className={`card intent-turn-card intent-turn-card--${turn.role}`}
                data-testid={`intent-turn-${turn.kind}`}
              >
                <div className="card__meta">
                  <span>
                    {turn.role === 'user' ? t('intent.roleUser') : t('intent.roleAgent')} ·{' '}
                    {t(`intent.turnKind.${turn.kind}`)}
                  </span>
                  <RelativeTime ts={turn.createdAt} />
                </div>
                {turn.kind === 'message' ? <p>{String(turn.content.message ?? '')}</p> : null}
                {turn.kind === 'answers' ? (
                  <IntentAnswersTurn turn={turn} turns={detail.turns} />
                ) : null}
                {turn.kind === 'mount-approval' ? <IntentMountApprovalTurn turn={turn} /> : null}
                {turn.kind === 'changeset' ? (
                  <p>
                    {String(turn.content.summary ?? '')}{' '}
                    <StatusChip kind="info" size="sm">
                      {t('intent.opCount', { count: Number(turn.content.opCount ?? 0) })}
                    </StatusChip>
                  </p>
                ) : null}
                {turn.kind === 'questions' ? <IntentQuestionsTurn turn={turn} /> : null}
                {turn.kind === 'error' ? (
                  <IntentTurnError
                    turn={turn}
                    canRetry={canEdit && !detail.session.inFlight}
                    pending={retryTurn.isPending}
                    onRetry={() => retryTurn.mutate()}
                  />
                ) : null}
                {turn.role === 'agent' ? (
                  <IntentTurnSession
                    sessionId={sessionId}
                    turn={turn}
                    defaultOpen={turn.id === latestRunningTurnId}
                  />
                ) : null}
              </article>
            ))}
            {detail.session.inFlight ? <LoadingState label={t('intent.generating')} /> : null}
          </div>

          {detail.mountSuggestions !== null && canEdit ? (
            <IntentMountSuggestions
              sessionId={sessionId}
              batch={detail.mountSuggestions}
              turnSeq={detail.mountSuggestions.sourceTurnSeq}
              contextRevision={detail.mountSuggestions.contextRevision}
              disabled={detail.session.inFlight}
              onApplied={invalidate}
            />
          ) : null}
          {detail.mountSuggestions !== null && !canEdit ? (
            <NoticeBanner tone="info">
              {t('intent.mountSuggestionsReadOnly', {
                count: detail.mountSuggestions.items.length,
              })}
            </NoticeBanner>
          ) : null}

          {pendingQuestions.length > 0 && !detail.session.inFlight && canEdit ? (
            <section className="intent-session__questions" data-testid="intent-questions">
              <h3>{t('intent.answerQuestions')}</h3>
              {detail.mountSuggestions !== null ? (
                <p className="intent-session__question-gate">{t('intent.mountApprovalFirst')}</p>
              ) : null}
              {pendingQuestions.map((question) => (
                <Field key={question.id} label={question.question} required group>
                  <div
                    className="intent-question-options"
                    role="group"
                    aria-label={question.question}
                  >
                    {question.options.map((option) => {
                      const picked = answers[question.id] ?? []
                      const checked = picked.includes(option)
                      return (
                        <label key={option} className="intent-question-option">
                          <input
                            type={question.multiSelect ? 'checkbox' : 'radio'}
                            name={`intent-question-${question.id}`}
                            value={option}
                            checked={checked}
                            onChange={() =>
                              setAnswers((prev) => ({
                                ...prev,
                                [question.id]: question.multiSelect
                                  ? question.options.filter((candidate) =>
                                      candidate === option ? !checked : picked.includes(candidate),
                                    )
                                  : [option],
                              }))
                            }
                          />
                          <span>{option}</span>
                        </label>
                      )
                    })}
                  </div>
                </Field>
              ))}
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  sendAnswers.isPending ||
                  detail.mountSuggestions !== null ||
                  pendingQuestions.some((question) => (answers[question.id]?.length ?? 0) === 0)
                }
                onClick={() => sendAnswers.mutate()}
              >
                {t('intent.submitAnswers')}
              </button>
            </section>
          ) : null}

          <section className="intent-session__mounts" aria-labelledby="intent-mounts-heading">
            <header className="intent-session__subsection-header">
              <h3 id="intent-mounts-heading">{t('intent.mounts')}</h3>
              {canEdit ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  data-testid="intent-add-mount"
                  onClick={() => setMountOpen(true)}
                  disabled={detail.session.inFlight}
                >
                  {t('intent.addMount')}
                </button>
              ) : null}
            </header>
            {detail.mounts.length > 0 ? (
              <ul>
                {detail.mounts.map((mount) => (
                  <li key={mount.handle}>
                    <span className="intent-session__mount-copy">
                      <strong>{mount.displayName ?? t('intent.mountUnavailable')}</strong>
                      <span>
                        {t(`intent.resourceType.${mount.resourceType}`)} ·{' '}
                        <code>{mount.handle}</code>
                      </span>
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => unmount.mutate(mount.handle)}
                        disabled={detail.session.inFlight || unmount.isPending}
                      >
                        {t('intent.unmount')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {canEdit ? (
              <IntentMountDialog
                open={mountOpen}
                onClose={() => setMountOpen(false)}
                sessionId={sessionId}
                mounted={detail.mounts}
                onAdded={() => void invalidate()}
              />
            ) : null}
          </section>

          {canEdit ? (
            <section className="intent-session__composer">
              <Field label={t('intent.composerLabel')}>
                <TextArea
                  value={message}
                  onChange={setMessage}
                  rows={3}
                  placeholder={t('intent.composerPlaceholder')}
                  data-testid="intent-composer"
                />
              </Field>
              {sendMessage.isError ? <ErrorBanner error={sendMessage.error} /> : null}
              <div className="intent-session__composer-footer">
                <span>
                  {detail.mountSuggestions === null
                    ? t('intent.draftSafety')
                    : t('intent.mountApprovalFirst')}
                </span>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={
                    message.trim() === '' ||
                    sendMessage.isPending ||
                    detail.session.inFlight ||
                    detail.mountSuggestions !== null
                  }
                  onClick={() => sendMessage.mutate()}
                >
                  {t('intent.send')}
                </button>
              </div>
            </section>
          ) : null}
        </section>

        <aside
          className="intent-session__review"
          id={reviewPanelIds.panelId}
          role="tabpanel"
          aria-label={t('intent.reviewWorkspace')}
          data-mobile-active={workspaceTab === 'review'}
          data-testid="intent-review-workspace"
        >
          {draft === null ? <IntentReviewEmpty reason={detail.session.journey.reason} /> : null}
          {draft !== null ? (
            <div className="page__section intent-session__draft" data-testid="intent-draft">
              <header className="intent-session__section-header">
                <div>
                  <span className="intent-session__eyebrow">{t('intent.reviewWorkspace')}</span>
                  <h2>{t('intent.draftTitle', { revision: draft.revision })}</h2>
                </div>
                {draft.stale ? <StatusChip kind="warn">{t('intent.draftStale')}</StatusChip> : null}
              </header>
              {draft.stale ? (
                <NoticeBanner tone="warning">{t('intent.draftStaleNotice')}</NoticeBanner>
              ) : null}
              {draft.validation.errors.length > 0 ? (
                <NoticeBanner tone="error">
                  <p>{t('intent.blockingErrors', { count: draft.validation.errors.length })}</p>
                  <ul>
                    {draft.validation.errors.slice(0, 10).map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </NoticeBanner>
              ) : null}
              {draftOps.length > 0 ? (
                <div className="intent-session__op-browser">
                  <nav className="intent-session__op-outline" aria-label={t('intent.opOutline')}>
                    {draftOps.map((op) => {
                      const opErrors = draft.validation.errors.filter((error) =>
                        error.startsWith(`${op.opId}:`),
                      )
                      const name = String(
                        (op.payload as { name?: string } | undefined)?.name ?? op.opId,
                      )
                      return (
                        <button
                          key={op.opId}
                          type="button"
                          className={`intent-session__op-outline-item${
                            selectedOp?.opId === op.opId
                              ? ' intent-session__op-outline-item--active'
                              : ''
                          }`}
                          aria-current={selectedOp?.opId === op.opId ? 'true' : undefined}
                          onClick={() => setSelectedOpId(op.opId)}
                          data-testid="intent-op-outline-item"
                        >
                          <span className="intent-session__op-outline-title">
                            <StatusChip
                              kind={op.action === 'create' ? 'success' : 'info'}
                              size="sm"
                            >
                              {op.action === 'create' ? t('intent.opCreate') : t('intent.opUpdate')}
                            </StatusChip>
                            <strong>{name}</strong>
                          </span>
                          <span className="intent-session__op-outline-meta">
                            {t(`intent.resourceType.${op.resourceType}`)}
                            {opErrors.length > 0
                              ? ` · ${t('intent.opErrorsCount', { count: opErrors.length })}`
                              : ''}
                          </span>
                        </button>
                      )
                    })}
                  </nav>
                  {selectedOp !== null ? (
                    <div className="card intent-session__op-card" data-testid="intent-op-card">
                      <div className="card__meta">
                        <StatusChip
                          kind={selectedOp.action === 'create' ? 'success' : 'info'}
                          size="sm"
                        >
                          {selectedOp.action === 'create'
                            ? t('intent.opCreate')
                            : t('intent.opUpdate')}
                        </StatusChip>{' '}
                        <strong>{t(`intent.resourceType.${selectedOp.resourceType}`)}</strong> ·{' '}
                        {String((selectedOp.payload as { name?: string } | undefined)?.name ?? '')}
                      </div>
                      <IntentOpPreview
                        op={selectedOp}
                        mounts={detail.mounts}
                        bundleNames={bundleNames}
                        opErrors={draft.validation.errors.filter((error) =>
                          error.startsWith(`${selectedOp.opId}:`),
                        )}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {canEdit ? (
                <div className="intent-session__draft-actions">
                  <p>
                    {draft.stale
                      ? t('intent.commitDisabledStale')
                      : draft.validation.errors.length > 0
                        ? t('intent.commitDisabledValidation')
                        : detail.session.inFlight
                          ? t('intent.commitDisabledGenerating')
                          : t('intent.draftSafety')}
                  </p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={
                      draft.stale || draft.validation.errors.length > 0 || detail.session.inFlight
                    }
                    onClick={() => setCommitOpen(true)}
                    data-testid="intent-open-commit"
                  >
                    {t('intent.openCommit')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {detail.commits.length > 0 ? (
            <div className="page__section intent-session__commits">
              <header className="intent-session__section-header">
                <h2>{t('intent.commits')}</h2>
                <StatusChip kind="neutral" size="sm">
                  {t('intent.commitsCount', { count: detail.commits.length })}
                </StatusChip>
              </header>
              {detail.commits.map((commit) => (
                <div key={commit.journalId} className="card">
                  <div className="card__meta">
                    <StatusChip
                      kind={
                        commit.state === 'committed'
                          ? 'success'
                          : commit.state === 'failed'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {t(`intent.commitState.${commit.state}`)}
                    </StatusChip>
                    <RelativeTime ts={commit.createdAt} />
                  </div>
                  {commit.receipt !== null ? (
                    <ul>
                      {commit.receipt.applied.map((item) => (
                        <li key={item.opId}>
                          {t(`intent.resourceType.${item.resourceType}`)} · {item.name}
                          {item.fromCopy ? ` (${t('intent.fromCopy')})` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {commit.error !== null ? <p className="mono">{commit.error}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      {draft !== null && canEdit ? (
        <CommitDialog
          open={commitOpen}
          onClose={() => setCommitOpen(false)}
          sessionId={sessionId}
          draft={{ revision: draft.revision, draftHash: draft.draftHash, slots: draft.slots }}
          ops={draftOps}
          onCommitted={async () => {
            setCommitOpen(false)
            await invalidate()
          }}
        />
      ) : null}
    </div>
  )
}

type IntentTurn = IntentSessionDetail['turns'][number]

function IntentQuestionsTurn({ turn }: { turn: IntentTurn }) {
  const { t } = useTranslation()
  const parsed = IntentQuestionsSchema.safeParse(turn.content.questions)
  if (!parsed.success) return <p>{String(turn.content.summary ?? '')}</p>
  return (
    <div className="intent-turn-semantic">
      <p>{t('intent.questionsAsked', { count: parsed.data.length })}</p>
      <ul>
        {parsed.data.map((question) => (
          <li key={question.id}>{question.question}</li>
        ))}
      </ul>
    </div>
  )
}

function IntentAnswersTurn({ turn, turns }: { turn: IntentTurn; turns: IntentTurn[] }) {
  const { t } = useTranslation()
  const parsedAnswers = PostIntentAnswersSchema.safeParse({ answers: turn.content.answers })
  const source = [...turns]
    .reverse()
    .find(
      (candidate) =>
        candidate.seq < turn.seq && candidate.role === 'agent' && candidate.kind === 'questions',
    )
  const parsedQuestions = IntentQuestionsSchema.safeParse(source?.content.questions)
  const fallbackCount = Array.isArray(turn.content.answers) ? turn.content.answers.length : 0
  if (!parsedAnswers.success || !parsedQuestions.success) {
    return <p>{t('intent.answersSubmitted', { count: fallbackCount })}</p>
  }
  const questions = new Map(parsedQuestions.data.map((question) => [question.id, question]))
  return (
    <dl className="intent-turn-semantic intent-turn-answers">
      {parsedAnswers.data.answers.map((answer) => (
        <div key={answer.id}>
          <dt>{questions.get(answer.id)?.question ?? answer.id}</dt>
          <dd>
            {answer.picked.join(t('intent.answerSeparator'))}
            {answer.other === undefined ? null : ` · ${answer.other}`}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function IntentMountApprovalTurn({ turn }: { turn: IntentTurn }) {
  const { t } = useTranslation()
  const parsed = IntentMountApprovalReceiptSchema.safeParse(turn.content)
  if (!parsed.success) return <p>{t('intent.mountApprovalSubmitted')}</p>
  return (
    <div className="intent-turn-semantic intent-turn-mount-receipt">
      {parsed.data.approved.length > 0 ? (
        <div>
          <strong>{t('intent.mountApproved')}</strong>
          <ul>
            {parsed.data.approved.map((item) => (
              <li key={`${item.resourceType}:${item.resourceId}`}>
                {item.name} · {t(`intent.resourceType.${item.resourceType}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {parsed.data.rejected.length > 0 ? (
        <div>
          <strong>{t('intent.mountRejected')}</strong>
          <ul>
            {parsed.data.rejected.map((item) => (
              <li key={`${item.resourceType}:${item.name}`}>
                {item.name} · {t(`intent.resourceType.${item.resourceType}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

interface MountSuggestionDecisionDraft {
  action: 'approve' | 'reject'
  resourceId: string
}

function mountSuggestionKey(item: IntentMountSuggestionBatch['items'][number]): string {
  return `${item.resourceType}\u0000${item.name}`
}

function IntentMountSuggestions(props: {
  sessionId: string
  batch: IntentMountSuggestionBatch
  turnSeq: number
  contextRevision: number
  disabled: boolean
  onApplied: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const [decisions, setDecisions] = useState<Record<string, MountSuggestionDecisionDraft>>({})
  const initializedSourceRef = useRef<string | null>(null)

  useEffect(() => {
    if (initializedSourceRef.current === props.batch.sourceTurnId) return
    initializedSourceRef.current = props.batch.sourceTurnId
    setDecisions(
      Object.fromEntries(
        props.batch.items.map((item) => [
          mountSuggestionKey(item),
          item.candidates.length === 0
            ? { action: 'reject' as const, resourceId: '' }
            : {
                action: 'approve' as const,
                resourceId: item.candidates.length === 1 ? item.candidates[0]!.resourceId : '',
              },
        ]),
      ),
    )
  }, [props.batch.items, props.batch.sourceTurnId])

  const incomplete = props.batch.items.some((item) => {
    const decision = decisions[mountSuggestionKey(item)]
    return decision === undefined || (decision.action === 'approve' && decision.resourceId === '')
  })
  const apply = useMutation({
    mutationFn: async () =>
      IntentMountApprovalReceiptSchema.parse(
        await api.post<unknown>(`/api/intent-sessions/${props.sessionId}/mount-approvals`, {
          sourceTurnId: props.batch.sourceTurnId,
          expectedTurnSeq: props.turnSeq,
          expectedContextRevision: props.contextRevision,
          decisions: props.batch.items.map((item) => {
            const decision = decisions[mountSuggestionKey(item)]!
            return decision.action === 'approve'
              ? {
                  resourceType: item.resourceType,
                  name: item.name,
                  action: 'approve' as const,
                  resourceId: decision.resourceId,
                }
              : {
                  resourceType: item.resourceType,
                  name: item.name,
                  action: 'reject' as const,
                }
          }),
        }),
      ),
    onSuccess: () => props.onApplied(),
  })

  return (
    <section className="intent-session__mount-suggestions" data-testid="intent-mount-suggestions">
      <div>
        <h3>{t('intent.mountSuggestionsTitle')}</h3>
        <p>{t('intent.mountSuggestionsDescription')}</p>
      </div>
      <div className="intent-session__mount-suggestion-list">
        {props.batch.items.map((item) => {
          const key = mountSuggestionKey(item)
          const decision = decisions[key] ?? { action: 'reject', resourceId: '' }
          return (
            <article key={key} className="intent-session__mount-suggestion">
              <div className="intent-session__mount-suggestion-heading">
                <div>
                  <strong>{item.name}</strong>
                  <span>{t(`intent.resourceType.${item.resourceType}`)}</span>
                </div>
                <Segmented
                  ariaLabel={t('intent.mountDecisionFor', { name: item.name })}
                  value={decision.action}
                  onChange={(action) =>
                    setDecisions((current) => ({
                      ...current,
                      [key]: {
                        action: action === 'approve' ? 'approve' : 'reject',
                        resourceId:
                          action === 'approve' && item.candidates.length === 1
                            ? item.candidates[0]!.resourceId
                            : (current[key]?.resourceId ?? ''),
                      },
                    }))
                  }
                  options={[
                    {
                      value: 'approve',
                      label: t('intent.mountApprove'),
                      disabled: item.candidates.length === 0,
                    },
                    { value: 'reject', label: t('intent.mountReject') },
                  ]}
                  disabled={props.disabled || apply.isPending}
                />
              </div>
              {item.reason === null ? null : <p>{item.reason}</p>}
              {item.candidates.length === 0 ? (
                <NoticeBanner tone="warning">{t('intent.mountCandidateUnavailable')}</NoticeBanner>
              ) : null}
              {decision.action === 'approve' && item.candidates.length === 1 ? (
                <div className="intent-session__mount-candidate">
                  <strong>{item.candidates[0]!.name}</strong>
                  {item.candidates[0]!.description === null ? null : (
                    <span>{item.candidates[0]!.description}</span>
                  )}
                </div>
              ) : null}
              {decision.action === 'approve' && item.candidates.length > 1 ? (
                <Field label={t('intent.mountCandidateLabel')} required>
                  <Select
                    value={decision.resourceId}
                    onChange={(resourceId) =>
                      setDecisions((current) => ({
                        ...current,
                        [key]: { action: 'approve', resourceId },
                      }))
                    }
                    ariaLabel={t('intent.mountCandidateFor', { name: item.name })}
                    options={[
                      {
                        value: '',
                        label: t('intent.mountCandidatePlaceholder'),
                        disabled: true,
                      },
                      ...item.candidates.map((candidate) => ({
                        value: candidate.resourceId,
                        label: candidate.name,
                        description: candidate.description ?? undefined,
                      })),
                    ]}
                    disabled={props.disabled || apply.isPending}
                  />
                </Field>
              ) : null}
            </article>
          )
        })}
      </div>
      {apply.isError ? <ErrorBanner error={apply.error} /> : null}
      <div className="intent-session__mount-suggestion-footer">
        <span>{t('intent.mountBatchAtomic')}</span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={props.disabled || apply.isPending || incomplete}
          onClick={() => apply.mutate()}
        >
          {t('intent.mountDecisionSubmit')}
        </button>
      </div>
    </section>
  )
}

function IntentReviewEmpty({
  reason,
}: {
  reason: IntentSessionDetail['session']['journey']['reason']
}) {
  const { t } = useTranslation()
  const state =
    reason === 'generation-running'
      ? 'generating'
      : reason === 'answer-questions'
        ? 'clarifying'
        : reason === 'generation-failed' || reason === 'apply-failed'
          ? 'error'
          : reason === 'applied'
            ? 'applied'
            : reason === 'archived'
              ? 'archived'
              : 'goal'
  return (
    <div className="page__section intent-session__draft-empty">
      <span className="intent-session__draft-empty-mark" aria-hidden="true">
        {state === 'generating' ? '···' : state === 'error' ? '!' : state === 'applied' ? '✓' : '✦'}
      </span>
      <div>
        <h2>{t(`intent.draftEmptyState.${state}.title`)}</h2>
        <p>{t(`intent.draftEmptyState.${state}.description`)}</p>
      </div>
    </div>
  )
}

function IntentTurnError(props: {
  turn: IntentSessionDetail['turns'][number]
  canRetry: boolean
  pending: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const diagnostic = intentFailureDiagnostic(props.turn, t)
  return (
    <div className="intent-turn-error" data-testid="intent-turn-error-diagnostic">
      <div className="intent-turn-error__heading">
        <StatusChip kind="danger">{String(props.turn.content.code ?? 'error')}</StatusChip>
        <strong>{diagnostic.title}</strong>
      </div>
      <p>{diagnostic.suggestion}</p>
      {diagnostic.evidence.length > 0 ? (
        <ul className="intent-turn-error__evidence mono">
          {diagnostic.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {diagnostic.scratchNotice === null ? null : (
        <NoticeBanner tone="info">{diagnostic.scratchNotice}</NoticeBanner>
      )}
      {props.canRetry ? (
        <button
          type="button"
          className="btn btn--xs"
          onClick={props.onRetry}
          disabled={props.pending}
        >
          {t('intent.retryTurn')}
        </button>
      ) : null}
    </div>
  )
}

function CommitDialog(props: {
  open: boolean
  onClose: () => void
  sessionId: string
  draft: { revision: number; draftHash: string; slots: IntentSlotDto[] }
  ops: IntentChangeset['ops']
  onCommitted: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  const [applyModes, setApplyModes] = useState<Record<string, 'modify' | 'copy'>>({})
  const [humanPicks, setHumanPicks] = useState<Record<string, UserPublic[]>>({})
  const clientMutationIdRef = useRef<string | null>(null)
  const opsById = useMemo(() => new Map(props.ops.map((op) => [op.opId, op])), [props.ops])
  const updateOps = useMemo(
    () => props.ops.filter((op) => op.action === 'update').map((op) => op.opId),
    [props.ops],
  )
  const operationLabel = (opId: string): string => {
    const op = opsById.get(opId)
    if (op === undefined) return opId
    const proposedName = op.payload.name.trim() || opId
    return `${proposedName} · ${t(`intent.resourceType.${op.resourceType}`)}`
  }
  const operationRelativePointer = (opId: string, jsonPointer: string): string => {
    const payloadPrefix = `/${opId}/payload`
    if (jsonPointer === payloadPrefix) return '/'
    return jsonPointer.startsWith(`${payloadPrefix}/`)
      ? jsonPointer.slice(payloadPrefix.length)
      : jsonPointer
  }
  useEffect(() => {
    if (props.open && clientMutationIdRef.current === null) clientMutationIdRef.current = ulid()
    if (props.open) return
    clientMutationIdRef.current = null
    setStep(0)
    setSlotValues({})
    setApplyModes({})
    setHumanPicks({})
  }, [props.open])
  useEffect(() => {
    if (!props.open) return
    const frame = requestAnimationFrame(() => stepHeadingRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [props.open, step])

  const commit = useMutation<unknown, ApiError, void>({
    mutationFn: () => {
      const clientMutationId = clientMutationIdRef.current
      if (clientMutationId === null)
        throw new Error('commit dialog mutation identity is unavailable')
      const byOp = new Map<string, Array<{ slotId: string; value: string }>>()
      for (const slot of props.draft.slots) {
        let value: string | undefined
        if (slot.kind === 'humanBinding') {
          value = humanPicks[slot.slotId]?.[0]?.id
        } else if (slot.kind === 'secretWaiver') {
          value = slotValues[slot.slotId] === 'waived' ? 'waived' : undefined
        } else {
          const raw = slotValues[slot.slotId]
          value = raw === undefined || raw === '' ? undefined : raw
        }
        if (value === undefined) continue
        const list = byOp.get(slot.opId) ?? []
        list.push({ slotId: slot.slotId, value })
        byOp.set(slot.opId, list)
      }
      const opIds = new Set([...byOp.keys(), ...updateOps])
      const decisions = [...opIds].map((opId) => ({
        opId,
        ...(updateOps.includes(opId) ? { applyMode: applyModes[opId] ?? 'modify' } : {}),
        ...(byOp.has(opId) ? { slots: byOp.get(opId) } : {}),
      }))
      return api.post(`/api/intent-sessions/${props.sessionId}/commit`, {
        // Minted once per dialog-open lifecycle. A response-loss retry must
        // replay the same journal identity instead of starting a second apply.
        clientMutationId,
        draftRevision: props.draft.revision,
        draftHash: props.draft.draftHash,
        decisions,
      })
    },
    onSuccess: () => props.onCommitted(),
  })

  const secretSlots = props.draft.slots.filter((slot) => slot.kind === 'secret')
  const waiverSlots = props.draft.slots.filter((slot) => slot.kind === 'secretWaiver')
  const humanSlots = props.draft.slots.filter((slot) => slot.kind === 'humanBinding')
  const nameSlots = props.draft.slots.filter((slot) => slot.kind === 'finalName')
  const requiredDetailsMissing =
    secretSlots.some((slot) => (slotValues[slot.slotId] ?? '').trim() === '') ||
    waiverSlots.some((slot) => slotValues[slot.slotId] !== 'waived')
  const detailsCount = props.draft.slots.length
  const pendingGuardDirtyRef = useRef<string | null>(null)
  const pendingGuardBusyRef = useRef(false)
  pendingGuardDirtyRef.current = commit.isPending
    ? `intent-commit:${clientMutationIdRef.current ?? 'pending'}`
    : null
  pendingGuardBusyRef.current = commit.isPending
  const close = () => {
    if (commit.isPending) return
    commit.reset()
    props.onClose()
  }

  return (
    <>
      <UnsavedChangesGuard
        dirtyRef={pendingGuardDirtyRef}
        busyRef={pendingGuardBusyRef}
        copyKeys={{
          title: 'intent.commitGuard.title',
          busyBody: 'intent.commitGuard.busyBody',
          stay: 'intent.commitGuard.stay',
        }}
      />
      <Dialog
        open={props.open}
        onClose={close}
        title={t('intent.commitTitle')}
        size="lg"
        dismissDisabled={commit.isPending}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={commit.isPending}>
              {t('common.cancel')}
            </button>
            {step > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => setStep((step - 1) as 0 | 1)}
                disabled={commit.isPending}
              >
                {t('intent.commitBack')}
              </button>
            ) : null}
            {step < 2 ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={commit.isPending || (step === 1 && requiredDetailsMissing)}
                onClick={() => setStep((step + 1) as 1 | 2)}
                data-testid="intent-commit-next"
              >
                {t('intent.commitNext')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={commit.isPending || requiredDetailsMissing}
                onClick={() => commit.mutate()}
                data-testid="intent-commit-submit"
              >
                {commit.isPending ? t('intent.commitPending') : t('intent.commitSubmit')}
              </button>
            )}
          </>
        }
      >
        <ol className="intent-commit-stepper" aria-label={t('intent.commitStepsAria')}>
          {(['strategy', 'details', 'review'] as const).map((key, index) => (
            <li
              key={key}
              className={
                index === step
                  ? 'intent-commit-stepper__step intent-commit-stepper__step--current'
                  : index < step
                    ? 'intent-commit-stepper__step intent-commit-stepper__step--done'
                    : 'intent-commit-stepper__step'
              }
              aria-current={index === step ? 'step' : undefined}
            >
              <span>{index < step ? '✓' : index + 1}</span>
              {t(`intent.commitStep.${key}`)}
            </li>
          ))}
        </ol>
        <h3
          ref={stepHeadingRef}
          className="sr-only"
          tabIndex={-1}
          data-testid="intent-commit-step-heading"
        >
          {t(`intent.commitStep.${(['strategy', 'details', 'review'] as const)[step]}`)}
        </h3>
        {commit.isError ? <ErrorBanner error={commit.error} /> : null}
        {step === 0 && updateOps.length > 0 ? (
          <div className="page__section">
            <h3>{t('intent.applyModeTitle')}</h3>
            {updateOps.map((opId) => (
              <Field key={opId} label={operationLabel(opId)} hint={t('intent.applyModeHint')} group>
                <Segmented
                  ariaLabel={`${operationLabel(opId)} · ${t('intent.applyModeTitle')}`}
                  value={applyModes[opId] ?? 'modify'}
                  onChange={(mode) =>
                    setApplyModes((prev) => ({
                      ...prev,
                      [opId]: mode === 'copy' ? 'copy' : 'modify',
                    }))
                  }
                  options={[
                    { value: 'modify', label: t('intent.applyModify') },
                    { value: 'copy', label: t('intent.applyCopy') },
                  ]}
                />
              </Field>
            ))}
          </div>
        ) : null}
        {step === 0 && updateOps.length === 0 ? (
          <NoticeBanner tone="info">{t('intent.commitStrategyCreateOnly')}</NoticeBanner>
        ) : null}
        {step === 1 && detailsCount === 0 ? (
          <NoticeBanner tone="info">{t('intent.commitDetailsNone')}</NoticeBanner>
        ) : null}
        {step === 1 && secretSlots.length > 0 ? (
          <div className="page__section">
            <h3>{t('intent.secretsTitle')}</h3>
            {secretSlots.map((slot) => (
              <Field
                key={slot.slotId}
                label={`${operationLabel(slot.opId)} · ${slot.jsonPointer}`}
                required
              >
                <TextInput
                  value={slotValues[slot.slotId] ?? ''}
                  onChange={(value) => setSlotValues((prev) => ({ ...prev, [slot.slotId]: value }))}
                  type="password"
                  placeholder={t('intent.secretPlaceholder')}
                />
              </Field>
            ))}
          </div>
        ) : null}
        {step === 1 && waiverSlots.length > 0 ? (
          <div className="page__section">
            <h3>{t('intent.waiversTitle')}</h3>
            <div className="form-grid">
              {waiverSlots.map((slot) => (
                <Checkbox
                  key={slot.slotId}
                  checked={slotValues[slot.slotId] === 'waived'}
                  onChange={(checked) =>
                    setSlotValues((prev) => ({
                      ...prev,
                      [slot.slotId]: checked ? 'waived' : '',
                    }))
                  }
                  label={`${operationLabel(slot.opId)} · ${t('intent.waiverLabel')}`}
                  hint={operationRelativePointer(slot.opId, slot.jsonPointer)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {step === 1 && humanSlots.length > 0 ? (
          <div className="page__section">
            <h3>{t('intent.humansTitle')}</h3>
            {humanSlots.map((slot) => (
              <Field
                key={slot.slotId}
                label={t('intent.humanLabel', { name: slot.displayName })}
                hint={`${operationLabel(slot.opId)} · ${t('intent.humanHint')}`}
              >
                <UserPicker
                  value={humanPicks[slot.slotId] ?? []}
                  onChange={(next) =>
                    setHumanPicks((prev) => ({ ...prev, [slot.slotId]: next.slice(-1) }))
                  }
                  single
                />
              </Field>
            ))}
          </div>
        ) : null}
        {step === 1 && nameSlots.length > 0 ? (
          <div className="page__section">
            <h3>{t('intent.namesTitle')}</h3>
            {nameSlots.map((slot) => (
              <Field
                key={slot.slotId}
                label={operationLabel(slot.opId)}
                hint={t('intent.nameHint')}
              >
                <TextInput
                  value={slotValues[slot.slotId] ?? ''}
                  onChange={(value) => setSlotValues((prev) => ({ ...prev, [slot.slotId]: value }))}
                  placeholder={t('intent.namePlaceholder')}
                />
              </Field>
            ))}
          </div>
        ) : null}
        {step === 2 ? (
          <div className="intent-commit-review" data-testid="intent-commit-review">
            <NoticeBanner tone="info">{t('intent.commitReviewSafety')}</NoticeBanner>
            <dl className="intent-commit-review__summary">
              <div>
                <dt>{t('intent.commitReviewResources')}</dt>
                <dd>{props.ops.length}</dd>
              </div>
              <div>
                <dt>{t('intent.commitReviewUpdates')}</dt>
                <dd>{updateOps.length}</dd>
              </div>
              <div>
                <dt>{t('intent.commitReviewDetails')}</dt>
                <dd>{detailsCount}</dd>
              </div>
            </dl>
            {updateOps.length > 0 ? (
              <section>
                <h3>{t('intent.applyModeTitle')}</h3>
                <ul className="intent-commit-review__list">
                  {updateOps.map((opId) => (
                    <li key={opId}>
                      <span>
                        {operationLabel(opId)} <code>{opId}</code>
                      </span>
                      <span>
                        {applyModes[opId] === 'copy'
                          ? t('intent.applyCopy')
                          : t('intent.applyModify')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {detailsCount > 0 ? (
              <section>
                <h3>{t('intent.commitReviewDetailStatus')}</h3>
                <ul className="intent-commit-review__list">
                  {props.draft.slots.map((slot) => {
                    const required = slot.kind === 'secret' || slot.kind === 'secretWaiver'
                    const complete =
                      slot.kind === 'humanBinding'
                        ? (humanPicks[slot.slotId]?.length ?? 0) > 0
                        : slot.kind === 'secretWaiver'
                          ? slotValues[slot.slotId] === 'waived'
                          : slot.kind === 'finalName'
                            ? (slotValues[slot.slotId] ?? '').trim() !== ''
                            : (slotValues[slot.slotId] ?? '').trim() !== ''
                    return (
                      <li key={slot.slotId}>
                        <span>
                          {t(`intent.commitSlotKind.${slot.kind}`)} · {operationLabel(slot.opId)}{' '}
                          <code>{slot.opId}</code>
                        </span>
                        <StatusChip
                          kind={complete ? 'success' : required ? 'danger' : 'neutral'}
                          size="sm"
                        >
                          {complete
                            ? t('intent.commitDetailProvided')
                            : required
                              ? t('intent.commitDetailRequired')
                              : t('intent.commitDetailDefault')}
                        </StatusChip>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
