import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clarifySkipStatus,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Segmented } from '@/components/Segmented'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { clarifyAnswerPreview } from '@/lib/clarify/mindmap/projection'
import { reviewMindmapDecisions } from '@/lib/clarify/mindmap/review'
import { DecisionReadback } from './DecisionDetails'

export function DecisionReviewDialog(props: {
  open: boolean
  title: string
  questions: readonly ClarifyQuestion[]
  answers: Readonly<Record<string, ClarifyAnswer>>
  locked: ReadonlySet<string>
  directive: ClarifyDirective
  onDirective(value: ClarifyDirective): void
  onClose(): void
  onEdit(questionId: string): void
  onSubmit(): void
  disabled: boolean
  busy: boolean
  /** Nothing is left to submit: the round is sealed or every question was handled
   *  elsewhere. The dialog is then only the decision summary. */
  readonly?: boolean
  blockReason?: string
  followupFailed: boolean
  error: unknown
  isCross: boolean
}) {
  const { t } = useTranslation()
  const readonly = props.readonly === true
  const [filter, setFilter] = useState<'all' | 'attention'>('all')
  const { summary, groups } = useMemo(
    () => reviewMindmapDecisions(props.questions, props.answers, props.locked),
    [props.questions, props.answers, props.locked],
  )
  const shown = groups
    .map((group) => ({
      ...group,
      entries: filter === 'all' ? group.entries : group.entries.filter((entry) => entry.attention),
    }))
    .filter((group) => group.entries.length > 0)
  const counts: [string, number][] = [
    ['confirmed', summary.confirmed],
    ['provisional', summary.provisional],
    ['unmarked', summary.unmarked],
    ['notApplicable', summary.notApplicable],
    ['deferred', summary.deferred],
    ['noRationale', summary.noRationale],
  ]
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      dismissDisabled={props.busy}
      title={t(readonly ? 'mindmap.review.readonlyTitle' : 'mindmap.review.title')}
      size="lg"
      panelClassName="mindmap-review-dialog"
      data-testid="mindmap-review"
      footer={
        readonly ? (
          <button type="button" className="btn" onClick={props.onClose}>
            {t('mindmap.review.done')}
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={props.onClose} disabled={props.busy}>
              {t('mindmap.review.back')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={props.onSubmit}
              disabled={props.disabled || props.busy}
              data-testid="mindmap-review-submit"
            >
              {t(
                props.busy
                  ? 'mindmap.review.submitting'
                  : props.directive === 'stop'
                    ? 'mindmap.review.submitStop'
                    : 'mindmap.review.submitContinue',
              )}
            </button>
          </>
        )
      }
    >
      <div className="mindmap-review">
        <h3>{props.title}</h3>
        <p className="muted">
          {t(readonly ? 'mindmap.review.readonlyHint' : 'mindmap.review.hint')}
        </p>
        <div className="mindmap-review__summary" data-testid="mindmap-review-summary">
          <span>{t('mindmap.review.summary.total', { count: summary.total })}</span>
          {counts
            .filter(([, count]) => count > 0)
            .map(([key, count]) => (
              <span key={key} data-review-count={key}>
                {t(`mindmap.review.summary.${key}`, { count })}
              </span>
            ))}
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          ariaLabel={t('mindmap.review.filter')}
          options={[
            { value: 'all', label: t('mindmap.review.filterAll') },
            {
              value: 'attention',
              label: t('mindmap.review.filterAttention', { count: summary.attention }),
            },
          ]}
        />
        {!readonly && props.followupFailed && (
          <p role="status" className="mindmap-decision__unknown">
            {t('mindmap.review.failedFollowup')}
          </p>
        )}
        {shown.length === 0 && (
          <EmptyState title={t('mindmap.review.attentionEmpty')} size="compact" />
        )}
        {shown.map((group) => (
          <section
            key={JSON.stringify(group.path)}
            className="mindmap-review__group"
            aria-label={group.path.join(' / ') || props.title}
          >
            <h4 className="mindmap-review__group-title">{group.path.join(' / ')}</h4>
            {group.entries.map((entry) => {
              const { question, answer } = entry
              const skipped = clarifySkipStatus(answer) !== undefined
              return (
                <article
                  key={question.id}
                  className="mindmap-review__item"
                  data-depth={Math.min(entry.depth, 3)}
                >
                  <div className="mindmap-review__heading">
                    <h5>
                      Q{entry.index + 1} · {question.title}
                    </h5>
                    <button
                      className="btn btn--sm"
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onEdit(question.id)}
                    >
                      {t(readonly ? 'mindmap.review.locateReadonly' : 'mindmap.review.locate')}
                    </button>
                  </div>
                  {entry.parentIndex !== null && (
                    <p className="muted">
                      {t('mindmap.parentQuestion', { number: entry.parentIndex + 1 })}
                    </p>
                  )}
                  {entry.answered || entry.confirmed ? (
                    <>
                      {!skipped && (
                        <p className="mindmap-review__answer">
                          {clarifyAnswerPreview(question, answer)}
                        </p>
                      )}
                      <p className="muted">
                        {t(
                          entry.confirmed
                            ? 'mindmap.status.done'
                            : 'mindmap.status.needs_confirmation',
                        )}
                      </p>
                    </>
                  ) : (
                    // An unanswered question is not "awaiting confirmation".
                    <p className="mindmap-review__answer mindmap-decision__unknown">
                      {t('mindmap.status.needs_detail')}
                    </p>
                  )}
                  <DecisionReadback decision={answer?.decision} />
                </article>
              )
            })}
          </section>
        ))}
        {!readonly && (
          <div className="mindmap-review__next">
            <Segmented
              value={props.directive}
              onChange={props.onDirective}
              disabled={props.busy}
              ariaLabel={t('mindmap.review.next')}
              options={[
                { value: 'stop', label: t('mindmap.review.stop') },
                { value: 'continue', label: t('mindmap.review.continue') },
              ]}
            />
            <p className="muted">
              {t(
                props.directive === 'stop'
                  ? props.isCross
                    ? 'crossClarify.rejectModal.body'
                    : 'mindmap.review.outputHint'
                  : 'mindmap.review.continueHint',
              )}
            </p>
            {props.blockReason && <p role="status">{props.blockReason}</p>}
            {props.error != null && <ErrorBanner error={props.error} />}
          </div>
        )}
      </div>
    </Dialog>
  )
}
