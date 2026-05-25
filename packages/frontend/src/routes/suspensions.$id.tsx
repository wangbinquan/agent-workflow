// RFC-061 follow-up — unified suspension detail + answer form.
//
// Renders different forms based on signalKind:
//   - self-clarify        list questions → textarea per question
//   - cross-clarify       directive (submit/reject/stop) + per-question
//                          answers + optional rejectionFeedback
//   - review              doc body display + decision (approve/iterate/
//                          reject) + comments + summary
//   - retry-pending-human single "Retry now" button
//   - retry-pending-auto  read-only banner (scheduler handles)
//   - await-external-data read-only banner (v1 stub)
//
// All forms POST to /api/suspensions/:id/resolve with the SignalKind-
// specific payload validated server-side by the matching
// SignalKindHandler.validateResolution.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { Route as RootRoute } from './__root'
import { kindClass, kindLabel, type SuspensionRow } from './suspensions'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/suspensions/$id',
  component: SuspensionDetailPage,
})

function SuspensionDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const query = useQuery<SuspensionRow>({
    queryKey: ['suspensions', 'detail', id],
    queryFn: ({ signal }) =>
      api.get(`/api/suspensions/${encodeURIComponent(id)}`, undefined, signal),
  })

  const resolveMutation = useMutation({
    mutationFn: (payload: unknown) =>
      api.post(`/api/suspensions/${encodeURIComponent(id)}/resolve`, payload, undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suspensions'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void navigate({ to: '/suspensions' })
    },
  })

  if (query.isLoading) return <LoadingState />
  if (query.error !== null && query.error !== undefined) return <ErrorBanner error={query.error} />
  const s = query.data
  if (s === undefined) return null

  const resolved = s.resolvedAt !== null
  const submitting = resolveMutation.isPending
  const submitError = resolveMutation.error

  return (
    <main className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{kindLabel(t, s.signalKind)}</h1>
          <p className="muted">
            <Link to="/tasks/$id" params={{ id: s.taskId }}>
              {t('suspensions.taskHint', { id: s.taskId.slice(0, 10) })}
            </Link>{' '}
            · {t('suspensions.nodeHint', { id: s.scope.nodeId })} · iter={s.scope.iter}
          </p>
        </div>
        <span className={`suspensions__kind suspensions__kind--${kindClass(s.signalKind)}`}>
          {kindLabel(t, s.signalKind)}
        </span>
      </header>

      {resolved && (
        <div className="page__section">
          <div className="muted">{t('suspensions.alreadyResolved')}</div>
        </div>
      )}

      <section className="page__section">
        {s.signalKind === 'self-clarify' && (
          <SelfClarifyForm
            body={s.body}
            disabled={resolved || submitting}
            onSubmit={(payload) => resolveMutation.mutate(payload)}
          />
        )}
        {s.signalKind === 'cross-clarify' && (
          <CrossClarifyForm
            body={s.body}
            disabled={resolved || submitting}
            onSubmit={(payload) => resolveMutation.mutate(payload)}
          />
        )}
        {s.signalKind === 'review' && (
          <ReviewForm
            body={s.body}
            disabled={resolved || submitting}
            onSubmit={(payload) => resolveMutation.mutate(payload)}
          />
        )}
        {s.signalKind === 'retry-pending-human' && (
          <RetryHumanForm
            disabled={resolved || submitting}
            onSubmit={() => resolveMutation.mutate({ approved: true })}
          />
        )}
        {s.signalKind === 'retry-pending-auto' && (
          <div className="muted">{t('suspensions.retryAutoNote')}</div>
        )}
        {s.signalKind === 'await-external-data' && (
          <div className="muted">{t('suspensions.awaitExternalNote')}</div>
        )}
      </section>

      {submitError !== null && submitError !== undefined && <ErrorBanner error={submitError} />}
    </main>
  )
}

/* ============================================================
 *  self-clarify form
 * ============================================================ */

interface SelfClarifyBody {
  questions: ReadonlyArray<{ id: string; text: string }>
}

