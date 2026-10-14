// RFC-370: retry activates the actual host, keeps resource drafts mounted and
// never presents an unresolved original execution as ready. A background status
// failure must preserve confirmed native behavior within the same login session,
// while initial/managed errors and a new session still wait for their own status.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HostExecutionGroupSchema, type HostExecutionStatus } from '@agent-workflow/shared'
import { HostExecutionBanner } from '../src/components/shell/HostExecutionBanner'
import { api } from '../src/api/client'
import i18n from '../src/i18n'
import {
  HostExecutionProvider,
  useHostExecutionAvailability,
} from '../src/hooks/useHostExecutionAvailability'
import {
  HOST_EXECUTION_STATUS_QUERY_KEY,
  useHostExecutionStatus,
} from '../src/hooks/useHostExecutionStatus'

const permission = vi.hoisted(() => ({ allowed: true, revision: 0 }))
vi.mock('../src/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../src/hooks/useActor', () => ({
  useAuthTokenSnapshot: () => 'operator-token',
  useAuthSessionRevision: () => permission.revision,
  usePermission: () => permission.allowed,
}))
const clients: QueryClient[] = []
const execute = vi.fn()
const native: HostExecutionStatus = { mode: 'native', status: null }
const active: HostExecutionStatus = {
  mode: 'execution',
  status: {
    generation: 'original',
    phase: 'active',
    readyGroups: [...HostExecutionGroupSchema.options],
    reason: null,
  },
}
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
  permission.revision = 0
  await i18n.changeLanguage('en-US')
  vi.mocked(api.get).mockResolvedValue(blocked)
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function ExecutionAction() {
  const task = useHostExecutionAvailability('task')
  const query = useHostExecutionStatus()
  return (
    <>
      <output aria-label="Execution status request">{query.status}</output>
      <button
        className="btn"
        disabled={!task.available}
        title={task.unavailableReason}
        onClick={() => {
          task.assertAvailable()
          execute()
        }}
      >
        Launch task
      </button>
    </>
  )
}

function open() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  clients.push(client)
  const content = () => (
    <QueryClientProvider client={client}>
      <HostExecutionProvider>
        <HostExecutionBanner />
        <ExecutionAction />
      </HostExecutionProvider>
      <input aria-label="Resource draft" defaultValue="Preserved resource" />
    </QueryClientProvider>
  )
  return { ...render(content()), client, content }
}

function launchButton() {
  return screen.getByRole('button', { name: 'Launch task' }) as HTMLButtonElement
}

async function expectStatus(status: 'pending' | 'success' | 'error') {
  await waitFor(() => {
    expect(screen.getByLabelText('Execution status request').textContent).toBe(status)
  })
}

test('a confirmed native session keeps execution and its current guard available after a background error', async () => {
  vi.mocked(api.get).mockResolvedValue(native)
  const { client } = open()
  await expectStatus('success')
  expect(launchButton().disabled).toBe(false)
  const draft = screen.getByRole('textbox', { name: 'Resource draft' }) as HTMLInputElement
  fireEvent.change(draft, { target: { value: 'Native unsaved draft' } })

  vi.mocked(api.get).mockRejectedValue(new Error('Background status temporarily unavailable'))
  await act(async () => {
    await client.invalidateQueries({ queryKey: HOST_EXECUTION_STATUS_QUERY_KEY })
  })
  await expectStatus('error')
  expect(client.getQueryData([...HOST_EXECUTION_STATUS_QUERY_KEY, 0])).toEqual(native)
  expect(launchButton().disabled).toBe(false)
  fireEvent.click(launchButton())
  expect(execute).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Resource draft' })).toBe(draft)
  expect(draft.value).toBe('Native unsaved draft')
})

test('an initial status error blocks execution until the explicit status retry succeeds', async () => {
  vi.mocked(api.get).mockRejectedValue(new Error('Initial status unavailable'))
  open()
  expect(launchButton().disabled).toBe(true)
  await expectStatus('error')
  expect(launchButton().disabled).toBe(true)
  expect(execute).not.toHaveBeenCalled()

  vi.mocked(api.get).mockResolvedValue(active)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await expectStatus('success')
  expect(launchButton().disabled).toBe(false)
  fireEvent.click(launchButton())
  expect(execute).toHaveBeenCalledTimes(1)
})

test.each([
  {
    view: {
      mode: 'resource-only',
      status: { generation: 'resource-only', phase: 'standby', readyGroups: [], reason: null },
    } satisfies HostExecutionStatus,
    initiallyAvailable: false,
  },
  { view: active, initiallyAvailable: true },
])(
  'a cached $view.mode response cannot grant execution after a status error',
  async ({ view, initiallyAvailable }) => {
    vi.mocked(api.get).mockResolvedValue(view)
    const { client } = open()
    await expectStatus('success')
    expect(launchButton().disabled).toBe(!initiallyAvailable)
    vi.mocked(api.get).mockRejectedValue(new Error('Managed status unavailable'))
    await act(async () => {
      await client.invalidateQueries({ queryKey: HOST_EXECUTION_STATUS_QUERY_KEY })
    })
    await expectStatus('error')
    expect(client.getQueryData([...HOST_EXECUTION_STATUS_QUERY_KEY, 0])).toEqual(view)
    expect(launchButton().disabled).toBe(true)
    expect(execute).not.toHaveBeenCalled()

    vi.mocked(api.get).mockResolvedValue(active)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await expectStatus('success')
    expect(launchButton().disabled).toBe(false)
  },
)

test('a new login session waits for its own status instead of retaining the previous native result', async () => {
  vi.mocked(api.get).mockResolvedValue(native)
  const { rerender, content } = open()
  await expectStatus('success')
  expect(launchButton().disabled).toBe(false)

  let reject!: (error: Error) => void
  vi.mocked(api.get).mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail
    }),
  )
  permission.revision = 1
  rerender(content())
  expect(launchButton().disabled).toBe(true)
  await expectStatus('pending')
  await act(async () => {
    reject(new Error('New session status unavailable'))
  })
  await expectStatus('error')
  expect(launchButton().disabled).toBe(true)
  expect(execute).not.toHaveBeenCalled()

  vi.mocked(api.get).mockResolvedValue(native)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await expectStatus('success')
  expect(launchButton().disabled).toBe(false)
})

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
