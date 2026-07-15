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
// Keyboard hotkeys (reviewer ergonomics):
//   - digit keys 1..N select / toggle the matching option (single picks,
//     multi toggles); (N+1) is the "Other (custom)" row.
//   - Enter → call `onAdvance()` to jump to the next question / submit.
//   - For single-choice, a digit key that picks a normal option (1..N) also
//     triggers `onAdvance()` so the reviewer can fly through the form with
//     just digits. Picking the custom row (N+1) does NOT advance; instead it
//     auto-focuses the textarea so the reviewer can immediately type.
//   - For multi-choice, digit keys never auto-advance (the reviewer needs
//     to tick multiple boxes before moving on); Enter is the explicit advance.
//   - Hotkeys only fire when the user is NOT focused inside a textarea /
//     input field, so typing in the custom field never collides.
//
// The component is fully controlled (no internal state) so the parent
// route (`/clarify/:nodeRunId`) can drive draft persistence in one place.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'
import { CLARIFY_MAX_CUSTOM_TEXT_LEN } from '@agent-workflow/shared'
import { TextArea } from '@/components/Form'

export interface QuestionFormProps {
  question: ClarifyQuestion
  value: ClarifyAnswer
  /** 1-based index used for the digit hotkeys and the visible Q label. */
  index: number
  onChange: (next: ClarifyAnswer) => void
  /** When true, all inputs are disabled (post-submit / WS race lock). */
  disabled?: boolean
  /**
   * Called when the reviewer signals "advance to next question": pressing
   * Enter (outside the custom textarea), or — for single-choice — picking
   * a normal option (1..N) via digit hotkey. The parent decides what
   * "next" means (focus next QuestionForm, or focus the submit button when
   * this is the last question).
   */
  onAdvance?: () => void
}

export interface QuestionFormHandle {
  /** Move keyboard focus onto this question's root for digit / Enter hotkeys. */
  focus: () => void
}

