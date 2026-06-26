// RFC-109 — WorkflowSyncBanner + WorkflowSyncDialog.
//
// Locks:
//   1. banner renders only when the preview is syncable AND differs;
//   2. hidden when !differs (banner is invisible by default);
//   3. opening the dialog shows the version delta + added nodes;
//   4. confirm is DISABLED when the live definition is invalid or blocked;
//   5. confirm POSTs sync-workflow with the previewed latestVersion as
//      expectedVersion (Codex F5).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkflowSyncPreview } from '@agent-workflow/shared'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkflowSyncBanner } from '../src/components/tasks/WorkflowSyncBanner'
import '../src/i18n'

function preview(over: Partial<WorkflowSyncPreview> = {}): WorkflowSyncPreview {
  return {
    syncable: true,
    reason: 'ok',
    workflowId: 'wf1',
    workflowName: 'wf',
    currentVersion: 1,
    latestVersion: 2,
    differs: true,
    invalid: false,
    invalidIssues: [],
    diff: {
      differs: true,
      added: [{ nodeId: 'n', label: 'New Node', kind: 'agent-single' }],
      removed: [],
      modified: [],
      warnings: [],
      blockers: [],
    },
    ...over,
  }
}

interface FetchCapture {
  syncBody?: unknown
}

function installFetch(p: WorkflowSyncPreview): FetchCapture {
  const cap: FetchCapture = {}
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/workflow-sync-preview')) {
        return new Response(JSON.stringify(p), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/sync-workflow')) {
        cap.syncBody = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
        return new Response(JSON.stringify({ id: 't1', status: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
  return cap
}

function renderBanner() {
  setBaseUrl('')
  setToken('tok')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkflowSyncBanner taskId="t1" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-109 WorkflowSyncBanner', () => {
  test('renders when syncable && differs', async () => {
    installFetch(preview())
    renderBanner()
    expect(await screen.findByTestId('workflow-sync-banner')).toBeTruthy()
    // version delta shown
    expect(screen.getByTestId('workflow-sync-banner').textContent).toContain('v1 → v2')
  })

  test('hidden when definitions are identical (differs=false)', async () => {
    installFetch(
      preview({
        differs: false,
        diff: { differs: false, added: [], removed: [], modified: [], warnings: [], blockers: [] },
      }),
    )
    renderBanner()
    // give the query a tick to resolve, then assert no banner
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('workflow-sync-banner')).toBeNull()
  })

  test('hidden when not syncable (active task)', async () => {
    installFetch(preview({ syncable: false, reason: 'task-active' }))
    renderBanner()
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('workflow-sync-banner')).toBeNull()
  })

  test('opening the dialog shows added nodes; confirm posts expectedVersion=latestVersion', async () => {
    const cap = installFetch(preview())
    renderBanner()
    fireEvent.click(await screen.findByTestId('workflow-sync-open'))
    expect(await screen.findByTestId('workflow-sync-dialog')).toBeTruthy()
    expect(screen.getByTestId('workflow-sync-added').textContent).toContain('New Node')

    fireEvent.click(screen.getByTestId('workflow-sync-confirm'))
    await waitFor(() => expect(cap.syncBody).toEqual({ expectedVersion: 2 }))
  })

  test('confirm disabled when the latest definition is invalid', async () => {
    installFetch(
      preview({
        invalid: true,
        invalidIssues: [{ code: 'edge-source-node-missing', message: 'bad' }],
      }),
    )
    renderBanner()
    fireEvent.click(await screen.findByTestId('workflow-sync-open'))
    const confirm = (await screen.findByTestId('workflow-sync-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  test('confirm disabled when a wrapper blocker is present', async () => {
    installFetch(
      preview({
        diff: {
          differs: true,
          added: [],
          removed: [],
          modified: [],
          warnings: [],
          blockers: [
            { code: 'wrapper-structure-changed-with-live-state', nodeId: 'w', detail: 'x' },
          ],
        },
      }),
    )
    renderBanner()
    fireEvent.click(await screen.findByTestId('workflow-sync-open'))
    const confirm = (await screen.findByTestId('workflow-sync-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })
})
