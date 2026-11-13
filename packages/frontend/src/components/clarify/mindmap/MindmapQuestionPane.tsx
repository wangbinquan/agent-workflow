import { DecisionDetails } from './DecisionDetails'
import { mindmapFollowupLimit, restoreMindmapFollowup } from '@/lib/clarify/mindmap/followup'
import {
  optionClickIsReading,
  placeSelectionControl,
  type SelectionBox,
} from '@/lib/clarify/mindmap/selection'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  clarifyAnswerBasis,
  clarifySkipStatus,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifySkipStatus,
} from '@agent-workflow/shared'
import { Field, TextArea, TextInput } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { useExecutionAvailability } from '@/hooks/useExecutionAvailability'
import { VirtualList } from '@/components/VirtualList'
import { clarifyAnswerPreview, type MindmapNodeSummary } from '@/lib/clarify/mindmap/projection'
import { pendingMindmapDescendants } from '@/lib/clarify/mindmap/navigation'
import type { MindmapSuggestion } from '@/lib/clarify/mindmap/suggestions'
import { MindmapCounts, MindmapEmptyMark, MindmapStatus } from './MindmapStatus'

const SUGGESTION_LIMIT = 6
/** Enter means "confirm and go on" only where it has no meaning of its own. */
const ENTER_OWNERS =
  'button, a, select, textarea, summary, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="option"]'

interface Props {
  node: MindmapNodeSummary
  ancestors: readonly MindmapNodeSummary[]
  children: readonly MindmapNodeSummary[]
  question: ClarifyQuestion | undefined
  questionIndex: number
  answer: ClarifyAnswer | undefined
  /** The question this one was asked from, with the answer it was asked about. */
  parentQuestion?: ClarifyQuestion
  parentAnswer?: ClarifyAnswer
  disabled: boolean
  locked: boolean
  /** Shown beside the panorama canvas (not the full focused view). */
  side: boolean
  /** The panel is tall enough to keep the reason for an answer (or the note on a skip)
   *  beside the confirm button. A short panel leaves it under the options instead, so
   *  the options keep their room. */
  decisionInBar: boolean
  /** Where keyboard focus belongs for this node: the answer form of an answerable
   *  question (its digit hotkeys live there), otherwise the heading. */
  focusTargetRef?: MutableRefObject<HTMLElement | null>
  /** Root only: what is still worth another look, and the task's launch inputs. */
  suggestions?: readonly MindmapSuggestion[]
  taskInputs?: readonly { label: string; value: string }[]
  /** The whole round, for the stable "Qn" numbers of other questions. */
  questions: readonly ClarifyQuestion[]
  onSuggestion?(suggestion: MindmapSuggestion): void
  onFocusWorkspace(): void
  onCancelFollowup(): void
  pending: boolean
  pendingHere: boolean
  canAdvance: boolean
  /** Another question besides this one still needs an answer or a confirmation. */
  othersPending: boolean
  collapsed: boolean
  instruction: string
  quote: string
  onQuote(value: string): void
  onPrompt(value: string): void
  followupOpen: boolean
  error: unknown
  canRetryFollowup: boolean
  onSelect(id: string): void
  onToggle(): void
  onReturn(): void
  onChange(answer: ClarifyAnswer): void
  /** Skip in one step; the workspace remembers what was there for `onResume`. */
  onSkip(status: ClarifySkipStatus): void
  onSkipNote(note: string): void
  onResume(): void
  onAdvance(): void
  onInstruction(value: string): void
  onFollowup(): void
  /** A question's follow-up form can be put away; a category's is always there. */
  onFollowupClose(): void
  renderQuestion(question: ClarifyQuestion, index: number): ReactNode
}

