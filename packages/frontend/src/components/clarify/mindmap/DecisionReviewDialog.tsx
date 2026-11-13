import { useTranslation } from 'react-i18next'
import {
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Segmented } from '@/components/Segmented'
import { ErrorBanner } from '@/components/ErrorBanner'
import { clarifyAnswerPreview } from '@/lib/clarify/mindmap/projection'
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
        {!readonly && props.followupFailed && (
          <p role="status" className="mindmap-decision__unknown">
            {t('mindmap.review.failedFollowup')}
          </p>
        )}
        {props.questions.map((question, index) => {
          const answer = props.answers[question.id]
          const answered = answer !== undefined && isClarifyAnswerValid(question, answer)
          const confirmed =
            props.locked.has(question.id) || isClarifyAnswerConfirmed(question, answer)
          return (
            <article key={question.id} className="mindmap-review__item">
              <div className="mindmap-review__heading">
                <h4>
                  Q{index + 1} · {question.title}
                </h4>
                <button
                  className="btn btn--sm"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onEdit(question.id)}
                >
                  {t(readonly ? 'mindmap.review.locateReadonly' : 'mindmap.review.locate')}
                </button>
              </div>
              {answered || confirmed ? (
                <>
                  <p className="mindmap-review__answer">{clarifyAnswerPreview(question, answer)}</p>
                  <p className="muted">
                    {t(confirmed ? 'mindmap.status.done' : 'mindmap.status.needs_confirmation')}
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
        {!readonly && (
          <>
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
          </>
        )}
      </div>
    </Dialog>
  )
}
