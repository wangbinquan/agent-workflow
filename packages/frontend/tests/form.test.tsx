import { fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TextArea, TextInput } from '../src/components/Form'

describe('Form primitives', () => {
  test('TextInput forwards the typed HTML and accessibility allowlist', () => {
    const inputRef = createRef<HTMLInputElement>()
    const onChange = vi.fn()
    const { getByTestId } = render(
      <TextInput
        inputRef={inputRef}
        value="secret"
        onChange={onChange}
        type="password"
        id="credential"
        name="credential"
        autoComplete="current-password"
        minLength={8}
        maxLength={64}
        pattern=".{8,}"
        required
        aria-labelledby="credential-label"
        aria-describedby="credential-hint"
        aria-errormessage="credential-error"
        aria-invalid
        data-testid="credential"
      />,
    )

    const input = getByTestId('credential') as HTMLInputElement
    expect(inputRef.current).toBe(input)
    expect(input.type).toBe('password')
    expect(input.id).toBe('credential')
    expect(input.name).toBe('credential')
    expect(input.autocomplete).toBe('current-password')
    expect(input.minLength).toBe(8)
    expect(input.maxLength).toBe(64)
    expect(input.pattern).toBe('.{8,}')
    expect(input.required).toBe(true)
    expect(input.getAttribute('aria-labelledby')).toBe('credential-label')
    expect(input.getAttribute('aria-describedby')).toBe('credential-hint')
    expect(input.getAttribute('aria-errormessage')).toBe('credential-error')
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(input, { target: { value: 'new secret' } })
    expect(onChange).toHaveBeenCalledWith('new secret')
  })

  test.each(['text', 'search', 'email', 'password', 'url', 'tel', 'number'] as const)(
    'TextInput accepts type=%s',
    (type) => {
      const { container } = render(<TextInput value="" onChange={() => {}} type={type} />)
      expect(container.querySelector('input')?.getAttribute('type')).toBe(type)
    },
  )

  test('TextArea preserves ref forwarding and the typed field allowlist', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const onChange = vi.fn()
    const onKeyDown = vi.fn()
    const onSelect = vi.fn()
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    const { getByTestId } = render(
      <TextArea
        textareaRef={textareaRef}
        value="draft"
        onChange={onChange}
        id="notes"
        name="notes"
        autoComplete="off"
        rows={5}
        minLength={2}
        maxLength={200}
        required
        className="composer-input"
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        onFocus={onFocus}
        onBlur={onBlur}
        aria-label="Notes"
        aria-autocomplete="list"
        aria-controls="mention-list"
        aria-activedescendant="mention-2"
        aria-describedby="notes-hint"
        aria-invalid={false}
        data-testid="notes"
      />,
    )

    const textarea = getByTestId('notes') as HTMLTextAreaElement
    expect(textareaRef.current).toBe(textarea)
    expect(textarea.id).toBe('notes')
    expect(textarea.name).toBe('notes')
    expect(textarea.autocomplete).toBe('off')
    expect(textarea.getAttribute('rows')).toBe('5')
    expect(textarea.minLength).toBe(2)
    expect(textarea.maxLength).toBe(200)
    expect(textarea.required).toBe(true)
    expect(textarea.classList.contains('form-input')).toBe(true)
    expect(textarea.classList.contains('composer-input')).toBe(true)
    expect(textarea.getAttribute('aria-label')).toBe('Notes')
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list')
    expect(textarea.getAttribute('aria-controls')).toBe('mention-list')
    expect(textarea.getAttribute('aria-activedescendant')).toBe('mention-2')
    expect(textarea.getAttribute('aria-describedby')).toBe('notes-hint')

    fireEvent.change(textarea, { target: { value: 'updated' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.select(textarea)
    fireEvent.focus(textarea)
    fireEvent.blur(textarea)
    expect(onChange).toHaveBeenCalledWith('updated')
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onFocus).toHaveBeenCalled()
    expect(onBlur).toHaveBeenCalledTimes(1)
  })
})
