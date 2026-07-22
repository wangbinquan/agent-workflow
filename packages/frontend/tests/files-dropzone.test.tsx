// RFC-218 T1: multi-file dropzone contract (FilesDropzone, FileDropzone
// family). Locks the seams the launch upload surface depends on: real choose
// button + hidden multiple input, drag-drop merge, name+size dedup, maxCount
// cap (incl. choose-button disable at cap), per-file remove, error alert.

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { FilesDropzone } from '../src/components/FileDropzone'

function file(name: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type: 'text/plain' })
}

function Harness(props: {
  maxCount?: number
  disabled?: boolean
  error?: string
  initial?: File[]
  onChange?: (next: File[]) => void
}) {
  const [files, setFiles] = useState<File[]>(props.initial ?? [])
  return (
    <FilesDropzone
      files={files}
      onFilesChange={(next) => {
        setFiles(next)
        props.onChange?.(next)
      }}
      accept=".txt"
      maxCount={props.maxCount}
      disabled={props.disabled}
      title="Drop files"
      description="Any text files"
      chooseLabel="Choose files"
      removeLabel="Remove"
      error={props.error}
      data-testid="multi-picker"
    />
  )
}

describe('FilesDropzone (RFC-218)', () => {
  test('real choose button triggers the hidden multiple input', () => {
    render(<Harness />)
    const input = screen.getByTestId('multi-picker') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Choose files' }))
    expect(click).toHaveBeenCalledOnce()
  })

  test('input selection and drop merge into the list; name+size dupes skipped', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(screen.getByTestId('multi-picker'), {
      target: { files: [file('a.txt', 4), file('b.txt', 8)] },
    })
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('b.txt')).toBeTruthy()

    // Drop a dupe of a.txt (same name+size) plus a fresh c.txt → only c lands.
    fireEvent.drop(screen.getByTestId('multi-picker-dropzone'), {
      dataTransfer: { files: [file('a.txt', 4), file('c.txt', 2)] },
    })
    const names = onChange.mock.calls.at(-1)?.[0].map((f: File) => f.name)
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  test('maxCount caps additions and disables the choose button at the cap', () => {
    render(<Harness maxCount={2} />)
    fireEvent.change(screen.getByTestId('multi-picker'), {
      target: { files: [file('a.txt'), file('b.txt', 8), file('c.txt', 2)] },
    })
    expect(screen.queryByText('c.txt')).toBeNull()
    const button = screen.getByRole('button', { name: 'Choose files' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  test('per-file remove drops exactly that row and re-enables adding', () => {
    render(<Harness maxCount={2} initial={[file('a.txt'), file('b.txt', 8)]} />)
    fireEvent.click(screen.getByTestId('multi-picker-remove-0'))
    expect(screen.queryByText('a.txt')).toBeNull()
    expect(screen.getByText('b.txt')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Choose files' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  test('error renders as role=alert; disabled blocks drop', () => {
    const onChange = vi.fn()
    render(<Harness disabled error="too big" onChange={onChange} />)
    expect(screen.getByRole('alert').textContent).toBe('too big')
    fireEvent.drop(screen.getByTestId('multi-picker-dropzone'), {
      dataTransfer: { files: [file('a.txt')] },
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
