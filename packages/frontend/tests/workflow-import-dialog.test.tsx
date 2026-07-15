// RFC-198 PR5 — transactional WorkflowImportDialog behavior.
// Locks file-read recovery, conflict snapshots/defaults, pending single-fire,
// stable result/reset, and trigger focus restoration without browser prompts.

import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../src/api/client'
import {
  WorkflowImportDialog,
  type WorkflowImportDialogProps,
} from '../src/components/WorkflowImportDialog'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'

function yamlFile(
  raw = 'name: imported\n',
  name = 'workflow.yaml',
  textImpl: () => Promise<string> = async () => raw,
): File {
  const file = new File([raw], name, { type: 'application/yaml' })
  Object.defineProperty(file, 'text', { value: vi.fn(textImpl) })
  return file
}

function setup(
  onImport: WorkflowImportDialogProps['onImport'] = vi
    .fn<WorkflowImportDialogProps['onImport']>()
    .mockResolvedValue(undefined),
) {
  const onClose = vi.fn()
  function Harness() {
    const [open, setOpen] = useState(true)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    return (
      <>
        <button ref={triggerRef} type="button">
          Open import
        </button>
        <WorkflowImportDialog
          open={open}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
          onImport={onImport}
          triggerRef={triggerRef}
        />
      </>
    )
  }
  render(<Harness />)
  return { onImport, onClose }
}

function selectFile(file: File): void {
  fireEvent.change(screen.getByTestId('workflow-import-file'), {
    target: { files: [file] },
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkflowImportDialog', () => {
  test('file.text rejection stays visible and retry reuses the selected file', async () => {
    const onImport = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    setup(onImport)
    const text = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce('name: recovered\n')
    const file = yamlFile('', 'broken.yaml', text)

    selectFile(file)
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect((await screen.findByRole('alert')).textContent).toContain('disk unavailable')
    expect(onImport).not.toHaveBeenCalled()
    expect(screen.getByText('broken.yaml')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenCalledWith('name: recovered\n', 'fail')
    expect(text).toHaveBeenCalledTimes(2)
  })

  test('non-conflict API failure stays in select and retries the same YAML', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(new Error('import service unavailable'))
      .mockResolvedValueOnce(undefined)
    setup(onImport)
    selectFile(yamlFile('name: retry-me\n'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect((await screen.findByRole('alert')).textContent).toContain('import service unavailable')
    expect(screen.getByText('workflow.yaml')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenNthCalledWith(1, 'name: retry-me\n', 'fail')
    expect(onImport).toHaveBeenNthCalledWith(2, 'name: retry-me\n', 'fail')
  })

  test('conflict defaults to new, preserves one YAML snapshot, and retries explicit overwrite', async () => {
    const onImport = vi
      .fn<(yaml: string, mode: 'fail' | 'new' | 'overwrite') => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(409, 'workflow-import-conflict', 'id collides'))
      .mockRejectedValueOnce(new Error('overwrite failed'))
      .mockResolvedValueOnce(undefined)
    setup(onImport)
    const file = yamlFile('id: same\n', 'same.yaml')

    selectFile(file)
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-conflict')).toBeTruthy()
    expect(screen.getByTestId('workflow-import-choice-new').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(onImport).toHaveBeenNthCalledWith(1, 'id: same\n', 'fail')

    fireEvent.click(screen.getByTestId('workflow-import-choice-overwrite'))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect((await screen.findByRole('alert')).textContent).toContain('overwrite failed')
    expect(
      screen.getByTestId('workflow-import-choice-overwrite').getAttribute('aria-checked'),
    ).toBe('true')
    expect(onImport).toHaveBeenNthCalledWith(2, 'id: same\n', 'overwrite')

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenNthCalledWith(3, 'id: same\n', 'overwrite')
    expect(file.text).toHaveBeenCalledTimes(1)
    expect(screen.getByText(enUS.workflows.workflowOverwritten)).toBeTruthy()
  })

  test('the safe conflict default submits new without requiring a magic string', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(new ApiError(409, 'workflow-import-conflict', 'id collides'))
      .mockResolvedValueOnce(undefined)
    setup(onImport)
    selectFile(yamlFile('id: existing\n'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-conflict')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenNthCalledWith(2, 'id: existing\n', 'new')
    expect(screen.getByText(enUS.workflows.importedAsNew)).toBeTruthy()
  })

  test('canceling a conflict performs no second import and restores trigger focus', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(new ApiError(409, 'workflow-import-conflict', 'id collides'))
    const { onClose } = setup(onImport)
    selectFile(yamlFile('id: existing\n'))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-conflict')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: enUS.common.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.textContent).toBe('Open import')
  })

  test('pending is single-fire and locks file changes and every dismiss path', async () => {
    let resolveImport!: () => void
    const onImport = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveImport = resolve
        }),
    )
    const { onClose } = setup(onImport)
    selectFile(yamlFile())

    const submit = screen.getByTestId('workflow-import-submit') as HTMLButtonElement
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    expect(submit.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: enUS.common.cancel }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: enUS.workflows.importDialog.replaceFile,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('workflow-import-dialog')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => resolveImport())
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
  })

  test('result can continue, same-file reselect works, and close restores trigger focus', async () => {
    const { onImport, onClose } = setup()
    const file = yamlFile()
    selectFile(file)
    // FileDropzone clears the native value so the same File can be selected
    // again after a reset without the browser swallowing the change event.
    expect((screen.getByTestId('workflow-import-file') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe(enUS.workflows.importDialog.resultTitle)
    })

    fireEvent.click(screen.getByTestId('workflow-import-another'))
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('workflow-import-file-button'))
    })
    selectFile(file)
    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByTestId('workflow-import-close'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.textContent).toBe('Open import')
  })
})
