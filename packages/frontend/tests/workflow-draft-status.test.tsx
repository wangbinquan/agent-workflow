// RFC-199 B2/T4 — status/transport projection, terminal action matrix, and
// confirmation safety for the workflow editor draft state machine.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  WorkflowDraftPhase,
  WorkflowDraftTransport,
  WorkflowEditorDraftState,
} from '@/lib/workflow-editor-draft'
import { createWorkflowEditorDraftState } from '@/lib/workflow-editor-draft'
import {
  WorkflowDraftStatus,
  WorkflowDraftStatusSummary,
  type WorkflowDraftStatusProps,
} from '@/components/workflow-editor/WorkflowDraftStatus'
import i18n from '@/i18n'
import type { WorkflowSnapshotHash } from '@agent-workflow/shared'

const HASH_A = 'a'.repeat(64) as WorkflowSnapshotHash
const HASH_B = 'b'.repeat(64) as WorkflowSnapshotHash

function state(
  phase: WorkflowDraftPhase,
  transport: WorkflowDraftTransport = 'online',
): WorkflowEditorDraftState {
  const initial = createWorkflowEditorDraftState({
    revision: { workflowId: 'wf-1', version: 3, snapshotHash: HASH_A, updatedAt: 300 },
    snapshot: {
      name: 'workflow',
      description: 'server',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    },
  })
  return {
    ...initial,
    phase,
    transport,
    revision: 5,
    savedRevision: phase === 'clean' ? 5 : 2,
    local: { ...initial.local, description: 'local draft' },
    error: phase === 'error' ? { kind: 'http', status: 422, message: 'invalid definition' } : null,
    conflict:
      phase === 'conflict'
        ? {
            reason: 'remote-observed',
            current: {
              workflowId: 'wf-1',
              version: 7,
              snapshotHash: HASH_B,
              updatedAt: 700,
            },
            snapshot: { ...initial.server, description: 'remote conflict' },
          }
        : null,
  }
}

