// RFC-370: retry activates the actual host, keeps resource drafts mounted and
// never presents an unresolved original execution as ready.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HostExecutionGroupSchema, type HostExecutionStatus } from '@agent-workflow/shared'
import { HostExecutionBanner } from '../src/components/shell/HostExecutionBanner'
import { api } from '../src/api/client'
import i18n from '../src/i18n'

const permission = vi.hoisted(() => ({ allowed: true }))
vi.mock('../src/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/hooks/useActor', () => ({
  useAuthTokenSnapshot: () => 'operator-token',
  useAuthSessionRevision: () => 0,
  usePermission: () => permission.allowed,
}))
const clients: QueryClient[] = []
const blocked: HostExecutionStatus = {
  mode: 'execution',
  status: {
    generation: 'original',
    phase: 'draining',
    readyGroups: [],
    reason: 'host-execution-start-failed',
  },
}
beforeEach(async () => {
  vi.resetAllMocks()
  permission.allowed = true
  await i18n.changeLanguage('en-US')
  vi.mocked(api.get).mockResolvedValue(blocked)
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function open() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <HostExecutionBanner />
      <input aria-label="Resource draft" defaultValue="Preserved resource" />
    </QueryClientProvider>,
  )
}

test('one pending retry waits for actual activation and preserves the resource draft', async () => {
  let resolve!: (value: HostExecutionStatus) => void
  vi.mocked(api.post).mockReturnValue(
    new Promise<HostExecutionStatus>((done) => {
      resolve = done
    }),
  )
  open()
  const draft = screen.getByRole('textbox', { name: 'Resource draft' }) as HTMLInputElement
  fireEvent.change(draft, { target: { value: 'Unsaved edited resource' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Retry execution startup' }))
  await screen.findByRole('button', { name: 'Retrying execution startup' })
  expect(
    (screen.getByRole('button', { name: 'Retrying execution startup' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(api.post).toHaveBeenCalledWith('/api/execution/recover')
  const active: HostExecutionStatus = {
    mode: 'execution',
    status: {
      generation: 'original',
      phase: 'active',
      readyGroups: [...HostExecutionGroupSchema.options],
      reason: null,
    },
  }
  vi.mocked(api.get).mockResolvedValue(active)
  resolve(active)
  await waitFor(() => {
    expect(screen.queryByTestId('host-execution-status')).toBeNull()
  })
  expect(screen.getByRole('textbox', { name: 'Resource draft' })).toBe(draft)
  expect(draft.value).toBe('Unsaved edited resource')
})

test('an original recovery failure stays unavailable and offers another explicit retry', async () => {
  vi.mocked(api.post).mockRejectedValue(new Error('Original execution is still awaiting recovery'))
  open()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry execution startup' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Original execution is still awaiting recovery',
  )
  expect(screen.getByTestId('host-execution-status').textContent).toContain(
    'Recover unsettled executions',
  )
  expect(
    (screen.getByRole('button', { name: 'Retry execution startup' }) as HTMLButtonElement).disabled,
  ).toBe(false)
  expect(api.post).toHaveBeenCalledTimes(1)
})

test('resource-only and read-only sessions do not advertise activation controls', async () => {
  permission.allowed = false
  const view = open()
  await screen.findByTestId('host-execution-status')
  expect(screen.queryByRole('button', { name: 'Retry execution startup' })).toBeNull()
  view.unmount()
  permission.allowed = true
  vi.mocked(api.get).mockResolvedValue({
    mode: 'resource-only',
    status: { generation: 'resource-only', phase: 'standby', readyGroups: [], reason: null },
  })
  open()
  expect((await screen.findByTestId('host-execution-status')).textContent).toContain(
    'Resource editing is available',
  )
  expect(screen.queryByRole('button', { name: 'Retry execution startup' })).toBeNull()
  expect(api.post).not.toHaveBeenCalled()
})
