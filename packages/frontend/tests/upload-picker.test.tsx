// RFC-020 T6 → RFC-218 T2: UploadPicker is now a thin adapter over the shared
// FilesDropzone primitive (launch upload UX converged with skill/agent import).
// Locks: file rows (name + KiB size), per-row remove, maxCount hint, and a
// source-layer guard that the hand-rolled drag surface stays deleted.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { I18nextProvider } from 'react-i18next'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { UploadPicker } from '../src/components/launch/UploadPicker'
import i18n from '../src/i18n'

function makeFile(name: string, size = 10): File {
  const f = new File(['x'.repeat(size)], name, { type: 'text/plain' })
  return f
}

function wrap(node: React.ReactElement) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
}

function def(extra: Record<string, unknown> = {}): WorkflowInput {
  return { kind: 'upload', key: 'refs', label: 'r', targetDir: 'inputs', ...extra } as WorkflowInput
}

describe('UploadPicker (RFC-218 adapter over FilesDropzone)', () => {
  test('renders one row per selected file with name + size + remove button', () => {
    const files = [makeFile('a.txt', 10), makeFile('b.txt', 2048)]
    render(wrap(<UploadPicker def={def()} files={files} onChange={() => {}} />))
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('b.txt')).toBeTruthy()
    expect(screen.getByText(/2 KiB/)).toBeTruthy()
  })

  test('clicking remove invokes onChange without the dropped index', () => {
    let last: File[] = [makeFile('a.txt'), makeFile('b.txt')]
    const onChange = (next: File[]) => {
      last = next
    }
    const { rerender } = render(wrap(<UploadPicker def={def()} files={last} onChange={onChange} />))
    fireEvent.click(screen.getByTestId('upload-picker-refs-remove-0'))
    expect(last.map((f) => f.name)).toEqual(['b.txt'])
    rerender(wrap(<UploadPicker def={def()} files={last} onChange={onChange} />))
    expect(screen.queryByText('a.txt')).toBeNull()
  })

  test('maxCount is reflected in the hint', () => {
    render(wrap(<UploadPicker def={def({ maxCount: 3 })} files={[]} onChange={() => {}} />))
    expect(screen.getByText(/max 3/)).toBeTruthy()
  })

  test('targetDir / accept / maxFileSize hints render outside the dropzone', () => {
    render(
      wrap(
        <UploadPicker
          def={def({ accept: ['.pdf'], maxFileSize: 1024 })}
          files={[]}
          onChange={() => {}}
        />,
      ),
    )
    expect(screen.getByText(/inputs/)).toBeTruthy()
    expect(screen.getByText(/\.pdf/)).toBeTruthy()
    expect(screen.getByText(/1024/)).toBeTruthy()
  })
})

describe('UploadPicker source guard (RFC-218)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'components', 'launch', 'UploadPicker.tsx'),
    'utf-8',
  )

  test('no hand-rolled drag surface — the dropzone is the shared primitive', () => {
    expect(SRC).toContain('FilesDropzone')
    expect(SRC).not.toContain('upload-picker__drop')
    expect(SRC).not.toContain('onDragOver')
    expect(SRC).not.toContain('onDrop')
  })
})