function callbacks(): Omit<WorkflowDraftStatusProps, 'state' | 'canSaveCopy'> {
  return {
    onRetryNow: vi.fn(),
    onSaveCopy: vi.fn(),
    onLoadRemote: vi.fn(),
    onOverwriteRemote: vi.fn(),
    onExportLocal: vi.fn(),
    onRetryAccess: vi.fn(),
    onReturnToList: vi.fn(),
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<WorkflowDraftStatus />', () => {
  test('maps every save phase to one short StatusChip independently from transport', () => {
    const cases: Array<[WorkflowDraftPhase, string, string]> = [
      ['clean', 'Saved', 'success'],
      ['dirty', 'Unsaved changes', 'warn'],
      ['saving', 'Saving', 'info'],
      ['reconciling', 'Checking save result', 'info'],
      ['error', 'Save failed', 'danger'],
      ['conflict', 'Version conflict', 'danger'],
      ['inaccessible', 'Inaccessible', 'danger'],
      ['deleted', 'Deleted', 'danger'],
    ]
    const view = render(<WorkflowDraftStatusSummary state={state('clean')} />)

    for (const [phase, label, kind] of cases) {
      view.rerender(<WorkflowDraftStatusSummary state={state(phase)} />)
      const chip = screen.getByTestId('workflow-draft-phase')
      expect(chip.textContent).toBe(label)
      expect(chip.className).toContain(`status-chip--${kind}`)
    }
  })

  test('maps online/degraded/offline on a separate chip and keeps offline notice orthogonal', () => {
    const actions = callbacks()
    const view = render(
      <>
        <WorkflowDraftStatusSummary state={state('conflict', 'online')} />
        <WorkflowDraftStatus state={state('conflict', 'online')} {...actions} />
      </>,
    )
    const cases: Array<[WorkflowDraftTransport, string, string]> = [
      ['online', 'Online', 'success'],
      ['degraded', 'Live sync degraded', 'warn'],
      ['offline', 'Offline', 'danger'],
    ]

    for (const [transport, label, kind] of cases) {
      view.rerender(
        <>
          <WorkflowDraftStatusSummary state={state('conflict', transport)} />
          <WorkflowDraftStatus state={state('conflict', transport)} {...actions} />
        </>,
      )
      const chip = screen.getByTestId('workflow-draft-transport')
      expect(chip.textContent).toBe(label)
      expect(chip.className).toContain(`status-chip--${kind}`)
    }

    expect(screen.getByText('You are offline')).not.toBeNull()
    expect(screen.getByText('A version conflict was detected')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(actions.onRetryNow).toHaveBeenCalledTimes(1)
  })

  test('conflict exposes fixed actions; load confirmation cancels/Escapes with zero callback', async () => {
    const actions = callbacks()
    render(<WorkflowDraftStatus state={state('conflict')} {...actions} />)

    const copy = screen.getByRole('button', { name: 'Save as copy (recommended)' })
    const load = screen.getByRole('button', { name: 'Load remote' })
    const overwrite = screen.getByRole('button', { name: 'Overwrite remote' })
    expect(copy.tagName).toBe('BUTTON')
    expect(load.tagName).toBe('BUTTON')
    expect(overwrite.tagName).toBe('BUTTON')

    fireEvent.click(copy)
    expect(actions.onSaveCopy).toHaveBeenCalledTimes(1)

    fireEvent.click(load)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByText(/remote v7.*local draft r5/i)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(actions.onLoadRemote).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(load)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(actions.onLoadRemote).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(load)
    })

    fireEvent.click(load)
    fireEvent.click(screen.getByRole('button', { name: 'Load remote and discard local changes' }))
    await waitFor(() => expect(actions.onLoadRemote).toHaveBeenCalledTimes(1))
  })

  test('overwrite uses a danger confirmation showing local/base/remote versions', async () => {
    const actions = callbacks()
    render(<WorkflowDraftStatus state={state('conflict')} {...actions} />)

    const trigger = screen.getByRole('button', { name: 'Overwrite remote' })
    fireEvent.click(trigger)
    expect(screen.getByText(/Local draft r5 is based on v3.*remote v7/i)).not.toBeNull()
    const confirm = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Overwrite remote',
    })
    expect(confirm.className).toContain('btn--danger')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(actions.onOverwriteRemote).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(trigger)
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Overwrite remote' }),
    )
    await waitFor(() => expect(actions.onOverwriteRemote).toHaveBeenCalledTimes(1))
  })

  test('leaving conflict closes confirmation and does not reopen it on a later conflict', async () => {
    const actions = callbacks()
    const view = render(<WorkflowDraftStatus state={state('conflict')} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load remote' }))
    expect(screen.getByRole('dialog')).not.toBeNull()

    view.rerender(<WorkflowDraftStatus state={state('clean')} {...actions} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    view.rerender(<WorkflowDraftStatus state={state('conflict')} {...actions} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.onLoadRemote).not.toHaveBeenCalled()
  })

  test('inaccessible never guesses deletion and exposes its fixed action matrix', async () => {
    await i18n.changeLanguage('zh-CN')
    const actions = callbacks()
    const view = render(<WorkflowDraftStatus state={state('inaccessible')} {...actions} />)

    expect(screen.getByText(/已删除或权限已变化/)).not.toBeNull()
    expect(screen.queryByText(/工作流已删除$/)).toBeNull()
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '导出本地 YAML' }))
    fireEvent.click(screen.getByRole('button', { name: '重试访问' }))
    fireEvent.click(screen.getByRole('button', { name: '返回工作流列表' }))
    expect(actions.onExportLocal).toHaveBeenCalledTimes(1)
    expect(actions.onRetryAccess).toHaveBeenCalledTimes(1)
    expect(actions.onReturnToList).toHaveBeenCalledTimes(1)

    view.rerender(<WorkflowDraftStatus state={state('inaccessible')} {...actions} canSaveCopy />)
    fireEvent.click(screen.getByRole('button', { name: '另存为副本' }))
    expect(actions.onSaveCopy).toHaveBeenCalledTimes(1)
  })

  test('deleted retains export/back and conditionally exposes save-copy', () => {
    const actions = callbacks()
    const view = render(<WorkflowDraftStatus state={state('deleted')} {...actions} />)
    expect(screen.getByText('Workflow deleted')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save as copy' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Export local YAML' }))
    fireEvent.click(screen.getByRole('button', { name: 'Return to workflows' }))
    expect(actions.onExportLocal).toHaveBeenCalledTimes(1)
    expect(actions.onReturnToList).toHaveBeenCalledTimes(1)

    view.rerender(<WorkflowDraftStatus state={state('deleted')} {...actions} canSaveCopy />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as copy' }))
    expect(actions.onSaveCopy).toHaveBeenCalledTimes(1)
  })

  test('error and reconciling remain persistent and expose immediate retry', () => {
    const actions = callbacks()
    const view = render(<WorkflowDraftStatus state={state('error')} {...actions} />)
    expect(screen.getByRole('alert').textContent).toContain('Workflow save failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))

    view.rerender(<WorkflowDraftStatus state={state('reconciling')} {...actions} />)
    expect(screen.getByText('Checking the save result')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(actions.onRetryNow).toHaveBeenCalledTimes(2)
  })
})
