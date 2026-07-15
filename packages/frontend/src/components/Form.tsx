// Small form primitives shared by Agent / Skill detail pages. Keep them
// dependency-light: no shadcn until M2 brings in the canvas (P-2-02).

import type { AriaAttributes, ChangeEvent, ReactNode, Ref } from 'react'

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
  errorId,
  errorLive = true,
}: FieldProps) {
  const inner = (
    <>
      <span id={labelId} className="form-field__label">
        {icon !== undefined && (
          <span className="form-field__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {label}
        {required === true && <span className="form-field__required"> *</span>}
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
  if (group === true) {
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
  type?: 'text' | 'number' | 'url' | 'search'
  disabled?: boolean
  required?: boolean
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
  'data-testid'?: string
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  required,
  pattern,
  maxLength,
  'aria-label': ariaLabel,
  className,
  inputRef,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  'data-testid': testid,
}: TextInputProps) {
  return (
    <input
      ref={inputRef}
      className={className === undefined ? 'form-input' : `form-input ${className}`}
      type={type}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      pattern={pattern}
      maxLength={maxLength}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      data-testid={testid}
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
  'data-testid'?: string
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
  disabled,
  'data-testid': testid,
}: NumberInputProps) {
  return (
    <input
      className="form-input"
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
      data-testid={testid}
    />
  )
}

interface TextAreaProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  monospace?: boolean
  disabled?: boolean
  maxLength?: number
  /** Optional ref forwarding for Dialog initial-focus contracts. */
  textareaRef?: Ref<HTMLTextAreaElement>
  'data-testid'?: string
}

export function TextArea({
  value,
  onChange,
  rows = 8,
  placeholder,
  monospace,
  disabled,
  maxLength,
  textareaRef,
  'data-testid': testid,
}: TextAreaProps) {
  return (
    <textarea
      ref={textareaRef}
      className={monospace === true ? 'form-input form-input--mono' : 'form-input'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={maxLength}
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
