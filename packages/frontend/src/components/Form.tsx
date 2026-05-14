// Small form primitives shared by Agent / Skill detail pages. Keep them
// dependency-light: no shadcn until M2 brings in the canvas (P-2-02).

import type { ChangeEvent, ReactNode } from 'react'

interface FieldProps {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
}

export function Field({ label, hint, required, children }: FieldProps) {
  return (
    <label className="form-field">
      <span className="form-field__label">
        {label}
        {required === true && <span className="form-field__required"> *</span>}
      </span>
      {children}
      {hint !== undefined && <span className="form-field__hint">{hint}</span>}
    </label>
  )
}

interface TextInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'number' | 'url'
  disabled?: boolean
  required?: boolean
  pattern?: string
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  required,
  pattern,
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
}

export function NumberInput({ value, onChange, placeholder, min, max, step }: NumberInputProps) {
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
    />
  )
}

interface TextAreaProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  monospace?: boolean
}

export function TextArea({ value, onChange, rows = 8, placeholder, monospace }: TextAreaProps) {
  return (
    <textarea
      className={monospace === true ? 'form-input form-input--mono' : 'form-input'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
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
