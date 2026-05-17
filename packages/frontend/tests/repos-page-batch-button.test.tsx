// RFC-033-T7 — /repos page renders the batch-import button and opens the
// dialog on click. Locks in the header wiring so a regression that drops
// either the button or the dialog blows up here.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockResolvedValue({ items: [] }),
      post: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      postMultipart: vi.fn(),
    },
  }
})

// The repos route imports __root which pulls in the TanStack router shell —
// rather than mount the route, render the bare component by importing the
// hidden export.
import { ReposRoute } from '../src/routes/repos'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  try {
    localStorage.removeItem('repo-import-batch-id')
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  // RFC-035 PR3: BatchImportDialog renders via <Dialog> + createPortal.
  // React's own unmount cleans up the portal subtree; manually wiping
  // document.body races with that and throws DOMException in React 19.
  vi.restoreAllMocks()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = ReposRoute.options as unknown as { component: any }
  const Component = opts.component as React.ComponentType
  return render(
    <QueryClientProvider client={qc}>
      <Component />
    </QueryClientProvider>,
  )
}

describe('/repos page batch import button (RFC-033)', () => {
  test('header renders batch-import button', async () => {
    renderPage()
    // Wait for the (empty) query to resolve so the header is fully painted.
    await new Promise((r) => setTimeout(r, 10))
    const btn = screen.getByTestId('repos-batch-import-button')
    expect(btn.textContent ?? '').toMatch(/批量导入|Batch import/)
  })

  test('clicking the button mounts the dialog', async () => {
    renderPage()
    await new Promise((r) => setTimeout(r, 10))
    fireEvent.click(screen.getByTestId('repos-batch-import-button'))
    expect(screen.getByTestId('batch-import-dialog')).toBeTruthy()
  })
})