export const QuestionForm = forwardRef<QuestionFormHandle, QuestionFormProps>(function QuestionForm(
  { question, value, index, onChange, disabled, onAdvance },
  forwardedRef,
) {
  const { t } = useTranslation()
  const groupId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const customTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const customRowIndex = question.options.length // 0-based; +1 = digit hotkey

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => {
        const el = rootRef.current
        if (el === null) return
        // Suppress the native focus auto-scroll (`block: 'nearest'`)
        // so we can deterministically align the card's top with the
        // viewport top. Without this, when the next question is already
        // partially visible the browser doesn't scroll at all — and
        // reviewers reported "看不到现在在回答哪个问题" because the
        // active card stayed mid-page. `block: 'start'` clamps at the
        // scroll container's bottom, so the last question simply
        // scrolls as far as it can — matching the "scroll to top
        // unless we're already at the bottom" UX.
        el.focus({ preventScroll: true })
        // Scroll the wrapper (which on cross-clarify carries the scope
        // picker above this card) so the per-question scope segmented
        // control stays in view — otherwise the auto-scroll clipped it
        // off the top and reviewers couldn't see which scope was set.
        // Self-clarify wraps with the same class but only contains this
        // QuestionForm, so the behaviour is identical to before.
        const scrollTarget = el.closest('.clarify-question-wrapper') ?? el
        scrollTarget.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    }),
    [],
  )

  // single-choice questions can't infer "Other is picked" from ClarifyAnswer
  // alone when customText is empty (empty indices + empty text is also the
  // "no answer yet" state). Track the intent locally so the radio renders
  // visually checked between "user clicked Other" and "user typed text".
  // Reset whenever a real option becomes selected.
  const [otherIntent, setOtherIntent] = useState<boolean>(false)
  useEffect(() => {
    if (value.selectedOptionIndices.length > 0) setOtherIntent(false)
  }, [value.selectedOptionIndices])
  // multi-choice has the same problem: deriving the "custom checkbox is
  // checked" state purely from `customText.length > 0` means the first
  // click on the empty checkbox is a no-op (nothing changes customText →
  // the next render still shows it unchecked → user can't tick it).
  // Mirror the single-choice `otherIntent` pattern: a local intent flag
  // that's seeded from the incoming customText (so already-drafted multi
  // answers render checked) and flipped explicitly on each click. The
  // visual `multiCustomEnabled` is the OR of intent + non-empty text so
  // sealed history answers (with text but no intent flag) still render
  // checked when the page mounts.
  const [multiCustomIntent, setMultiCustomIntent] = useState<boolean>(value.customText.length > 0)

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
        selectedOptionLabels: [question.options[idx]?.label ?? ''],
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
        selectedOptionLabels: next
          .map((i) => question.options[i]?.label ?? '')
          .filter((s) => s !== ''),
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

  const multiCustomEnabled = multiCustomIntent || value.customText.length > 0
  const toggleMultiCustomEnabled = useCallback(
    (enabled: boolean): void => {
      // Always flip the intent flag — that's what makes the next render
      // observe the new checked state. The previous version only mutated
      // `value.customText`, but the case "user clicks the empty checkbox"
      // had no field to update, so the click was a no-op (Bug #12 root
      // cause). Unchecking additionally clears any typed text so the
      // sealed answer doesn't carry stale free-text from a previous draft.
      setMultiCustomIntent(enabled)
      if (!enabled && value.customText.length > 0) {
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
      // accidentally trigger an option while filling custom text. Enter
      // inside the textarea still inserts a newline (browser default).
      const target = e.target as HTMLElement | null
      if (target !== null) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Enter → advance to next question / submit. Works on both single and
      // multi; the reviewer uses this after they've finished toggling boxes
      // (multi) or as a no-op confirm (single, since digit already advanced).
      if (e.key === 'Enter') {
        e.preventDefault()
        onAdvance?.()
        return
      }
      const digit = Number.parseInt(e.key, 10)
      const idx = digitToOptionIdx(digit)
      if (idx === null) return
      e.preventDefault()
      if (idx === customRowIndex) {
        if (question.kind === 'single') {
          pickSingleCustom()
          // Focus the textarea so the reviewer can type immediately. Defer
          // via rAF so React has rendered the now-active textarea state.
          requestAnimationFrame(() => customTextareaRef.current?.focus())
        } else {
          toggleMultiCustomEnabled(!multiCustomEnabled)
        }
      } else {
        if (question.kind === 'single') {
          pickSingleOption(idx)
          // Single-choice + normal option pick is a complete answer → advance.
          // (Multi never auto-advances; reviewer presses Enter when done.)
          onAdvance?.()
        } else {
          toggleMultiOption(idx)
        }
      }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [
    customRowIndex,
    digitToOptionIdx,
    disabled,
    multiCustomEnabled,
    onAdvance,
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
      className={'clarify-question' + ` clarify-question--${question.kind}`}
      data-question-id={question.id}
      data-testid={`clarify-question-${question.id}`}
    >
      <div className="clarify-question__header">
        <span className="clarify-question__index">{`Q${index}.`}</span>
        <span className="clarify-question__title">{question.title}</span>
      </div>
      <div className="clarify-question__options" role={isSingle ? 'radiogroup' : 'group'}>
        {question.options.map((opt, idx) => {
          const checked = isSingle
            ? singleSelectedIdx === idx
            : value.selectedOptionIndices.includes(idx)
          const inputId = `${groupId}_o${idx}`
          return (
            <label
              key={idx}
              className={
                'clarify-option' +
                (checked ? ' is-checked' : '') +
                (opt.recommended ? ' is-recommended' : '')
              }
              htmlFor={inputId}
              data-option-recommended={opt.recommended ? 'true' : undefined}
            >
              <input
                id={inputId}
                type={isSingle ? 'radio' : 'checkbox'}
                name={`${groupId}_radio`}
                checked={checked}
                disabled={disabled}
                onChange={() => (isSingle ? pickSingleOption(idx) : toggleMultiOption(idx))}
                data-option-idx={idx}
              />
              <span className="clarify-option__digit" aria-hidden="true">{`${idx + 1}`}</span>
              <span className="clarify-option__body">
                <span className="clarify-option__label-row">
                  <span className="clarify-option__label">{opt.label}</span>
                  {opt.recommended && (
                    <span
                      className="clarify-option__recommended-badge"
                      data-testid={`clarify-option-recommended-${idx}`}
                    >
                      {t('clarify.option.recommendedBadge')}
                    </span>
                  )}
                </span>
                {opt.description.length > 0 && (
                  <span
                    className="clarify-option__description muted"
                    data-testid={`clarify-option-description-${idx}`}
                  >
                    {opt.description}
                  </span>
                )}
                {opt.recommended && opt.recommendationReason.length > 0 && (
                  <span
                    className="clarify-option__reason"
                    data-testid={`clarify-option-reason-${idx}`}
                  >
                    <span className="clarify-option__reason-label">
                      {t('clarify.option.reasonLabel')}:
                    </span>{' '}
                    {opt.recommendationReason}
                  </span>
                )}
              </span>
            </label>
          )
        })}
        {/* Custom row — visually paired with the textarea below via CSS. */}
        {isSingle ? (
          <label
            className={
              'clarify-option clarify-option--custom' +
              (singleCustomRowActive ? ' is-checked is-active' : '')
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
            <span className="clarify-option__digit" aria-hidden="true">{`${
              customRowIndex + 1
            }`}</span>
            <span className="clarify-option__label">
              {t('clarify.question.single.customLabel')}
            </span>
          </label>
        ) : (
          <label
            className={
              'clarify-option clarify-option--custom' +
              (multiCustomEnabled ? ' is-checked is-active' : '')
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
            <span className="clarify-option__digit" aria-hidden="true">{`${
              customRowIndex + 1
            }`}</span>
            <span className="clarify-option__label">{t('clarify.question.multi.customLabel')}</span>
          </label>
        )}
      </div>
      {/* Custom textarea — disabled until the user picked the custom row (single)
          or checked the "also include" box (multi). Hard-capped to CLARIFY_MAX_CUSTOM_TEXT_LEN.
          Visually attached to the custom option card above via CSS when active. */}
      <div
        className={
          'clarify-question__custom' +
          ((isSingle ? singleCustomRowActive : multiCustomEnabled) ? ' is-active' : '')
        }
      >
        <TextArea
          textareaRef={customTextareaRef}
          className="clarify-custom-input"
          value={value.customText}
          disabled={disabled === true || (isSingle ? !singleCustomRowActive : !multiCustomEnabled)}
          maxLength={CLARIFY_MAX_CUSTOM_TEXT_LEN}
          placeholder={t('clarify.question.multi.customPlaceholder')}
          rows={3}
          onChange={onCustomTextChange}
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
})
