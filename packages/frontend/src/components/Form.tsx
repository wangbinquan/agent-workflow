// Small form primitives shared by Agent / Skill detail pages. Keep them
// dependency-light: no shadcn until M2 brings in the canvas (P-2-02).

import type {
  AriaAttributes,
  AriaRole,
  ChangeEvent,
  CompositionEventHandler,
  FocusEventHandler,
  KeyboardEventHandler,
  ReactEventHandler,
  ReactNode,
  Ref,
} from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { formatUnitValue, type NumberRangeUnit } from '@/lib/formatUnit'

interface FieldProps {
  label: string
  hint?: string
  /** RFC-173: optional leading icon rendered before the label (inline SVG
   *  idiom, stroke="currentColor"). Purely decorative → aria-hidden. */
  icon?: ReactNode
  /** RFC-154: inline validation error rendered under the control (replaces the
   *  hint while present — the error explains what to fix, the hint would repeat). */
  error?: string
  required?: boolean
  children: ReactNode
  // When the field wraps a group of controls (e.g. a segmented radiogroup
  // with multiple <button> elements) rather than a single form control,
  // render as <div> instead of <label>. A <label> wrapping multiple buttons
  // implicitly binds to the first one — clicks/hover on the hint area then
  // proxy to that button, which surprises users.
  group?: boolean
  /** Optional id for callers that need to label a grouped control explicitly. */
  labelId?: string
  /** Field-adjacent action; callers with multiple controls must also use `group`. */
  action?: ReactNode
  /** Optional id for associating the rendered validation error with a control. */
  errorId?: string
  /** Keep an already-announced parent error visual/associated without replaying it live. */
  errorLive?: boolean
}

export function Field({
  label,
  hint,
  icon,
  error,
  required,
  children,
  group,
  labelId,
  action,
  errorId,
  errorLive = true,
}: FieldProps) {
  const inner = (
    <>
      <span className="form-field__heading">
        <span id={labelId} className="form-field__label">
          {icon !== undefined && (
            <span className="form-field__icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {label}
          {required === true && <span className="form-field__required"> *</span>}
        </span>
        {action !== undefined && <span className="form-field__action">{action}</span>}
      </span>
      {children}
      {error !== undefined && error !== '' ? (
        <span id={errorId} className="form-field__error" role={errorLive ? 'alert' : undefined}>
          {error}
        </span>
      ) : (
        hint !== undefined && <span className="form-field__hint">{hint}</span>
      )}
    </>
  )
  if (group === true || action !== undefined) {
    return (
      <div
        className="form-field"
        role={labelId === undefined ? undefined : 'group'}
        aria-labelledby={labelId}
      >
        {inner}
      </div>
    )
  }
  return <label className="form-field">{inner}</label>
}

interface TextInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'search' | 'email' | 'password' | 'url' | 'tel' | 'number'
  id?: string
  name?: string
  autoComplete?: string
  autoFocus?: boolean
  disabled?: boolean
  required?: boolean
  minLength?: number
  pattern?: string
  maxLength?: number
  /** RFC-191: standalone inputs (gallery / toolbar search) carry their own
   *  accessible name — inside a <Field> the label already provides it. */
  'aria-label'?: string
  /** RFC-191: extra classes appended after the standard `form-input`. */
  className?: string
  /** RFC-194: opt-in ref forwarding for Dialog initial-focus contracts. */
  inputRef?: Ref<HTMLInputElement>
  'aria-invalid'?: AriaAttributes['aria-invalid']
  'aria-describedby'?: AriaAttributes['aria-describedby']
  'aria-labelledby'?: AriaAttributes['aria-labelledby']
  'aria-errormessage'?: AriaAttributes['aria-errormessage']
  'aria-controls'?: AriaAttributes['aria-controls']
  'aria-expanded'?: AriaAttributes['aria-expanded']
  'aria-activedescendant'?: AriaAttributes['aria-activedescendant']
  'aria-autocomplete'?: AriaAttributes['aria-autocomplete']
  role?: AriaRole
  'data-testid'?: string
  onFocus?: FocusEventHandler<HTMLInputElement>
  onBlur?: FocusEventHandler<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  onCompositionStart?: CompositionEventHandler<HTMLInputElement>
  onCompositionEnd?: CompositionEventHandler<HTMLInputElement>
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  id,
  name,
  autoComplete,
  autoFocus,
  disabled,
  required,
  minLength,
  pattern,
  maxLength,
  'aria-label': ariaLabel,
  className,
  inputRef,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'aria-labelledby': ariaLabelledBy,
  'aria-errormessage': ariaErrorMessage,
  'aria-controls': ariaControls,
  'aria-expanded': ariaExpanded,
  'aria-activedescendant': ariaActiveDescendant,
  'aria-autocomplete': ariaAutocomplete,
  role,
  'data-testid': testid,
  onFocus,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
}: TextInputProps) {
  return (
    <input
      ref={inputRef}
      className={className === undefined ? 'form-input' : `form-input ${className}`}
      type={type}
      id={id}
      name={name}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      minLength={minLength}
      pattern={pattern}
      maxLength={maxLength}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      aria-labelledby={ariaLabelledBy}
      aria-errormessage={ariaErrorMessage}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-activedescendant={ariaActiveDescendant}
      aria-autocomplete={ariaAutocomplete}
      role={role}
      data-testid={testid}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
    />
  )
}

