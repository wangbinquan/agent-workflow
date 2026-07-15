// RFC-196: public single-file dropzone contract. These tests lock the real
// button / hidden input / drag-drop / same-file reselect accessibility seams.

import { createRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { FileDropzone, formatShortBytes } from '../src/components/FileDropzone'

function file(name = 'pack.zip', size = 4): File {
  return new File([new Uint8Array(size)], name, { type: 'application/zip' })
}

function Harness(props: {
  disabled?: boolean
  error?: string
  onChange?: (f: File | null) => void
}) {
  const [selected, setSelected] = useState<File | null>(null)
  return (
    <FileDropzone
      file={selected}
      onFileChange={(next) => {
        setSelected(next)
        props.onChange?.(next)
      }}
      accept=".zip"
      disabled={props.disabled}
      title="Drop a file"
      description="One archive only"
      chooseLabel="Choose file"
      replaceLabel="Replace file"
      removeLabel="Remove file"
      error={props.error}
      data-testid="file-picker"
    />
  )
}

describe('FileDropzone (RFC-196)', () => {
  test('real choose button triggers the hidden input and exposes description', () => {
    render(<Harness />)
    const input = screen.getByTestId('file-picker') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    const button = screen.getByRole('button', { name: 'Choose file' })
    fireEvent.click(button)
    expect(click).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-describedby')).not.toBeNull()
  })

  test('input selection and drop each deliver one file', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const picked = file('picked.zip')
    fireEvent.change(screen.getByTestId('file-picker'), { target: { files: [picked] } })
    expect(onChange).toHaveBeenLastCalledWith(picked)
    expect(screen.getByText('picked.zip')).toBeTruthy()

    const dropped = file('dropped.zip')
    fireEvent.drop(screen.getByTestId('file-picker-dropzone'), {
      dataTransfer: { files: [dropped] },
    })
    expect(onChange).toHaveBeenLastCalledWith(dropped)
    expect(screen.getByText('dropped.zip')).toBeTruthy()
  })

  test('clears input value so the same file can be selected again', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const input = screen.getByTestId('file-picker') as HTMLInputElement
    const picked = file()
    fireEvent.change(input, { target: { files: [picked] } })
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { files: [picked] } })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  test('selected summary supports replace and remove', () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('file-picker'), {
      target: { files: [file('large.zip', 2048)] },
    })
    expect(screen.getByText('2 KiB')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Replace file' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }))
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeTruthy()
  })

  test('disabled state rejects button and drop', () => {
    const onChange = vi.fn()
    render(<Harness disabled onChange={onChange} />)
    expect(
      (screen.getByRole('button', { name: 'Choose file' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.drop(screen.getByTestId('file-picker-dropzone'), {
      dataTransfer: { files: [file()] },
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  test('error is announced and associated with the choose button', () => {
    render(<Harness error="Archive is too large" />)
    const alert = screen.getByRole('alert')
    const button = screen.getByRole('button', { name: 'Choose file' })
    expect(alert.textContent).toBe('Archive is too large')
    expect(button.getAttribute('aria-describedby')).toContain(alert.id)
  })

  test('drag state does not change the accessible name', () => {
    render(<Harness />)
    const root = screen.getByTestId('file-picker-dropzone')
    const button = screen.getByRole('button', { name: 'Choose file' })
    fireEvent.dragEnter(root, { dataTransfer: { files: [] } })
    expect(root.classList.contains('file-dropzone--active')).toBe(true)
    expect(button.textContent).toBe('Choose file')
    fireEvent.dragLeave(root, { dataTransfer: { files: [] } })
    expect(root.classList.contains('file-dropzone--active')).toBe(false)
  })

  test('forwards the input and action refs', () => {
    const inputRef = createRef<HTMLInputElement>()
    const buttonRef = createRef<HTMLButtonElement>()
    render(
      <FileDropzone
        file={null}
        onFileChange={() => undefined}
        title="Drop"
        chooseLabel="Choose"
        inputRef={inputRef}
        buttonRef={buttonRef}
      />,
    )
    expect(inputRef.current?.type).toBe('file')
    expect(buttonRef.current?.textContent).toBe('Choose')
  })
})

describe('formatShortBytes', () => {
  test('uses compact binary units', () => {
    expect(formatShortBytes(512)).toBe('512 B')
    expect(formatShortBytes(1536)).toBe('1.5 KiB')
    expect(formatShortBytes(64 * 1024 * 1024)).toBe('64 MiB')
  })
})
