// Enum picker for kind=enum inputs (P-2-10 stage 2).
//
// Reads `choices`, `multiSelect`, `allowOther` off the loose WorkflowInput
// shape (passthrough fields). Packed value:
//   - single  → just the chosen string
//   - multi   → JSON array of chosen strings

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkflowInput } from '@agent-workflow/shared'
import { TextInput } from '@/components/Form'

interface Props {
  def: WorkflowInput
  value: string
  onChange: (next: string) => void
}

export function EnumPicker({ def, value, onChange }: Props) {
  const { t } = useTranslation()
  const choices = useMemo(() => {
    const raw = (def as Record<string, unknown>).choices
    if (!Array.isArray(raw)) return [] as string[]
    return raw.filter((c): c is string => typeof c === 'string')
  }, [def])
  const multi = (def as Record<string, unknown>).multiSelect === true
  const allowOther = (def as Record<string, unknown>).allowOther === true

  const current = useMemo<string[]>(() => {
    if (value === '') return []
    if (!multi) return [value]
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? ((parsed as unknown[]).filter((x) => typeof x === 'string') as string[])
        : []
    } catch {
      return []
    }
  }, [multi, value])

  function emit(next: string[]) {
    if (multi) onChange(JSON.stringify(next))
    else onChange(next[0] ?? '')
  }

  const [other, setOther] = useState('')

  function toggle(choice: string) {
    if (!multi) {
      emit([choice])
      return
    }
    const set = new Set(current)
    if (set.has(choice)) set.delete(choice)
    else set.add(choice)
    emit([...set])
  }

  return (
    <div className="enum-picker">
      <ul className="enum-picker__list">
        {choices.map((c) => (
          <li key={c}>
            <label className="enum-picker__row">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={`enum-${c}`}
                checked={current.includes(c)}
                onChange={() => toggle(c)}
              />
              <span>{c}</span>
            </label>
          </li>
        ))}
      </ul>
      {allowOther && (
        <div className="enum-picker__other">
          <TextInput
            value={other}
            onChange={setOther}
            placeholder={t('enumPicker.otherPlaceholder')}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={other.trim() === ''}
            onClick={() => {
              const v = other.trim()
              toggle(v)
              setOther('')
            }}
          >
            {t('enumPicker.add')}
          </button>
        </div>
      )}
    </div>
  )
}