export function MindmapQuestionPane(props: Props) {
  const { t } = useTranslation()
  const execution = useExecutionAvailability('task')
  const heading = useRef<HTMLHeadingElement>(null)
  const reading = useRef<HTMLDivElement>(null)
  const followup = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(
    null,
  )
  const [allSuggestions, setAllSuggestions] = useState(false)
  const editable = !!props.question && !props.disabled && !props.locked
  // Digit hotkeys belong to the answer form, so that is where focus goes.
  const answerForm = () =>
    editable ? (reading.current?.querySelector<HTMLElement>('.clarify-question') ?? null) : null
  const showSelection = (text: string, box: SelectionBox) => {
    const reader = reading.current
    if (!reader || !text.trim()) return setSelection(null)
    const rect = reader.getBoundingClientRect()
    setSelection({
      text,
      ...placeSelectionControl(box, {
        left: rect.left,
        top: rect.top,
        scrollLeft: reader.scrollLeft,
        scrollTop: reader.scrollTop,
        clientWidth: reader.clientWidth,
      }),
    })
  }
  // The user's own wording in a field is quotable; the follow-up direction is not.
  const captureField = (field: EventTarget) => {
    if (!(field instanceof HTMLTextAreaElement)) return
    if (field.closest('.mindmap-question__followup')) return
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? 0
    if (end > start) showSelection(field.value.slice(start, end), field.getBoundingClientRect())
    else setSelection(null)
  }
  useEffect(() => {
    setSelection(null)
    setAllSuggestions(false)
    const capture = () => {
      const reader = reading.current
      if (!reader) return
      // A focused field reports its own selection through captureField.
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement && reader.contains(active)) return
      const value = document.getSelection()
      if (
        !value ||
        value.isCollapsed ||
        value.rangeCount === 0 ||
        !value.anchorNode ||
        !value.focusNode ||
        !reader.contains(value.anchorNode) ||
        !reader.contains(value.focusNode)
      )
        return setSelection(null)
      const range = value.getRangeAt(0)
      showSelection(
        value.toString(),
        typeof range.getBoundingClientRect === 'function'
          ? range.getBoundingClientRect()
          : (range.startContainer.parentElement ?? reader).getBoundingClientRect(),
      )
    }
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [props.node.id])
  const limit = mindmapFollowupLimit(props.quote, props.instruction)
  const { focusTargetRef } = props
  useLayoutEffect(() => {
    if (focusTargetRef) focusTargetRef.current = answerForm() ?? heading.current
  })
  const previous = useRef({ id: props.node.id, open: props.followupOpen })
  useLayoutEffect(() => {
    if (previous.current.id !== props.node.id && reading.current) reading.current.scrollTop = 0
    else if (props.followupOpen && !previous.current.open && followup.current && reading.current)
      reading.current.scrollTop +=
        followup.current.getBoundingClientRect().top - reading.current.getBoundingClientRect().top
    previous.current = { id: props.node.id, open: props.followupOpen }
  }, [props.node.id, props.followupOpen])

  const { question, answer } = props
  const valid = !!question && !!answer && isClarifyAnswerValid(question, answer)
  const confirmed = !!question && isClarifyAnswerConfirmed(question, answer)
  const skipStatus = clarifySkipStatus(answer)
  const confirmAnswer = () => {
    if (!question || !answer) return
    props.onChange({ ...answer, confirmedBasis: clarifyAnswerBasis(question, answer) })
    // The button disables itself; keep the keyboard on this question.
    answerForm()?.focus({ preventScroll: true })
  }
  /** Enter and the primary button: confirm, then move on when something else is pending. */
  const advance = () => {
    if (!editable) return
    if (!confirmed) {
      if (!valid) return
      confirmAnswer()
      if (props.othersPending) props.onAdvance()
    } else if (props.canAdvance) props.onAdvance()
  }
  // Design §4.3: handled here for the whole answer area, so a digit pick and the
  // confirmation never share one keystroke with stale values.
  const onAnswerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
    if (!(event.target instanceof Element) || event.target.closest(ENTER_OWNERS)) return
    if (!editable) return
    event.preventDefault()
    advance()
  }
  const pendingChildren = pendingMindmapDescendants(props.node)
  const path = props.ancestors.filter((node) => node.id !== 'root')
  const olderQuestions = path.filter((node) => node.kind === 'question').slice(0, -1)
  // Design §6.6: where a generated question came from, as far as it was saved.
  const requested = question?.mindmap?.requestTarget
  const origin = question?.mindmap?.requestInstruction
    ? restoreMindmapFollowup(question.mindmap.requestInstruction)
    : undefined
  const fromDirection = requested === 'category' || requested === 'root'
  const childQuestions = props.children.filter((node) => node.kind === 'question')
  const shownSuggestions = allSuggestions
    ? (props.suggestions ?? [])
    : (props.suggestions ?? []).slice(0, SUGGESTION_LIMIT)
  const questionNumber = (id: string) => props.questions.findIndex((item) => item.id === id) + 1
  const closeFollowup = () => {
    props.onFollowupClose()
    answerForm()?.focus({ preventScroll: true })
  }

  // Why the question was skipped: one field, beside the confirm button or under the
  // options, never both.
  const skipNote = editable && answer && skipStatus && (
    <div className="mindmap-decision mindmap-decision--essentials">
      <Field
        label={t(
          skipStatus === 'deferred'
            ? 'mindmap.skip.noteDeferred'
            : 'mindmap.skip.noteNotApplicable',
        )}
      >
        <TextInput
          value={answer.decision?.rationale ?? ''}
          maxLength={2000}
          onChange={props.onSkipNote}
        />
      </Field>
    </div>
  )
  const directionForm = !props.disabled && !props.locked && props.followupOpen && (
    <div
      className="mindmap-question__followup"
      ref={followup}
      onKeyDown={(event) => {
        // The form owns Escape while it is open, so the side panel stays.
        if (event.key !== 'Escape' || !question || props.pendingHere) return
        event.preventDefault()
        event.stopPropagation()
        closeFollowup()
      }}
    >
      <h3>
        {t(question ? 'mindmap.followupTitle' : 'mindmap.categoryGuidance', {
          number: props.questionIndex + 1,
        })}
      </h3>
      <p className="muted">
        {t(
          question
            ? 'mindmap.followupContext'
            : props.node.id === 'root'
              ? 'mindmap.rootContext'
              : props.node.empty
                ? 'mindmap.emptyCategoryHint'
                : 'mindmap.categoryContext',
        )}
      </p>
      {props.quote && (
        <div className="mindmap-quote">
          <blockquote>{props.quote}</blockquote>
          <button
            className="btn btn--sm"
            type="button"
            disabled={props.pendingHere}
            onClick={() => props.onQuote('')}
          >
            {t('mindmap.quote.remove')}
          </button>
        </div>
      )}
      <Field label={t(question ? 'mindmap.followupHint' : 'mindmap.categoryHint')}>
        <TextArea
          rows={3}
          placeholder={question ? undefined : t('mindmap.categoryPlaceholder')}
          maxLength={2000}
          value={props.instruction}
          onChange={props.onInstruction}
          disabled={props.pendingHere}
        />
      </Field>
      {limit && <p role="alert">{t(`mindmap.quote.${limit}Limit`)}</p>}
      <div className="mindmap-question__followup-actions">
        <button
          type="button"
          className="btn"
          disabled={props.pending || !execution.available || limit !== null}
          title={execution.unavailableReason}
          onClick={props.onFollowup}
        >
          {t(
            props.pendingHere
              ? 'mindmap.generating'
              : question
                ? 'mindmap.followup'
                : 'mindmap.askCategory',
          )}
        </button>
        {props.pendingHere && (
          <button type="button" className="btn btn--ghost" onClick={props.onCancelFollowup}>
            {t('mindmap.cancelFollowup')}
          </button>
        )}
        {question && !props.pendingHere && (
          <button type="button" className="btn btn--ghost" onClick={closeFollowup}>
            {t('mindmap.closeFollowup')}
          </button>
        )}
      </div>
    </div>
  )
  return (
    <>
      <div className="mindmap-question__toolbar">
        <button type="button" className="btn btn--sm btn--ghost" onClick={props.onReturn}>
          ← {t('mindmap.backToMap')}
        </button>
        {props.side && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={props.onFocusWorkspace}>
            {t('mindmap.openFocus')}
          </button>
        )}
        {props.children.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={!props.collapsed}
            onClick={props.onToggle}
          >
            {t(props.collapsed ? 'mindmap.expand' : 'mindmap.collapse')}
          </button>
        )}
      </div>
      <div
        className="mindmap-question__reading"
        ref={reading}
        onSelect={(event) => captureField(event.target)}
        onKeyDown={(event) => {
          // The quote control owns Escape while it is shown, so the side panel stays.
          if (event.key !== 'Escape' || !selection) return
          event.preventDefault()
          event.stopPropagation()
          setSelection(null)
          document.getSelection()?.removeAllRanges()
        }}
        onKeyUp={(event) => captureField(event.target)}
        onMouseUp={(event) => captureField(event.target)}
        onClickCapture={(event) => {
          if (optionClickIsReading(event.target)) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <div className="mindmap-question__content">
          <nav className="mindmap-workspace__breadcrumbs" aria-label={t('mindmap.path')}>
            {path
              .filter((node) => node.kind === 'group')
              .map((node) => (
                <button
                  key={node.id}
                  className="btn btn--sm btn--ghost"
                  type="button"
                  onClick={() => props.onSelect(node.id)}
                >
                  {node.title}
                </button>
              ))}
          </nav>
          {question && (props.parentQuestion || fromDirection) && (
            <aside className="mindmap-origin" aria-label={t('mindmap.origin.label')}>
              {props.parentQuestion ? (
                <>
                  <p className="mindmap-origin__source">
                    {t('mindmap.parentQuestion', {
                      number: questionNumber(props.parentQuestion.id),
                    })}
                    {' · '}
                    {props.parentQuestion.title}
                  </p>
                  <p>
                    <span className="mindmap-origin__label">{t('mindmap.origin.yourAnswer')}</span>
                    {clarifyAnswerPreview(props.parentQuestion, props.parentAnswer) ||
                      (clarifySkipStatus(props.parentAnswer)
                        ? t(`mindmap.decision.${clarifySkipStatus(props.parentAnswer)!}`)
                        : t('mindmap.origin.unanswered'))}
                  </p>
                </>
              ) : (
                <p className="mindmap-origin__source">
                  {requested === 'category'
                    ? t('mindmap.origin.fromCategory', {
                        category: (question.mindmap?.categoryPath ?? []).join(' / '),
                      })
                    : t('mindmap.origin.fromRoot')}
                </p>
              )}
              {origin?.quote && (
                <p>
                  <span className="mindmap-origin__label">{t('mindmap.origin.quote')}</span>
                  {origin.quote}
                </p>
              )}
              {origin?.instruction && (
                <p>
                  <span className="mindmap-origin__label">{t('mindmap.origin.instruction')}</span>
                  {origin.instruction}
                </p>
              )}
              {props.parentQuestion && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => props.onSelect(`q:${props.parentQuestion!.id}`)}
                >
                  {t('mindmap.origin.view', { number: questionNumber(props.parentQuestion.id) })}
                </button>
              )}
              {olderQuestions.length > 0 && (
                <details className="mindmap-question__ancestry">
                  <summary>{t('mindmap.showPath')}</summary>
                  {olderQuestions.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => props.onSelect(node.id)}
                    >
                      Q{node.order + 1} · {node.title}
                    </button>
                  ))}
                </details>
              )}
            </aside>
          )}
          <div className="mindmap-question__eyebrow">
            {question && (
              <span className="mindmap-question__number">Q{props.questionIndex + 1}</span>
            )}
            {props.node.empty ? (
              <MindmapEmptyMark />
            ) : (
              <MindmapStatus status={props.node.ownStatus ?? props.node.status} />
            )}
            {question && pendingChildren > 0 && (
              <span className="muted">
                {t('mindmap.pendingChildren', { count: pendingChildren })}
              </span>
            )}
            {props.pendingHere && <span role="status">{t('mindmap.generating')}</span>}
          </div>
          <h2 className="mindmap-question__title" ref={heading} tabIndex={-1}>
            {props.node.title}
          </h2>
          {question ? (
            <>
              <div className="mindmap-question__answer" onKeyDown={onAnswerKeyDown}>
                {/* Its own parent: the renderer keys its element by question id, and so
                    does the decision block below. As siblings they would share a key. */}
                <div className="mindmap-question__form">
                  {props.renderQuestion(question, props.questionIndex)}
                </div>
                {answer && editable && (
                  <div className="mindmap-question__skip">
                    {skipStatus ? (
                      <>
                        <span className="mindmap-decision__unknown">
                          {t('mindmap.skip.marked', {
                            status: t(`mindmap.decision.${skipStatus}`),
                          })}
                        </span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={props.onResume}
                        >
                          {t('mindmap.skip.resume')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="muted">{t('mindmap.skip.label')}</span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => props.onSkip('not-applicable')}
                        >
                          {t('mindmap.skip.notApplicable')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => props.onSkip('deferred')}
                        >
                          {t('mindmap.skip.deferred')}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {!props.decisionInBar && skipNote}
                {/* In a roomy panel the rationale and the maturity sit beside the confirm
                    button below, where they never scroll away, and only the remaining
                    notes are here. A question that is only read shows the whole readback. */}
                {answer && !(editable && skipStatus) && (valid || !editable || answer.decision) && (
                  <DecisionDetails
                    key={question.id}
                    layout="inline"
                    part={editable && props.decisionInBar ? 'more' : undefined}
                    answer={answer}
                    disabled={!editable}
                    onChange={props.onChange}
                  />
                )}
              </div>
              {childQuestions.length > 0 && (
                <div className="mindmap-question__children-list">
                  <h3>{t('mindmap.childQuestions', { count: childQuestions.length })}</h3>
                  <ul>
                    {childQuestions.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          className="mindmap-workspace__branch"
                          onClick={() => props.onSelect(node.id)}
                        >
                          <span>
                            Q{node.order + 1} · {node.title}
                          </span>
                          <MindmapStatus status={node.ownStatus ?? node.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {editable && (
                <div className="mindmap-question__prompts">
                  <span className="muted">{t('mindmap.prompts.label')}</span>
                  {(['evidence', 'tradeoff', 'alternative', 'free'] as const).map((prompt) => (
                    <button
                      key={prompt}
                      className="btn btn--sm"
                      type="button"
                      disabled={props.pendingHere}
                      onClick={() =>
                        props.onPrompt(prompt === 'free' ? '' : t(`mindmap.prompts.${prompt}Text`))
                      }
                    >
                      {t(`mindmap.prompts.${prompt}`)}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {props.taskInputs && props.taskInputs.length > 0 && (
                <details className="mindmap-task-inputs">
                  <summary>{t('mindmap.taskInputs')}</summary>
                  <dl>
                    {props.taskInputs.map((input) => (
                      <div key={input.label}>
                        <dt>{input.label}</dt>
                        <dd>{input.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              {!props.node.empty && <MindmapCounts counts={props.node.counts} />}
              {props.suggestions && props.suggestions.length > 0 && (
                <section
                  className="mindmap-suggestions"
                  aria-label={t('mindmap.suggestions.title')}
                >
                  <h3>{t('mindmap.suggestions.title')}</h3>
                  <p className="muted">{t('mindmap.suggestions.hint')}</p>
                  <ul>
                    {shownSuggestions.map((suggestion) => (
                      <li key={suggestionKey(suggestion)}>
                        <span>{suggestionText(suggestion, t, questionNumber)}</span>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => props.onSuggestion?.(suggestion)}
                        >
                          {t(`mindmap.suggestions.action.${suggestion.kind}`)}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!allSuggestions && props.suggestions.length > SUGGESTION_LIMIT && (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => setAllSuggestions(true)}
                    >
                      {t('mindmap.suggestions.more', {
                        count: props.suggestions.length - SUGGESTION_LIMIT,
                      })}
                    </button>
                  )}
                </section>
              )}
              {directionForm}
              {props.children.length > 0 && (
                <>
                  <p className="muted">{t('mindmap.groupHint')}</p>
                  <div className="mindmap-question__children">
                    <VirtualList
                      items={props.children}
                      itemKey={(node) => node.id}
                      estimateSize={92}
                      containerProps={{
                        role: 'list',
                        'aria-label': t('mindmap.children'),
                        className: 'mindmap-question__child-list',
                      }}
                      rowRole="listitem"
                      renderItem={(node) => (
                        <button
                          type="button"
                          className="mindmap-workspace__branch"
                          onClick={() => props.onSelect(node.id)}
                        >
                          <span>
                            {node.kind === 'question' ? `Q${node.order + 1} · ` : ''}
                            {node.title}
                          </span>
                          {node.empty ? (
                            <MindmapEmptyMark />
                          ) : (
                            <MindmapCounts counts={node.counts} />
                          )}
                        </button>
                      )}
                    />
                  </div>
                </>
              )}
            </>
          )}
          {question && directionForm}
          {props.error != null && (
            <div className="mindmap-question__error">
              <p role="alert">{t('mindmap.followupFailed')}</p>
              {!props.canRetryFollowup && <p>{t('mindmap.quote.restoreDirection')}</p>}
              {!props.disabled && !props.locked && (
                <button
                  type="button"
                  className="btn"
                  disabled={props.pending || !execution.available || limit !== null}
                  onClick={() => (props.canRetryFollowup ? props.onFollowup() : props.onPrompt(''))}
                >
                  {t(
                    props.canRetryFollowup
                      ? 'mindmap.quote.retry'
                      : 'mindmap.quote.reviewDirection',
                  )}
                </button>
              )}
              <details>
                <summary>{t('mindmap.quote.technical')}</summary>
                <ErrorBanner error={props.error} />
              </details>
            </div>
          )}
        </div>
        {!props.disabled && !props.locked && selection && (
          <div
            className="mindmap-question__selection"
            style={{ top: selection.top, left: selection.left }}
          >
            <button
              className="btn btn--sm btn--primary"
              type="button"
              disabled={props.pendingHere || selection.text.length > 500}
              // Keep the selection (and a field's focus) while the control is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.onQuote(selection.text)
                setSelection(null)
                document.getSelection()?.removeAllRanges()
              }}
            >
              {t('mindmap.quote.ask')}
            </button>
            {selection.text.length > 500 && <p role="alert">{t('mindmap.quote.quoteLimit')}</p>}
          </div>
        )}
      </div>
      {question && (editable || props.canAdvance) && (
        <div className="mindmap-question__actions" onKeyDown={onAnswerKeyDown}>
          {/* The reason for the answer, right where it is confirmed. */}
          {props.decisionInBar && skipNote}
          {props.decisionInBar &&
            editable &&
            answer &&
            !skipStatus &&
            (valid || answer.decision) && (
              <DecisionDetails
                key={question.id}
                layout="inline"
                part="essentials"
                answer={answer}
                disabled={false}
                onChange={props.onChange}
              />
            )}
          <div className="mindmap-question__buttons">
            {editable && answer && (
              <>
                {!confirmed && props.othersPending && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!valid}
                    onClick={advance}
                  >
                    {t('mindmap.confirmNext')} →
                  </button>
                )}
                <button
                  type="button"
                  className={!confirmed && props.othersPending ? 'btn' : 'btn btn--primary'}
                  disabled={!valid || confirmed}
                  onClick={confirmAnswer}
                >
                  {t(confirmed ? 'mindmap.confirmed' : 'mindmap.confirm')}
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!props.canAdvance}
              onClick={props.onAdvance}
            >
              {t('mindmap.nextPending')} →
            </button>
            {editable && (
              <span className="mindmap-question__keys muted">{t('mindmap.keyboardHint')}</span>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function suggestionKey(suggestion: MindmapSuggestion): string {
  return suggestion.kind === 'empty-category'
    ? `${suggestion.kind}:${JSON.stringify(suggestion.path)}`
    : 'questionId' in suggestion
      ? `${suggestion.kind}:${suggestion.questionId}`
      : suggestion.kind
}
function suggestionText(
  suggestion: MindmapSuggestion,
  t: TFunction,
  number: (id: string) => number,
): string {
  switch (suggestion.kind) {
    case 'empty-category':
      return t('mindmap.suggestions.text.empty-category', { category: suggestion.path.join(' / ') })
    case 'deferred':
    case 'no-rationale':
      return t(`mindmap.suggestions.text.${suggestion.kind}`, {
        count: suggestion.questionIds.length,
      })
    default:
      return t(`mindmap.suggestions.text.${suggestion.kind}`, {
        number: number(suggestion.questionId),
      })
  }
}