interface NumberInputProps {
  value: number | undefined
  onChange: (v: number | undefined) => void
  placeholder?: string
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /** Optional compact/contextual classes appended after the standard `form-input`. */
  className?: string
  /** RFC-290: bounded inputs show their range by default; compact inline callers may opt out. */
  rangeHint?: boolean
  /** Override the generated range copy for discontinuous domains such as `0 or min..max`. */
  rangeHintText?: string
  /** RFC-290: optional human conversion for settings whose raw unit is otherwise hard to parse. */
  unit?: NumberRangeUnit
  /** Existing descriptions are preserved when RFC-290 appends the generated range id. */
  'aria-describedby'?: AriaAttributes['aria-describedby']
  'aria-invalid'?: AriaAttributes['aria-invalid']
  'aria-errormessage'?: AriaAttributes['aria-errormessage']
  'data-testid'?: string
  onFocus?: FocusEventHandler<HTMLInputElement>
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
  disabled,
  className,
  rangeHint = true,
  rangeHintText,
  unit,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-errormessage': ariaErrorMessage,
  'data-testid': testid,
  onFocus,
}: NumberInputProps) {
  const { t } = useTranslation()
  const rangeId = useId()
  const showRange = rangeHint && (max !== undefined || rangeHintText !== undefined)
  const descriptions = [ariaDescribedBy, showRange ? rangeId : undefined]
    .filter((id): id is string => id !== undefined && id.trim() !== '')
    .join(' ')

  let rangeText: string | undefined
  if (showRange) {
    if (rangeHintText !== undefined) {
      rangeText = rangeHintText
    } else {
      // `showRange` proves max exists when there is no caller override.
      const rangeMax = max as number
      const rawRange =
        min === undefined
          ? t('common.rangeMaxOnly', { max: rangeMax })
          : t('common.range', { min, max: rangeMax })
      let converted: string | undefined
      if (unit !== undefined) {
        const convertedMax = formatUnitValue(rangeMax, unit, t)
        if (min === undefined) {
          converted = convertedMax ?? undefined
        } else {
          const convertedMin = formatUnitValue(min, unit, t)
          if (convertedMin !== null && convertedMax !== null) {
            converted = `${convertedMin} – ${convertedMax}`
          }
        }
      }
      rangeText =
        converted === undefined
          ? rawRange
          : t('common.rangeConverted', { range: rawRange, converted })
    }
  }

  const input = (
    <input
      className={className === undefined ? 'form-input' : `form-input ${className}`}
      type="number"
      value={value ?? ''}
      onChange={(e) => {
        const s = e.target.value
        if (s === '') {
          onChange(undefined)
          return
        }
        const n = Number(s)
        if (Number.isFinite(n)) onChange(n)
      }}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      aria-errormessage={ariaErrorMessage}
      aria-describedby={descriptions === '' ? undefined : descriptions}
      data-testid={testid}
      onFocus={onFocus}
    />
  )

  if (rangeText === undefined) return input
  return (
    <>
      {input}
      <span id={rangeId} className="form-field__range" aria-hidden="true">
        {rangeText}
      </span>
    </>
  )
}

