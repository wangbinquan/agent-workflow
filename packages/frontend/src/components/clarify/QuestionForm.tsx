// RFC-023 PR-C T21 — single-question form unit.
//
// Renders one ClarifyQuestion + its current ClarifyAnswer with two layouts:
//
//   - kind === 'single': N radio options + an (N+1)-th "Other (custom)" row
//     with a textarea. Mutually exclusive — selecting any option clears
//     customText and unticks "Other"; selecting "Other" clears the option
//     index and enables the textarea.
//
//   - kind === 'multi': N checkboxes + an independent "also include custom
//     text" checkbox + textarea. NOT mutually exclusive — the user can tick
//     any subset of options AND add custom notes.
//
// Keyboard hotkeys: digit keys 1..N select / toggle the matching option.
// (Single-choice picks; multi-choice toggles.) The (N+1) "Other" row is on
// digit (N+1). The hotkeys only fire when the user is NOT focused inside a
// textarea / input field, so typing in the custom field never collides.
//
// The component is fully controlled (no internal state) so the parent
// route (`/clarify/:nodeRunId`) can drive draft persistence in one place.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'
import { CLARIFY_MAX_CUSTOM_TEXT_LEN } from '@agent-workflow/shared'
import { RecommendedChip } from './RecommendedChip'

export interface QuestionFormProps {
  question: ClarifyQuestion
  value: ClarifyAnswer
  /** 1-based index used for the digit hotkeys and the visible Q label. */
  index: number
  onChange: (next: ClarifyAnswer) => void
  /** When true, all inputs are disabled (post-submit / WS race lock). */
  disabled?: boolean
}

