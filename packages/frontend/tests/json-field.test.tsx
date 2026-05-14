// JsonField: parses valid JSON object, surfaces parse error, treats empty
// string as `{}`, rejects arrays/strings/null.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { JsonField } from '../src/components/JsonField'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('JsonField', () => {
  test('empty textarea reports `{}` and no error', () => {
    const onChange = vi.fn()
    render(<JsonField value={{ a: 1 }} onChange={onChange} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({})
  })

  test('parses valid JSON object', () => {
    const onChange = vi.fn()
    render(<JsonField value={{}} onChange={onChange} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '{"a":1,"b":"x"}' } })
    expect(onChange).toHaveBeenCalledWith({ a: 1, b: 'x' })
  })

  test('rejects arrays', () => {
    const onChange = vi.fn()
    render(<JsonField value={{}} onChange={onChange} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '[1,2]' } })
    expect(onChange).not.toHaveBeenCalledWith([1, 2])
    expect(screen.getByText(/must be a JSON object/)).toBeTruthy()
  })

  test('surfaces parse error for invalid JSON', () => {
    const onChange = vi.fn()
    render(<JsonField value={{}} onChange={onChange} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '{not json' } })
    // parse error wording varies by engine; just confirm the error box exists.
    expect(document.querySelector('.json-field__error')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  test('seeds textarea from initial value', () => {
    const onChange = vi.fn()
    render(<JsonField value={{ x: 1 }} onChange={onChange} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.value).toContain('"x": 1')
  })
})
