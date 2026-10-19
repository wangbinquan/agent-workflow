import { DecisionDetails } from './DecisionDetails'
import { mindmapFollowupLimit } from '@/lib/clarify/mindmap/followup'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clarifyAnswerBasis,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { Field, TextArea } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { useExecutionAvailability } from '@/hooks/useExecutionAvailability'
import { VirtualList } from '@/components/VirtualList'
import type { MindmapNodeSummary } from '@/lib/clarify/mindmap/projection'
import { pendingMindmapDescendants } from '@/lib/clarify/mindmap/navigation'
import { MindmapCounts, MindmapStatus } from './MindmapStatus'

interface Props {
  node: MindmapNodeSummary
  ancestors: readonly MindmapNodeSummary[]
  children: readonly MindmapNodeSummary[]
  question: ClarifyQuestion | undefined
  questionIndex: number
  answer: ClarifyAnswer | undefined
  disabled: boolean
  locked: boolean
  modal: boolean
  onFocusWorkspace(): void
  onCancelFollowup(): void
  pending: boolean
  pendingHere: boolean
  canAdvance: boolean
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
  onAdvance(): void
  onInstruction(value: string): void
  onFollowupOpen(): void
  onFollowup(): void
  renderQuestion(question: ClarifyQuestion, index: number): ReactNode
}

export function MindmapQuestionPane(props: Props) {
  const { t } = useTranslation()
  const execution = useExecutionAvailability('task')
  const heading = useRef<HTMLHeadingElement>(null)
  const reading = useRef<HTMLDivElement>(null)
  const followup = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState('')
  useEffect(() => {
    setSelection('')
    const capture = () => {
      const value = document.getSelection()
      if (
        value?.anchorNode &&
        value.focusNode &&
        reading.current?.contains(value.anchorNode) &&
        reading.current.contains(value.focusNode)
      )
        setSelection(value.toString())
    }
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [props.node.id])
  const limit = mindmapFollowupLimit(props.quote, props.instruction)
  const previous = useRef({ id: props.node.id, open: props.followupOpen })
  useLayoutEffect(() => {
    if (previous.current.id !== props.node.id && reading.current) {
      reading.current.scrollTop = 0
      if (props.modal) heading.current?.focus({ preventScroll: true })
    } else if (props.followupOpen && !previous.current.open && followup.current && reading.current)
      reading.current.scrollTop +=
        followup.current.getBoundingClientRect().top - reading.current.getBoundingClientRect().top
    previous.current = { id: props.node.id, open: props.followupOpen }
  }, [props.node.id, props.followupOpen, props.modal])
  const confirmed = props.question && isClarifyAnswerConfirmed(props.question, props.answer)
  const pendingChildren = pendingMindmapDescendants(props.node)
  const path = props.ancestors.filter((node) => node.id !== 'root')
  const directionForm = !props.disabled && !props.locked && props.followupOpen && (
    <div className="mindmap-question__followup" ref={followup}>
      <h3>
        {t(props.question ? 'mindmap.followupTitle' : 'mindmap.categoryGuidance', {
          number: props.questionIndex + 1,
        })}
      </h3>
      <p className="muted">
        {t(props.question ? 'mindmap.followupContext' : 'mindmap.categoryContext')}
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
      <Field label={t(props.question ? 'mindmap.followupHint' : 'mindmap.categoryHint')}>
        <TextArea
          rows={3}
          placeholder={props.question ? undefined : t('mindmap.categoryPlaceholder')}
          maxLength={2000}
          value={props.instruction}
          onChange={props.onInstruction}
          disabled={props.pendingHere}
        />
      </Field>
      {limit && <p role="alert">{t(`mindmap.quote.${limit}Limit`)}</p>}
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
            : props.question
              ? 'mindmap.followup'
              : 'mindmap.askCategory',
        )}
      </button>
    </div>
  )
  return (
    <>
      <div className="mindmap-question__toolbar">
        <button type="button" className="btn btn--sm btn--ghost" onClick={props.onReturn}>
          ← {t('mindmap.backToMap')}
        </button>
        {props.modal && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={props.onFocusWorkspace}>
            {t('mindmap.openFocus')}
          </button>
        )}
        {props.modal && props.pending && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={props.onCancelFollowup}>
            {t('mindmap.cancelFollowup')}
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
        onSelect={(event) => {
          const field = event.target
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
            setSelection(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0))
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
          {path.some((node) => node.kind === 'question') && (
            <details className="mindmap-question__ancestry">
              <summary>
                {t('mindmap.parentQuestion', { number: path.at(-1)!.order + 1 })} ·{' '}
                {t('mindmap.showPath')}
              </summary>
              {path
                .filter((node) => node.kind === 'question')
                .map((node) => (
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
          <div className="mindmap-question__eyebrow">
            {props.question && (
              <span className="mindmap-question__number">Q{props.questionIndex + 1}</span>
            )}
            <MindmapStatus status={props.node.ownStatus ?? props.node.status} />
            {props.question && pendingChildren > 0 && (
              <span className="muted">
                {t('mindmap.pendingChildren', { count: pendingChildren })}
              </span>
            )}
            {props.pendingHere && (
              <>
                <span role="status">{t('mindmap.generating')}</span>
              </>
            )}
          </div>
          <h2 className="mindmap-question__title" ref={heading} data-dialog-autofocus tabIndex={-1}>
            {props.node.title}
          </h2>
          {props.question ? (
            <>
              {props.renderQuestion(props.question, props.questionIndex)}
              {props.answer && (
                <DecisionDetails
                  answer={props.answer}
                  disabled={props.disabled || props.locked}
                  onChange={props.onChange}
                />
              )}
              {!props.disabled && !props.locked && (
                <div className="mindmap-question__prompts">
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
              <MindmapCounts counts={props.node.counts} />
              {directionForm}
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
                      <MindmapCounts counts={node.counts} />
                    </button>
                  )}
                />
              </div>
            </>
          )}
          {!props.disabled && !props.locked && selection && (
            <div className="mindmap-question__selection">
              <button
                className="btn btn--sm"
                type="button"
                disabled={props.pendingHere || selection.length > 500}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onQuote(selection)
                  setSelection('')
                }}
              >
                {t('mindmap.quote.ask')}
              </button>
              {selection.length > 500 && <p role="alert">{t('mindmap.quote.quoteLimit')}</p>}
            </div>
          )}
          {props.question && directionForm}
          {props.error != null && (
            <div className="mindmap-question__error">
              <p>{t('mindmap.followupFailed')}</p>
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
      </div>
      {props.question && ((!props.disabled && !props.locked) || props.canAdvance) && (
        <div className="mindmap-question__actions">
          {!props.disabled && !props.locked && props.answer && (
            <>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!isClarifyAnswerValid(props.question, props.answer) || confirmed}
                onClick={() =>
                  props.onChange({
                    ...props.answer!,
                    confirmedBasis: clarifyAnswerBasis(props.question!, props.answer!),
                  })
                }
              >
                {t(confirmed ? 'mindmap.confirmed' : 'mindmap.confirm')}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                aria-expanded={props.followupOpen}
                onClick={props.onFollowupOpen}
              >
                {t('mindmap.deepen')}
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
        </div>
      )}
    </>
  )
}
