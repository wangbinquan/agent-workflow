// RFC-152 — BatchImportDialog's WS subscription goes through the shared
// WS_PATHS.repoImport constant (double-ended single source; the backend
// registry's pathRe is interlock-tested against WS_PATHS in
// packages/backend/tests/rfc152-ws-paths-interlock.test.ts).
//
// Locks: (1) the socket URL is exactly the WS_PATHS-built path (+token),
// including %-encoding of the batch id; (2) row.update / batch.completed
// frames arriving on that subscription still drive the progress table —
// i.e. swapping the hand-written path for the constant changed nothing
// about message handling. (Deeper row/retry rendering stays covered by
// batch-import-dialog.test.tsx.)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { BatchImportSnapshot } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      postMultipart: vi.fn(),
    },
  }
})

import { api } from '../src/api/client'
import { BatchImportDialog } from '../src/components/repos/BatchImportDialog'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    open: [],
    close: [],
    error: [],
  }
  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).concat(fn)
  }
  removeEventListener(): void {}
  close(): void {
    for (const fn of this.listeners.close ?? []) fn(null)
  }
  fireMessage(data: unknown): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) })
  }
}

const RealWebSocket = globalThis.WebSocket

function mkSnap(batchId: string): BatchImportSnapshot {
  return {
    batchId,
    state: 'running',
    createdAt: '2026-05-17T00:00:00.000Z',
    completedAt: null,
    rows: [
      {
        rowId: 'r1',
        inputUrl: 'https://h/a.git',
        inputUrlRedacted: 'https://h/a.git',
        status: 'queued',
        cold: null,
        fetchOk: null,
        cachedRepoId: null,
        errorCode: null,
        message: null,
        queuedAt: '2026-05-17T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      },
    ],
  }
}

function renderProgress(batchId: string) {
  ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkSnap(batchId))
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <BatchImportDialog
        open
        onClose={() => {}}
        activeBatchId={batchId}
        onActiveBatchIdChange={() => {}}
        canCreate
        canExecute
        hasPermission={() => true}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  MockSocket.instances = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = MockSocket as unknown as typeof WebSocket
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = RealWebSocket
  vi.restoreAllMocks()
})

describe('RFC-152 — BatchImportDialog subscribes via WS_PATHS.repoImport', () => {
  test('socket URL is the WS_PATHS-built path with the token appended', async () => {
    renderProgress('b1')
    await new Promise((r) => setTimeout(r, 10))
    expect(MockSocket.instances.length).toBe(1)
    const url = new URL(MockSocket.instances[0]!.url)
    expect(url.pathname).toBe(new URL(WS_PATHS.repoImport('b1'), 'http://x').pathname)
    expect(url.pathname).toBe('/ws/repo-imports/b1')
    expect(url.searchParams.get('token')).toBe('tok')
  })

  test('batch ids are %-encoded exactly like WS_PATHS does', async () => {
    renderProgress('b/2')
    await new Promise((r) => setTimeout(r, 10))
    const url = new URL(MockSocket.instances[0]!.url)
    expect(url.pathname).toBe(new URL(WS_PATHS.repoImport('b/2'), 'http://x').pathname)
    expect(url.pathname).toBe('/ws/repo-imports/b%2F2')
  })

  test('row.update / batch.completed frames on the subscription still drive the table', async () => {
    renderProgress('b1')
    await new Promise((r) => setTimeout(r, 10))
    const sock = MockSocket.instances[0]!
    sock.fireMessage({
      type: 'row.update',
      row: {
        ...mkSnap('b1').rows[0],
        status: 'done',
        cold: true,
        cachedRepoId: 'cr1',
        message: 'cloned',
        startedAt: '2026-05-17T00:00:00.500Z',
        finishedAt: '2026-05-17T00:00:01.000Z',
      },
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('batch-import-row-r1').getAttribute('data-row-status')).toBe('done')
    sock.fireMessage({
      type: 'batch.completed',
      batchId: 'b1',
      completedAt: '2026-05-17T00:00:02.000Z',
    })
    await new Promise((r) => setTimeout(r, 0))
    // The "import more" footer button only renders once state === completed.
    expect(screen.getByText(/再来一批|Import more/)).toBeTruthy()
  })

  test('no subscription while the dialog is closed', () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mkSnap('b1'))
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <BatchImportDialog
          open={false}
          onClose={() => {}}
          activeBatchId="b1"
          onActiveBatchIdChange={() => {}}
          canCreate
          canExecute
          hasPermission={() => true}
        />
      </QueryClientProvider>,
    )
    expect(MockSocket.instances.length).toBe(0)
  })
})