interface TextAreaProps {
  value: string
  onChange: (v: string) => void
  id?: string
  name?: string
  autoComplete?: string
  autoFocus?: boolean
  rows?: number
  placeholder?: string
  monospace?: boolean
  disabled?: boolean
  required?: boolean
  minLength?: number
  maxLength?: number
  readOnly?: boolean
  className?: string
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>
  onSelect?: ReactEventHandler<HTMLTextAreaElement>
  onFocus?: FocusEventHandler<HTMLTextAreaElement>
  onBlur?: FocusEventHandler<HTMLTextAreaElement>
  /** Optional ref forwarding for Dialog initial-focus contracts. */
  textareaRef?: Ref<HTMLTextAreaElement>
  'aria-label'?: AriaAttributes['aria-label']
  'aria-autocomplete'?: AriaAttributes['aria-autocomplete']
  'aria-controls'?: AriaAttributes['aria-controls']
  'aria-activedescendant'?: AriaAttributes['aria-activedescendant']
  'aria-invalid'?: AriaAttributes['aria-invalid']
  'aria-describedby'?: AriaAttributes['aria-describedby']
  'aria-labelledby'?: AriaAttributes['aria-labelledby']
  'aria-errormessage'?: AriaAttributes['aria-errormessage']
  'data-testid'?: string
}

export function TextArea({
  value,
  onChange,
  id,
  name,
  autoComplete,
  autoFocus,
  rows = 8,
  placeholder,
  monospace,
  disabled,
  required,
  minLength,
  maxLength,
  readOnly,
  className,
  onKeyDown,
  onSelect,
  onFocus,
  onBlur,
  textareaRef,
  'aria-label': ariaLabel,
  'aria-autocomplete': ariaAutocomplete,
  'aria-controls': ariaControls,
  'aria-activedescendant': ariaActiveDescendant,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'aria-labelledby': ariaLabelledBy,
  'aria-errormessage': ariaErrorMessage,
  'data-testid': testid,
}: TextAreaProps) {
  const classes = ['form-input']
  if (monospace === true) classes.push('form-input--mono')
  if (className !== undefined && className !== '') classes.push(className)

  return (
    <textarea
      ref={textareaRef}
      className={classes.join(' ')}
      id={id}
      name={name}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      minLength={minLength}
      maxLength={maxLength}
      readOnly={readOnly}
      onKeyDown={onKeyDown}
      onSelect={onSelect}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-label={ariaLabel}
      aria-autocomplete={ariaAutocomplete}
      aria-controls={ariaControls}
      aria-activedescendant={ariaActiveDescendant}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      aria-labelledby={ariaLabelledBy}
      aria-errormessage={ariaErrorMessage}
      data-testid={testid}
    />
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  /** RFC-192: optional since the /scheduled table cell renders a bare switch —
   *  standalone (label-less) usage MUST pass `aria-label` instead. */
  label?: string
  hint?: string
  /** RFC-164: workgroup free_collab mode renders its three collaboration
   *  switches as forced-on read-only — first caller needing a disabled state. */
  disabled?: boolean
  /** RFC-192: accessible name for the label-less table-cell form. */
  'aria-label'?: string
  'data-testid'?: string
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  'aria-label': ariaLabel,
  'data-testid': testid,
}: SwitchProps) {
  return (
    <label className="form-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        data-testid={testid}
      />
      {label !== undefined && <span>{label}</span>}
      {hint !== undefined && <span className="form-field__hint">{hint}</span>}
    </label>
  )
}

interface CheckboxProps {
  checked: boolean
  onChange: (v: boolean) => void
  /** Optional: a bare grid cell passes `aria-label` instead. */
  label?: string
  hint?: string
  disabled?: boolean
  /** Explains WHY it is disabled — surfaced as the native tooltip. */
  title?: string
  'aria-label'?: string
  'data-testid'?: string
}

/**
 * RFC-247 — a plain checkbox primitive.
 *
 * `Switch` already wraps `<input type="checkbox">`, but it renders a toggle:
 * the right control for "is this feature on", and the wrong one for a dense
 * grid of ~40 independent grants where the user scans columns and needs the
 * ticked ones to read as a set rather than as forty separate settings.
 *
 * Added here rather than inside the token page because five call sites in this
 * repo already hand-roll `<input type="checkbox">` (NodeDetailDrawer,
 * fusion/FuseDialog, memory/MemoryRow, launch/FilesPicker, and Form's own
 * Switch). A sixth private copy would have made "we have no checkbox primitive"
 * permanently true. Same namespace, same `.form-*` styling, same testid
 * conventions as its siblings.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  title,
  'aria-label': ariaLabel,
  'data-testid': testid,
}: CheckboxProps) {
  return (
    <label className="form-checkbox" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        data-testid={testid}
      />
      {label !== undefined && <span className="form-checkbox__label">{label}</span>}
      {hint !== undefined && <span className="form-field__hint">{hint}</span>}
    </label>
  )
}
