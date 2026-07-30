// RFC-234 (T8) — intent session detail: conversation timeline (messages /
// structured questions / changeset summaries / retryable errors), composer,
// mounted working-set, the current-draft panel (per-op cards + validation +
// stale banner) and the commit dialog (server-issued slots: finalName /
// secret / waiver / humanBinding + per-update modify-vs-copy choice).

import type { IntentSessionDetail, IntentSlotDto, UserPublic } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ulid } from 'ulid'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { IntentMountDialog } from '@/components/IntentMountDialog'
import {
  deriveIntentJourneyState,
  IntentJourneyProgress,
  IntentStageStatus,
} from '@/components/intent/IntentJourneyProgress'
import { IntentOpPreview } from '@/components/intent/IntentOpPreview'
import { IntentTurnSession } from '@/components/intent/IntentTurnSession'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { RelativeTime } from '@/components/RelativeTime'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { UserPicker } from '@/components/UserPicker'
import { INTENT_QUERY_KEYS, useIntentSessionsWs } from '@/hooks/useIntentSessionsWs'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/intent/$sessionId',
  component: IntentSessionDetailPage,
})

interface QuestionDraft {
  [questionId: string]: string[]
}

function IntentSessionDetailPage() {
  const { t } = useTranslation()
  const { sessionId } = Route.useParams()
  const qc = useQueryClient()
  useIntentSessionsWs()

  const detailQuery = useQuery<IntentSessionDetail, ApiError>({
    queryKey: INTENT_QUERY_KEYS.detail(sessionId),
    queryFn: () => api.get<IntentSessionDetail>(`/api/intent-sessions/${sessionId}`),
    refetchInterval: (query) => (query.state.data?.session.inFlight === true ? 1500 : false),
  })
  const detail = detailQuery.data

  const [message, setMessage] = useState('')
  const [answers, setAnswers] = useState<QuestionDraft>({})
  const [commitOpen, setCommitOpen] = useState(false)
  const [mountOpen, setMountOpen] = useState(false)

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
  const rebase = useMutation<unknown, ApiError, void>({
    mutationFn: () => api.post(`/api/intent-sessions/${sessionId}/rebase`),
    onSuccess: invalidate,
  })
  const unmount = useMutation<unknown, ApiError, string>({
    mutationFn: (handle) =>
      api.delete(`/api/intent-sessions/${sessionId}/mounts/${encodeURIComponent(handle)}`),
    onSuccess: invalidate,
  })

  const lastAgentTurn = useMemo(
    () => [...(detail?.turns ?? [])].reverse().find((turn) => turn.role === 'agent'),
    [detail?.turns],
  )
  const pendingQuestions =
    lastAgentTurn?.kind === 'questions'
      ? ((lastAgentTurn.content.questions as Array<{
          id: string
          question: string
          options: string[]
          multiSelect: boolean
        }>) ?? [])
      : []
  const latestRunningTurnId = lastAgentTurn?.kind === 'running' ? lastAgentTurn.id : null

  if (detailQuery.isLoading) return <LoadingState />
  if (detailQuery.isError) return <ErrorBanner error={detailQuery.error} />
  if (detail === undefined) return null
  const draft = detail.currentDraft
  const journeyState = deriveIntentJourneyState(detail)
  const draftOps =
    draft === null ? [] : ((draft.changeset as { ops?: Array<Record<string, unknown>> }).ops ?? [])
  // tempRef → proposed name, so previews can label bundle-internal references.
  const bundleNames = new Map(
    draftOps
      .filter((op) => typeof op.tempRef === 'string')
      .map((op) => [
        String(op.tempRef),
        String((op.payload as { name?: string } | undefined)?.name ?? String(op.tempRef)),
      ]),
  )

  return (
    <div className="page intent-session-page">
      <PageHeader
        className="intent-session__header"
        title={detail.session.title}
        headingLevel={1}
        meta={
          detail.session.status === 'archived' ? (
            <StatusChip kind="neutral">{t('intent.statusArchived')}</StatusChip>
          ) : (
            <IntentStageStatus state={journeyState} data-testid="intent-stage-status" />
          )
        }
        actions={
          <>
            {detail.session.inFlight ? (
              <button type="button" className="btn btn--sm" onClick={() => cancelTurn.mutate()}>
                {t('intent.cancelTurn')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => rebase.mutate()}
              disabled={detail.session.inFlight}
            >
              {t('intent.rebase')}
            </button>
          </>
        }
      />

      <IntentJourneyProgress detail={detail} />

      <div className="intent-session__workspace">
        <section
          className="intent-session__conversation"
          aria-labelledby="intent-conversation-heading"
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
                  <pre className="mono">{JSON.stringify(turn.content.answers, null, 2)}</pre>
                ) : null}
                {turn.kind === 'changeset' ? (
                  <p>
                    {String(turn.content.summary ?? '')}{' '}
                    <StatusChip kind="info" size="sm">
                      {t('intent.opCount', { count: Number(turn.content.opCount ?? 0) })}
                    </StatusChip>
                  </p>
                ) : null}
                {turn.kind === 'questions' ? <p>{String(turn.content.summary ?? '')}</p> : null}
                {turn.kind === 'error' ? (
                  <div>
                    <StatusChip kind="danger">{String(turn.content.code ?? 'error')}</StatusChip>{' '}
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => retryTurn.mutate()}
                      disabled={detail.session.inFlight}
                    >
                      {t('intent.retryTurn')}
                    </button>
                  </div>
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

          {pendingQuestions.length > 0 && !detail.session.inFlight ? (
            <section className="intent-session__questions" data-testid="intent-questions">
              <h3>{t('intent.answerQuestions')}</h3>
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
              <button
                type="button"
                className="btn btn--sm"
                data-testid="intent-add-mount"
                onClick={() => setMountOpen(true)}
                disabled={detail.session.inFlight || detail.session.status === 'archived'}
              >
                {t('intent.addMount')}
              </button>
            </header>
            {detail.mounts.length > 0 ? (
              <ul>
                {detail.mounts.map((mount) => (
                  <li key={mount.handle}>
                    <code>{mount.handle}</code> · {t(`intent.resourceType.${mount.resourceType}`)}{' '}
                    <button
                      type="button"
                      className="btn btn--xs"
                      onClick={() => unmount.mutate(mount.handle)}
                      disabled={detail.session.inFlight}
                    >
                      {t('intent.unmount')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <IntentMountDialog
              open={mountOpen}
              onClose={() => setMountOpen(false)}
              sessionId={sessionId}
              mounted={detail.mounts}
              onAdded={() => void invalidate()}
            />
          </section>

          {detail.session.status === 'active' ? (
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
                <span>{t('intent.draftSafety')}</span>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={
                    message.trim() === '' || sendMessage.isPending || detail.session.inFlight
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
          aria-label={t('intent.reviewWorkspace')}
          data-testid="intent-review-workspace"
        >
          {draft === null ? (
            <div className="page__section intent-session__draft-empty">
              <span className="intent-session__draft-empty-mark" aria-hidden="true">
                ✦
              </span>
              <div>
                <h2>{t('intent.draftPendingTitle')}</h2>
                <p>{t('intent.draftPendingDescription')}</p>
              </div>
            </div>
          ) : null}
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
              {draftOps.map((op) => (
                <div
                  key={String(op.opId)}
                  className="card intent-session__op-card"
                  data-testid="intent-op-card"
                >
                  <div className="card__meta">
                    <StatusChip kind={op.action === 'create' ? 'success' : 'info'} size="sm">
                      {op.action === 'create' ? t('intent.opCreate') : t('intent.opUpdate')}
                    </StatusChip>{' '}
                    <strong>{t(`intent.resourceType.${String(op.resourceType)}`)}</strong> ·{' '}
                    {String((op.payload as { name?: string } | undefined)?.name ?? '')}
                  </div>
                  <IntentOpPreview
                    op={op}
                    mounts={detail.mounts}
                    bundleNames={bundleNames}
                    opErrors={draft.validation.errors.filter((error) =>
                      error.startsWith(`${String(op.opId)}:`),
                    )}
                  />
                </div>
              ))}
              <div className="intent-session__draft-actions">
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

      {draft !== null ? (
        <CommitDialog
          open={commitOpen}
          onClose={() => setCommitOpen(false)}
          sessionId={sessionId}
          draft={{ revision: draft.revision, draftHash: draft.draftHash, slots: draft.slots }}
          updateOps={((draft.changeset as { ops?: Array<Record<string, unknown>> }).ops ?? [])
            .filter((op) => op.action === 'update')
            .map((op) => String(op.opId))}
          onCommitted={async () => {
            setCommitOpen(false)
            await invalidate()
          }}
        />
      ) : null}
    </div>
  )
}

function CommitDialog(props: {
  open: boolean
  onClose: () => void
  sessionId: string
  draft: { revision: number; draftHash: string; slots: IntentSlotDto[] }
  updateOps: string[]
  onCommitted: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  const [applyModes, setApplyModes] = useState<Record<string, 'modify' | 'copy'>>({})
  const [humanPicks, setHumanPicks] = useState<Record<string, UserPublic[]>>({})
  useEffect(() => {
    if (!props.open) {
      setSlotValues({})
      setApplyModes({})
      setHumanPicks({})
    }
  }, [props.open])

  const commit = useMutation<unknown, ApiError, void>({
    mutationFn: () => {
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
      const opIds = new Set([...byOp.keys(), ...props.updateOps])
      const decisions = [...opIds].map((opId) => ({
        opId,
        ...(props.updateOps.includes(opId) ? { applyMode: applyModes[opId] ?? 'modify' } : {}),
        ...(byOp.has(opId) ? { slots: byOp.get(opId) } : {}),
      }))
      return api.post(`/api/intent-sessions/${props.sessionId}/commit`, {
        // Downstream update appliers reuse this id at their canonical mutation
        // fences, which require a real ULID (not merely 26 Crockford chars).
        clientMutationId: ulid(),
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
  const secretsMissing = secretSlots.some((slot) => (slotValues[slot.slotId] ?? '').trim() === '')

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('intent.commitTitle')}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={commit.isPending || secretsMissing}
            onClick={() => commit.mutate()}
            data-testid="intent-commit-submit"
          >
            {t('intent.commitSubmit')}
          </button>
        </>
      }
    >
      {commit.isError ? <ErrorBanner error={commit.error} /> : null}
      {props.updateOps.length > 0 ? (
        <div className="page__section">
          <h3>{t('intent.applyModeTitle')}</h3>
          {props.updateOps.map((opId) => (
            <Field key={opId} label={opId} hint={t('intent.applyModeHint')}>
              <Segmented
                ariaLabel={t('intent.applyModeTitle')}
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
      {secretSlots.length > 0 ? (
        <div className="page__section">
          <h3>{t('intent.secretsTitle')}</h3>
          {secretSlots.map((slot) => (
            <Field key={slot.slotId} label={`${slot.opId} · ${slot.jsonPointer}`} required>
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
      {waiverSlots.length > 0 ? (
        <div className="page__section">
          <h3>{t('intent.waiversTitle')}</h3>
          {waiverSlots.map((slot) => (
            <label key={slot.slotId} className="checkbox-row">
              <input
                type="checkbox"
                checked={slotValues[slot.slotId] === 'waived'}
                onChange={(event) =>
                  setSlotValues((prev) => ({
                    ...prev,
                    [slot.slotId]: event.target.checked ? 'waived' : '',
                  }))
                }
              />
              <span>
                {t('intent.waiverLabel')} <code>{slot.jsonPointer}</code>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {humanSlots.length > 0 ? (
        <div className="page__section">
          <h3>{t('intent.humansTitle')}</h3>
          {humanSlots.map((slot) => (
            <Field
              key={slot.slotId}
              label={t('intent.humanLabel', { name: slot.displayName })}
              hint={t('intent.humanHint')}
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
      {nameSlots.length > 0 ? (
        <div className="page__section">
          <h3>{t('intent.namesTitle')}</h3>
          {nameSlots.map((slot) => (
            <Field key={slot.slotId} label={slot.opId} hint={t('intent.nameHint')}>
              <TextInput
                value={slotValues[slot.slotId] ?? ''}
                onChange={(value) => setSlotValues((prev) => ({ ...prev, [slot.slotId]: value }))}
                placeholder={t('intent.namePlaceholder')}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
