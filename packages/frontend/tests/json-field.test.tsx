// RFC-201 T3.1: JsonField reports every raw edit together with its current
// parsed/error state so invalid JSON participates in route dirty/guard/save
// contracts instead of leaving the parent on an older valid object.

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  JsonField,
  jsonFieldChangeFromValue,
  type JsonFieldChange,
} from '../src/components/JsonField'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function Harness({
  initial = {},
  onChange,
}: {
  initial?: Record<string, unknown>
  onChange: (next: JsonFieldChange<Record<string, unknown>>) => void
}) {
  const [state, setState] = useState(() => jsonFieldChangeFromValue(initial))
  return (
    <JsonField
      state={state}
      onChange={(next) => {
        setState(next)
        onChange(next)
      }}
      id="json-test"
    />
  )
}

describe('JsonField — raw/parsed/error contract', () => {
  test('empty textarea reports raw text plus parsed `{}` and no error', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ a: 1 }} onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ raw: '', parsed: {} })
  })

  test('reports raw and parsed values for a valid JSON object', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '{"a":1,"b":"x"}' },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      raw: '{"a":1,"b":"x"}',
      parsed: { a: 1, b: 'x' },
    })
  })

  test.each(['[1,2]', 'null', '"text"', '42'])(
    'rejects non-object JSON %s with an actionable message',
    (raw) => {
      const onChange = vi.fn()
      render(<Harness onChange={onChange} />)
      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: raw } })

      expect(onChange.mock.lastCall?.[0]).toMatchObject({ raw })
      expect(onChange.mock.lastCall?.[0].parsed).toBeUndefined()
      expect(onChange.mock.lastCall?.[0].error).toMatch(/JSON object/i)
      expect(textarea.getAttribute('aria-invalid')).toBe('true')
      expect(textarea.getAttribute('aria-describedby')).toBe('json-test-error')
    },
  )

  test('surfaces a stable, understandable syntax error while preserving raw text', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '{not json' } })

    expect(textarea.value).toBe('{not json')
    expect(onChange.mock.lastCall?.[0]).toEqual({
      raw: '{not json',
      error: 'Enter a valid JSON object. Check quotes, commas, and braces.',
    })
    expect(document.getElementById('json-test-error')?.textContent).toContain('quotes')
  })

  test('seeds raw text from the initial semantic value', () => {
    render(<Harness initial={{ x: 1 }} onChange={() => {}} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toContain('"x": 1')
  })
})
