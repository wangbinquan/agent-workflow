// RFC-198 PR5 — transactional WorkflowImportDialog behavior.
// Locks file-read recovery, conflict snapshots/defaults, pending single-fire,
// stable result/reset, and trigger focus restoration without browser prompts.

import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowRevision } from '@agent-workflow/shared'
import { ApiError } from '../src/api/client'
import {
  WorkflowImportDialog,
  type WorkflowImportDialogProps,
} from '../src/components/WorkflowImportDialog'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'

function conflictError(workflowId: string): ApiError {
  return new ApiError(409, 'workflow-import-conflict', 'id collides', {
    workflowId,
    current: {
      workflowId,
      version: 7,
      snapshotHash: 'a'.repeat(64),
      updatedAt: 1_720_000_000_000,
    },
  })
}

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
  onRefreshConflict: WorkflowImportDialogProps['onRefreshConflict'] = vi
    .fn<WorkflowImportDialogProps['onRefreshConflict']>()
    .mockImplementation(async (workflowId) => revision(workflowId, 8, 'b')),
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
          onRefreshConflict={onRefreshConflict}
          triggerRef={triggerRef}
        />
      </>
    )
  }
  render(<Harness />)
  return { onImport, onClose, onRefreshConflict }
}

function revision(workflowId: string, version: number, hash = 'a'): WorkflowRevision {
  return {
    workflowId,
    version,
    snapshotHash: hash.repeat(64),
    updatedAt: 1_720_000_000_000 + version,
  }
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
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(conflictError('same'))
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
    const firstOverwrite = onImport.mock.calls[1]?.[2]
    expect(firstOverwrite).toMatchObject({ workflowId: 'same', expectedVersion: 7 })
    expect(firstOverwrite?.clientMutationId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenNthCalledWith(3, 'id: same\n', 'overwrite', firstOverwrite)
    expect(onImport.mock.calls[2]?.[2]?.clientMutationId).toBe(firstOverwrite?.clientMutationId)
    expect(file.text).toHaveBeenCalledTimes(1)
    expect(screen.getByText(enUS.workflows.workflowOverwritten)).toBeTruthy()
  })

  test('overwrite version drift invalidates the old fence and requires a read-only refresh', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(conflictError('same'))
      .mockRejectedValueOnce(
        new ApiError(409, 'workflow-version-conflict', 'workflow changed', {
          current: revision('same', 8, 'b'),
        }),
      )
      .mockResolvedValueOnce(undefined)
    const onRefreshConflict = vi
      .fn<WorkflowImportDialogProps['onRefreshConflict']>()
      .mockResolvedValue(revision('same', 8, 'b'))
    setup(onImport, onRefreshConflict)
    selectFile(yamlFile('id: same\n', 'same.yaml'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-conflict')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workflow-import-choice-overwrite'))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    // RFC-203 PR-2: workflow-version-conflict now has an EXACT L1 entry, so
    // the string-only shell shows the clean localized sentence (no ": raw"
    // suffix — that only survives on domain/fallback tiers).
    expect((await screen.findByRole('alert')).textContent).toContain(
      enUS.errors['workflow-version-conflict'],
    )
    const staleFence = onImport.mock.calls[1]?.[2]
    expect(staleFence).toMatchObject({ workflowId: 'same', expectedVersion: 7 })
    expect(screen.getByTestId('workflow-import-submit').textContent).toBe(
      enUS.workflows.importDialog.refreshConflict,
    )

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    await waitFor(() => expect(onRefreshConflict).toHaveBeenCalledWith('same'))
    expect(onImport).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('workflow-import-submit').textContent).toBe(
      enUS.workflows.importDialog.import,
    )

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    const refreshedFence = onImport.mock.calls[2]?.[2]
    expect(refreshedFence).toMatchObject({ workflowId: 'same', expectedVersion: 8 })
    expect(refreshedFence?.clientMutationId).not.toBe(staleFence?.clientMutationId)
  })

  test('mapping state also refreshes a stale overwrite fence without dropping selections', async () => {
    const selector = { type: 'agent' as const, name: 'planner' }
    const candidates = [
      {
        id: 'agent-owner-a',
        ownerUserId: 'owner-a',
        ownerUsername: 'alice',
        visibility: 'public' as const,
        aclRevision: 3,
      },
      {
        id: 'agent-owner-b',
        ownerUserId: 'owner-b',
        ownerUsername: 'bob',
        visibility: 'public' as const,
        aclRevision: 7,
      },
    ]
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(conflictError('same'))
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-ambiguous', 'ambiguous reference', {
          ambiguities: [{ selector, candidates }],
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'workflow-version-conflict', 'workflow changed', {
          current: revision('same', 8, 'b'),
        }),
      )
      .mockResolvedValueOnce(undefined)
    const onRefreshConflict = vi
      .fn<WorkflowImportDialogProps['onRefreshConflict']>()
      .mockResolvedValue(revision('same', 8, 'b'))
    setup(onImport, onRefreshConflict)
    selectFile(yamlFile('id: same\n', 'same.yaml'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-conflict')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workflow-import-choice-overwrite'))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    const mapping = await screen.findByTestId('workflow-import-mapping-agent-planner')
    fireEvent.click(mapping)
    fireEvent.mouseDown(screen.getByRole('option', { name: /bob/i }))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    expect((await screen.findByRole('alert')).textContent).toContain(
      enUS.errors['workflow-version-conflict'],
    )
    const staleFence = onImport.mock.calls[2]?.[2]
    expect(screen.getByTestId('workflow-import-submit').textContent).toBe(
      enUS.workflows.importDialog.refreshConflict,
    )

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    await waitFor(() => expect(onRefreshConflict).toHaveBeenCalledWith('same'))
    expect(onImport).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    const refreshedFence = onImport.mock.calls[3]?.[2]
    expect(refreshedFence).toMatchObject({ workflowId: 'same', expectedVersion: 8 })
    expect(refreshedFence?.clientMutationId).not.toBe(staleFence?.clientMutationId)
    expect(onImport.mock.calls[3]?.[3]).toEqual([
      { selector, resourceId: 'agent-owner-b', expectedAclRevision: 7 },
    ])
  })

  test('the safe conflict default submits new without requiring a magic string', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(conflictError('existing'))
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

  test('ambiguous workflow references require a stable candidate selection on retry', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-ambiguous', 'ambiguous reference', {
          ambiguities: [
            {
              selector: { type: 'agent', name: 'planner' },
              candidates: [
                {
                  id: 'agent-owner-a',
                  ownerUserId: 'owner-a',
                  ownerUsername: 'alice',
                  visibility: 'public',
                  aclRevision: 3,
                },
                {
                  id: 'agent-owner-b',
                  ownerUserId: 'owner-b',
                  ownerUsername: 'bob',
                  visibility: 'public',
                  aclRevision: 7,
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(undefined)
    setup(onImport)
    selectFile(yamlFile('name: imported\n'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    const mapping = await screen.findByTestId('workflow-import-mapping-agent-planner')
    expect((screen.getByTestId('workflow-import-submit') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(mapping)
    fireEvent.mouseDown(screen.getByRole('option', { name: /bob/i }))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    expect(await screen.findByTestId('workflow-import-result')).toBeTruthy()
    expect(onImport).toHaveBeenNthCalledWith(2, 'name: imported\n', 'fail', undefined, [
      {
        selector: { type: 'agent', name: 'planner' },
        resourceId: 'agent-owner-b',
        expectedAclRevision: 7,
      },
    ])
  })

  test('a stale workflow mapping requires fresh confirmation even with one candidate left', async () => {
    const selector = { type: 'agent' as const, name: 'planner' }
    const alice = {
      id: 'agent-owner-a',
      ownerUserId: 'owner-a',
      ownerUsername: 'alice',
      visibility: 'public' as const,
      aclRevision: 3,
    }
    const bob = {
      id: 'agent-owner-b',
      ownerUserId: 'owner-b',
      ownerUsername: 'bob',
      visibility: 'public' as const,
      aclRevision: 7,
    }
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-ambiguous', 'ambiguous reference', {
          ambiguities: [{ selector, candidates: [alice, bob] }],
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, 'import-ref-selection-stale', 'stale selection', {
          selector,
          ambiguities: [{ selector, candidates: [alice] }],
        }),
      )
    setup(onImport)
    selectFile(yamlFile('name: imported\n'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    const mapping = await screen.findByTestId('workflow-import-mapping-agent-planner')
    fireEvent.click(mapping)
    fireEvent.mouseDown(screen.getByRole('option', { name: /bob/i }))
    fireEvent.click(screen.getByTestId('workflow-import-submit'))

    await waitFor(() => expect(mapping.textContent).toContain('Select resource owner'))
    expect(onImport).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('workflow-import-result')).toBeNull()
    expect((screen.getByTestId('workflow-import-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mapping)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /alice/i })).toBeTruthy()
  })

  test('canceling a conflict performs no second import and restores trigger focus', async () => {
    const onImport = vi
      .fn<WorkflowImportDialogProps['onImport']>()
      .mockRejectedValueOnce(conflictError('existing'))
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

  test('a malformed conflict without the exact current revision fails closed', async () => {
    const onImport = vi.fn<WorkflowImportDialogProps['onImport']>().mockRejectedValueOnce(
      new ApiError(409, 'workflow-import-conflict', 'id collides', {
        workflowId: 'existing',
        current: { workflowId: 'existing', version: 7 },
      }),
    )
    setup(onImport)
    selectFile(yamlFile('id: existing\n'))

    fireEvent.click(screen.getByTestId('workflow-import-submit'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByTestId('workflow-import-conflict')).toBeNull()
    expect(onImport).toHaveBeenCalledTimes(1)
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
