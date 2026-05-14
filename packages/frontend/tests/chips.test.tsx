// ChipsInput: Enter commits, comma commits, dup rejected, validate hook
// surfaces error, Backspace on empty removes last chip.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ChipsInput } from '../src/components/ChipsInput'

function setup(initial: string[] = []) {
  const onChange = vi.fn()
  const { rerender } = render(
    <ChipsInput value={initial} onChange={onChange} placeholder="type then enter" />,
  )
  function reRenderWith(value: string[]) {
    rerender(<ChipsInput value={value} onChange={onChange} placeholder="type then enter" />)
  }
  return { onChange, reRenderWith }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChipsInput', () => {
  test('Enter commits and clears pending', () => {
    const { onChange } = setup()
    const input = screen.getByPlaceholderText('type then enter') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['foo'])
    expect(input.value).toBe('')
  })

  test('comma commits the token', () => {
    const { onChange } = setup()
    const input = screen.getByPlaceholderText('type then enter') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bar' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(onChange).toHaveBeenCalledWith(['bar'])
  })

  test('rejects duplicate values', () => {
    const { onChange } = setup(['foo'])
    const input = screen.getByPlaceholderText('') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/duplicate/)).toBeTruthy()
  })

  test('validate hook surfaces error', () => {
    const onChange = vi.fn()
    render(
      <ChipsInput
        value={[]}
        onChange={onChange}
        validate={(t) => (t === 'bad' ? 'no bad words' : null)}
      />,
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bad' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('no bad words')).toBeTruthy()
  })

  test('Backspace on empty input pops the last chip', () => {
    const { onChange } = setup(['a', 'b'])
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith(['a'])
  })

  test('remove button drops the matching chip', () => {
    const { onChange } = setup(['a', 'b'])
    fireEvent.click(screen.getByLabelText('Remove a'))
    expect(onChange).toHaveBeenCalledWith(['b'])
  })
})