export function QuestionForm({ question, value, index, onChange, disabled }: QuestionFormProps) {
  const { t } = useTranslation()
  const groupId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const customRowIndex = question.options.length // 0-based; +1 = digit hotkey

  // single-choice questions can't infer "Other is picked" from ClarifyAnswer
  // alone when customText is empty (empty indices + empty text is also the
  // "no answer yet" state). Track the intent locally so the radio renders
  // visually checked between "user clicked Other" and "user typed text".
  // Reset whenever a real option becomes selected.
  const [otherIntent, setOtherIntent] = useState<boolean>(false)
  useEffect(() => {
    if (value.selectedOptionIndices.length > 0) setOtherIntent(false)
  }, [value.selectedOptionIndices])

  /** Convert a digit key (1..N+1) to the option index it targets. */
  const digitToOptionIdx = useCallback(
    (digit: number): number | null => {
      if (!Number.isInteger(digit)) return null
      if (digit < 1 || digit > question.options.length + 1) return null
      return digit - 1 // 0-based; equals customRowIndex when digit === N+1
    },
    [question.options.length],
  )

  // ----------------------------------------------------------------------
  // change handlers
  // ----------------------------------------------------------------------

  const pickSingleOption = useCallback(
    (idx: number): void => {
      // Mutually exclusive with custom: picking an option clears customText.
      onChange({
        ...value,
        selectedOptionIndices: [idx],
        selectedOptionLabels: [question.options[idx] ?? ''],
        customText: '',
      })
    },
    [onChange, question.options, value],
  )

  const pickSingleCustom = useCallback((): void => {
    setOtherIntent(true)
    onChange({
      ...value,
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      // Keep whatever the user typed; if empty, fine — they'll type next.
    })
  }, [onChange, value])

  const toggleMultiOption = useCallback(
    (idx: number): void => {
      const has = value.selectedOptionIndices.includes(idx)
      const next = has
        ? value.selectedOptionIndices.filter((i) => i !== idx)
        : [...value.selectedOptionIndices, idx].sort((a, b) => a - b)
      onChange({
        ...value,
        selectedOptionIndices: next,
        selectedOptionLabels: next.map((i) => question.options[i] ?? '').filter((s) => s !== ''),
      })
    },
    [onChange, question.options, value],
  )

  const onCustomTextChange = useCallback(
    (text: string): void => {
      // Hard-cap to the shared limit so the user can't paste past the cap and
      // get a server-side 422 on submit.
      const capped =
        text.length > CLARIFY_MAX_CUSTOM_TEXT_LEN
          ? text.slice(0, CLARIFY_MAX_CUSTOM_TEXT_LEN)
          : text
      onChange({ ...value, customText: capped })
    },
    [onChange, value],
  )

  const multiCustomEnabled = value.customText.length > 0
  const toggleMultiCustomEnabled = useCallback(
    (enabled: boolean): void => {
      if (enabled) {
        // Re-enable with empty text — user will fill it in.
        if (value.customText.length === 0) {
          // No-op for the controlled state; textarea becomes editable when the
          // checkbox is checked, so just keep the empty string.
          onChange({ ...value })
        }
      } else {
        onChange({ ...value, customText: '' })
      }
    },
    [onChange, value],
  )

  // ----------------------------------------------------------------------
  // hotkeys: 1..N+1
  // ----------------------------------------------------------------------

  useEffect(() => {
    const root = rootRef.current
    if (root === null || disabled === true) return
    function onKeyDown(e: KeyboardEvent) {
      // Ignore typing inside text inputs / textareas so the user doesn't
      // accidentally trigger an option while filling custom text.
      const target = e.target as HTMLElement | null
      if (target !== null) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const digit = Number.parseInt(e.key, 10)
      const idx = digitToOptionIdx(digit)
      if (idx === null) return
      e.preventDefault()
      if (idx === customRowIndex) {
        if (question.kind === 'single') pickSingleCustom()
        else toggleMultiCustomEnabled(!multiCustomEnabled)
      } else {
        if (question.kind === 'single') pickSingleOption(idx)
        else toggleMultiOption(idx)
      }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [
    customRowIndex,
    digitToOptionIdx,
    disabled,
    multiCustomEnabled,
    pickSingleCustom,
    pickSingleOption,
    question.kind,
    toggleMultiCustomEnabled,
    toggleMultiOption,
  ])

  // ----------------------------------------------------------------------
  // computed state for render
  // ----------------------------------------------------------------------

  const isSingle = question.kind === 'single'
  const singleSelectedIdx = useMemo<number | null>(() => {
    if (!isSingle) return null
    return value.selectedOptionIndices[0] ?? null
  }, [isSingle, value.selectedOptionIndices])
  // Other-row is "active" once the user has either explicitly clicked it
  // (otherIntent) OR typed into the textarea — but NOT in the bare initial
  // state where neither index nor text exists.
  const singleCustomRowActive =
    isSingle && singleSelectedIdx === null && (otherIntent || value.customText.length > 0)

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className={
        'clarify-question' +
        (question.recommended ? ' clarify-question--recommended' : '') +
        ` clarify-question--${question.kind}`
      }
      data-question-id={question.id}
      data-testid={`clarify-question-${question.id}`}
    >
      <div className="clarify-question__header">
        <span className="clarify-question__index">{`Q${index}.`}</span>
        <span className="clarify-question__title">{question.title}</span>
        {question.recommended && <RecommendedChip />}
      </div>
      <div className="clarify-question__options" role={isSingle ? 'radiogroup' : 'group'}>
        {question.options.map((opt, idx) => {
          const checked = isSingle
            ? singleSelectedIdx === idx
            : value.selectedOptionIndices.includes(idx)
          const inputId = `${groupId}_o${idx}`
          return (
            <label key={idx} className="clarify-option" htmlFor={inputId}>
              <input
                id={inputId}
                type={isSingle ? 'radio' : 'checkbox'}
                name={`${groupId}_radio`}
                checked={checked}
                disabled={disabled}
                onChange={() => (isSingle ? pickSingleOption(idx) : toggleMultiOption(idx))}
                data-option-idx={idx}
              />
              <span className="clarify-option__digit">{`${idx + 1}.`}</span>
              <span className="clarify-option__label">{opt}</span>
            </label>
          )
        })}
        {/* Custom row */}
        {isSingle ? (
          <label
            className={
              'clarify-option clarify-option--custom' + (singleCustomRowActive ? ' is-active' : '')
            }
            htmlFor={`${groupId}_custom`}
          >
            <input
              id={`${groupId}_custom`}
              type="radio"
              name={`${groupId}_radio`}
              checked={singleCustomRowActive}
              disabled={disabled}
              onChange={() => pickSingleCustom()}
              data-option-idx={customRowIndex}
              data-testid="clarify-custom-radio"
            />
            <span className="clarify-option__digit">{`${customRowIndex + 1}.`}</span>
            <span className="clarify-option__label">
              {t('clarify.question.single.customLabel')}
            </span>
          </label>
        ) : (
          <label
            className={
              'clarify-option clarify-option--custom' + (multiCustomEnabled ? ' is-active' : '')
            }
            htmlFor={`${groupId}_customcb`}
          >
            <input
              id={`${groupId}_customcb`}
              type="checkbox"
              checked={multiCustomEnabled}
              disabled={disabled}
              onChange={(e) => toggleMultiCustomEnabled(e.target.checked)}
              data-option-idx={customRowIndex}
              data-testid="clarify-custom-checkbox"
            />
            <span className="clarify-option__digit">{`${customRowIndex + 1}.`}</span>
            <span className="clarify-option__label">{t('clarify.question.multi.customLabel')}</span>
          </label>
        )}
      </div>
      {/* Custom textarea — disabled until the user picked the custom row (single)
          or checked the "also include" box (multi). Hard-capped to CLARIFY_MAX_CUSTOM_TEXT_LEN. */}
      <div className="clarify-question__custom">
        <textarea
          className="clarify-custom-input"
          value={value.customText}
          disabled={disabled === true || (isSingle ? !singleCustomRowActive : !multiCustomEnabled)}
          maxLength={CLARIFY_MAX_CUSTOM_TEXT_LEN}
          placeholder={t('clarify.question.multi.customPlaceholder')}
          rows={2}
          onChange={(e) => onCustomTextChange(e.target.value)}
          data-testid="clarify-custom-textarea"
        />
        <p className="muted clarify-question__custom-hint">
          {t('clarify.question.custom.lengthHint', {
            count: value.customText.length,
            max: CLARIFY_MAX_CUSTOM_TEXT_LEN,
          })}
        </p>
      </div>
    </div>
  )
}
