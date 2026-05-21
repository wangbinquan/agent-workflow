// Small form primitives shared by Agent / Skill detail pages. Keep them
// dependency-light: no shadcn until M2 brings in the canvas (P-2-02).

import type { ChangeEvent, ReactNode } from 'react'

interface FieldProps {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
  // When the field wraps a group of controls (e.g. a segmented radiogroup
  // with multiple <button> elements) rather than a single form control,
  // render as <div> instead of <label>. A <label> wrapping multiple buttons
  // implicitly binds to the first one — clicks/hover on the hint area then
  // proxy to that button, which surprises users.
  group?: boolean
}

export function Field({ label, hint, required, children, group }: FieldProps) {
  const inner = (
    <>
      <span className="form-field__label">
        {label}
        {required === true && <span className="form-field__required"> *</span>}
      </span>
      {children}
      {hint !== undefined && <span className="form-field__hint">{hint}</span>}
    </>
  )
  if (group === true) {
    return <div className="form-field">{inner}</div>
  }
  return <label className="form-field">{inner}</label>
}

interface TextInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'number' | 'url'
  disabled?: boolean
  required?: boolean
  pattern?: string
  maxLength?: number
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
  'data-testid': testid,
}: TextInputProps) {
  return (
    <input
      className="form-input"
      type={type}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      pattern={pattern}
      maxLength={maxLength}
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
  'data-testid'?: string
}

export function TextArea({
  value,
  onChange,
  rows = 8,
  placeholder,
  monospace,
  disabled,
  'data-testid': testid,
}: TextAreaProps) {
  return (
    <textarea
      className={monospace === true ? 'form-input form-input--mono' : 'form-input'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      data-testid={testid}
    />
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}

export function Switch({ checked, onChange, label, hint }: SwitchProps) {
  return (
    <label className="form-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint !== undefined && <span className="form-field__hint">{hint}</span>}
    </label>
  )
}
