// RFC-234 (T8) — intent session detail: conversation timeline (messages /
// structured questions / changeset summaries / retryable errors), composer,
// mounted working-set, the current-draft panel (per-op cards + validation +
// stale banner) and the commit dialog (server-issued slots: finalName /
// secret / waiver / humanBinding + per-update modify-vs-copy choice).

import type { IntentSessionDetail, IntentSlotDto, UserPublic } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { IntentMountDialog } from '@/components/IntentMountDialog'
import { IntentOpPreview } from '@/components/intent/IntentOpPreview'
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

function ulidLike(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  for (let i = 0; i < 26; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function IntentSessionDetailPage() {
  const { t } = useTranslation()
  const { sessionId } = Route.useParams()
  const navigate = useNavigate()
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

  if (detailQuery.isLoading) return <LoadingState />
  if (detailQuery.isError) return <ErrorBanner error={detailQuery.error} />
  if (detail === undefined) return null
  const draft = detail.currentDraft
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
    <div className="page">
      <PageHeader
        title={detail.session.title}
        headingLevel={1}
        meta={
          detail.session.inFlight ? (
            <StatusChip kind="info" withDot>
              {t('intent.statusRunning')}
            </StatusChip>
          ) : (
            <StatusChip kind={detail.session.status === 'archived' ? 'neutral' : 'success'}>
              {detail.session.status === 'archived'
                ? t('intent.statusArchived')
                : t('intent.statusActive')}
            </StatusChip>
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

      <div className="page__section">
        <h2>{t('intent.timeline')}</h2>
        {detail.turns.map((turn) => (
          <div key={turn.id} className="card" data-testid={`intent-turn-${turn.kind}`}>
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
          </div>
        ))}
        {detail.session.inFlight ? <LoadingState label={t('intent.generating')} /> : null}
      </div>

      {pendingQuestions.length > 0 && !detail.session.inFlight ? (
        <div className="page__section" data-testid="intent-questions">
          <h2>{t('intent.answerQuestions')}</h2>
          {pendingQuestions.map((question) => (
            <Field key={question.id} label={question.question} required>
              <Segmented
                ariaLabel={question.question}
                value={answers[question.id]?.[0] ?? ''}
                onChange={(picked) => setAnswers((prev) => ({ ...prev, [question.id]: [picked] }))}
                options={question.options.map((option) => ({ value: option, label: option }))}
              />
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
        </div>
      ) : null}

      <div className="page__section">
        <h2>{t('intent.mounts')}</h2>
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
        <button
          type="button"
          className="btn btn--sm"
          data-testid="intent-add-mount"
          onClick={() => setMountOpen(true)}
          disabled={detail.session.inFlight || detail.session.status === 'archived'}
        >
          {t('intent.addMount')}
        </button>
        <IntentMountDialog
          open={mountOpen}
          onClose={() => setMountOpen(false)}
          sessionId={sessionId}
          mounted={detail.mounts}
          onAdded={() => void invalidate()}
        />
      </div>

      {draft !== null ? (
        <div className="page__section" data-testid="intent-draft">
          <h2>
            {t('intent.draftTitle', { revision: draft.revision })}{' '}
            {draft.stale ? <StatusChip kind="warn">{t('intent.draftStale')}</StatusChip> : null}
          </h2>
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
            <div key={String(op.opId)} className="card" data-testid="intent-op-card">
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
          <button
            type="button"
            className="btn btn--primary"
            disabled={draft.stale || draft.validation.errors.length > 0 || detail.session.inFlight}
            onClick={() => setCommitOpen(true)}
            data-testid="intent-open-commit"
          >
            {t('intent.openCommit')}
          </button>
        </div>
      ) : null}

      {detail.commits.length > 0 ? (
        <div className="page__section">
          <h2>{t('intent.commits')}</h2>
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

      {detail.session.status === 'active' ? (
        <div className="page__section">
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
          <button
            type="button"
            className="btn btn--primary"
            disabled={message.trim() === '' || sendMessage.isPending || detail.session.inFlight}
            onClick={() => sendMessage.mutate()}
          >
            {t('intent.send')}
          </button>
        </div>
      ) : null}

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
      <span style={{ display: 'none' }}>{String(navigate !== undefined)}</span>
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
        clientMutationId: ulidLike(),
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