function SelfClarifyForm({
  body,
  disabled,
  onSubmit,
}: {
  body: unknown
  disabled: boolean
  onSubmit: (payload: { answers: Array<{ questionId: string; text: string }> }) => void
}) {
  const { t } = useTranslation()
  const b = body as SelfClarifyBody | null
  const questions = b?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const submit = (): void => {
    onSubmit({
      answers: questions.map((q) => ({ questionId: q.id, text: answers[q.id] ?? '' })),
    })
  }

  const allAnswered = questions.every((q) => (answers[q.id] ?? '').trim().length > 0)

  return (
    <div className="suspension-form">
      {questions.length === 0 && <div className="muted">{t('suspensions.noQuestions')}</div>}
      {questions.map((q) => (
        <Field key={q.id} label={q.text} required>
          <TextArea
            value={answers[q.id] ?? ''}
            onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
            disabled={disabled}
            data-testid={`answer-${q.id}`}
          />
        </Field>
      ))}
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled || !allAnswered}
          onClick={submit}
          data-testid="submit-self-clarify"
        >
          {t('suspensions.submitAnswers')}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
 *  cross-clarify form
 * ============================================================ */

interface CrossClarifyBody {
  questionerNodeId: string
  designerNodeId: string
  questions: ReadonlyArray<{ id: string; text: string }>
  questionScopes?: Record<string, 'this-designer' | 'all-designers'>
}

function CrossClarifyForm({
  body,
  disabled,
  onSubmit,
}: {
  body: unknown
  disabled: boolean
  onSubmit: (payload: {
    directive: 'submit' | 'reject' | 'stop'
    answers?: Array<{ questionId: string; text: string }>
    rejectionFeedback?: string
  }) => void
}) {
  const { t } = useTranslation()
  const b = body as CrossClarifyBody | null
  const questions = b?.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [directive, setDirective] = useState<'submit' | 'reject' | 'stop'>('submit')
  const [rejectionFeedback, setRejectionFeedback] = useState('')

  const submit = (): void => {
    if (directive === 'stop') {
      onSubmit({ directive: 'stop' })
      return
    }
    const payload: {
      directive: 'submit' | 'reject'
      answers: Array<{ questionId: string; text: string }>
      rejectionFeedback?: string
    } = {
      directive,
      answers: questions.map((q) => ({ questionId: q.id, text: answers[q.id] ?? '' })),
    }
    if (directive === 'reject') payload.rejectionFeedback = rejectionFeedback
    onSubmit(payload)
  }

  const allAnswered = questions.every((q) => (answers[q.id] ?? '').trim().length > 0)
  const submitDisabled =
    disabled ||
    (directive !== 'stop' && !allAnswered) ||
    (directive === 'reject' && rejectionFeedback.trim().length === 0)

  return (
    <div className="suspension-form">
      {b?.designerNodeId && (
        <Field label={t('suspensions.crossClarifyDesignerHint')} group>
          <div className="muted">
            {t('suspensions.crossClarifyDesignerValue', {
              questioner: b.questionerNodeId,
              designer: b.designerNodeId,
            })}
          </div>
        </Field>
      )}

      <Field label={t('suspensions.crossClarifyDirective')} group>
        <div className="segmented" role="radiogroup">
          {(['submit', 'reject', 'stop'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={directive === opt}
              className={
                directive === opt
                  ? 'segmented__option segmented__option--active'
                  : 'segmented__option'
              }
              disabled={disabled}
              onClick={() => setDirective(opt)}
              data-testid={`directive-${opt}`}
            >
              {t(`suspensions.crossClarifyDirective_${opt}`)}
            </button>
          ))}
        </div>
      </Field>

      {directive !== 'stop' &&
        questions.map((q) => (
          <Field key={q.id} label={q.text} required>
            <TextArea
              value={answers[q.id] ?? ''}
              onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
              disabled={disabled}
              data-testid={`cc-answer-${q.id}`}
            />
          </Field>
        ))}

      {directive === 'reject' && (
        <Field label={t('suspensions.rejectionFeedback')} required>
          <TextArea
            value={rejectionFeedback}
            onChange={setRejectionFeedback}
            disabled={disabled}
            data-testid="cc-rejection-feedback"
          />
        </Field>
      )}

      <div className="page__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={submitDisabled}
          onClick={submit}
          data-testid="submit-cross-clarify"
        >
          {t('suspensions.submitDecision')}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
 *  review form
 * ============================================================ */

interface ReviewBody {
  docNodeId: string
  docPortName: string
  docContent: string
  reviewerHint?: string
}

function ReviewForm({
  body,
  disabled,
  onSubmit,
}: {
  body: unknown
  disabled: boolean
  onSubmit: (payload: {
    decision: 'approve' | 'iterate' | 'reject'
    comments?: Array<{ filePath?: string; comment: string }>
    summary?: string
  }) => void
}) {
  const { t } = useTranslation()
  const b = body as ReviewBody | null
  const [decision, setDecision] = useState<'approve' | 'iterate' | 'reject'>('approve')
  const [summary, setSummary] = useState('')
  const [comment, setComment] = useState('')

  const submit = (): void => {
    if (decision === 'approve') {
      onSubmit({ decision: 'approve', summary: summary || undefined })
      return
    }
    onSubmit({
      decision,
      comments: [{ comment }],
      summary: summary || undefined,
    })
  }

  const submitDisabled = disabled || (decision !== 'approve' && comment.trim().length === 0)

  return (
    <div className="suspension-form">
      {b?.reviewerHint && (
        <Field label={t('suspensions.reviewHint')} group>
          <div className="muted">{b.reviewerHint}</div>
        </Field>
      )}

      <Field
        label={t('suspensions.reviewDocument', {
          node: b?.docNodeId ?? '?',
          port: b?.docPortName ?? '?',
        })}
        group
      >
        <pre className="suspension-form__doc" data-testid="review-doc">
          {b?.docContent ?? ''}
        </pre>
      </Field>

      <Field label={t('suspensions.reviewDecision')} group>
        <div className="segmented" role="radiogroup">
          {(['approve', 'iterate', 'reject'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={decision === opt}
              className={
                decision === opt
                  ? 'segmented__option segmented__option--active'
                  : 'segmented__option'
              }
              disabled={disabled}
              onClick={() => setDecision(opt)}
              data-testid={`review-decision-${opt}`}
            >
              {t(`suspensions.reviewDecision_${opt}`)}
            </button>
          ))}
        </div>
      </Field>

      {decision !== 'approve' && (
        <Field label={t('suspensions.reviewComments')} required>
          <TextArea
            value={comment}
            onChange={setComment}
            disabled={disabled}
            data-testid="review-comment"
          />
        </Field>
      )}

      <Field label={t('suspensions.reviewSummary')}>
        <TextInput
          value={summary}
          onChange={setSummary}
          disabled={disabled}
          data-testid="review-summary"
        />
      </Field>

      <div className="page__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={submitDisabled}
          onClick={submit}
          data-testid="submit-review"
        >
          {t('suspensions.submitDecision')}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
 *  retry-pending-human form
 * ============================================================ */

function RetryHumanForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="suspension-form">
      <div className="muted">{t('suspensions.retryHumanHint')}</div>
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={onSubmit}
          data-testid="submit-retry-human"
        >
          {t('suspensions.retryNow')}
        </button>
      </div>
    </div>
  )
}
