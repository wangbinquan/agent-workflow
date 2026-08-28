// RFC-338 — the Settings maintenance card is the product surface for both the
// daily wall-clock schedule and the durable Worker projection. It must expose
// every input rule beside its field and never require daemon-log inspection.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type MaintenanceStatus } from '@agent-workflow/shared'

import { GcTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    const root = createRootRoute({ component: Outlet })
    const index = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => <>{children}</>,
    })
    const router = createRouter({
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    return (
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    )
  }
}

const READY_STATUS: MaintenanceStatus = {
  version: 1,
  worker: { state: 'ready', lastHeartbeatAt: 1, error: null },
  schedule: { kind: 'hourly' },
  nextRunAt: Date.UTC(2026, 7, 28, 11, 4),
  active: null,
  last: null,
  backlog: [],
}

let status: MaintenanceStatus = READY_STATUS
let configPuts: Array<Record<string, unknown>> = []

beforeEach(async () => {
  status = READY_STATUS
  configPuts = []
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc338-maintenance-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : url.toString()
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (path.includes('/api/auth/me')) {
        return json({
          user: { id: 'u1', username: 'u1', displayName: 'u1', role: 'admin', status: 'active' },
          source: 'session',
          permissions: ['settings:write'],
          linkedIdentities: [],
          pats: [],
        })
      }
      if (path.includes('/api/maintenance/status')) return json(status)
      if (path.includes('/api/config') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        configPuts.push(body)
        return json({ ...DEFAULT_CONFIG, ...body })
      }
      if (path.includes('/api/restore/pending')) return json({ pending: null, failed: [] })
      if (path.includes('/api/maintenance/disk')) {
        return json({ items: [], dbFreelistBytes: 0, dbFileBytes: 0 })
      }
      return json({})
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderGc() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapped = wrap(queryClient)
  return render(
    <Wrapped>
      <GcTab config={DEFAULT_CONFIG} />
    </Wrapped>,
  )
}

describe('RFC-338 maintenance Settings card', () => {
  test('keyboard-selects daily, shows both field rules/errors, and saves the exact schedule', async () => {
    renderGc()
    const hourly = await screen.findByRole('radio', { name: 'Hourly, staggered' })
    expect(hourly.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/controls cleanup only/i)).toBeTruthy()

    fireEvent.keyDown(hourly, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Once daily' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    const time = screen.getByTestId('maintenance-schedule-time') as HTMLInputElement
    const timezone = screen.getByTestId('maintenance-schedule-timezone') as HTMLInputElement
    expect(time.value).toBe('02:00')
    expect(timezone.value.length).toBeGreaterThan(0)

    fireEvent.change(time, { target: { value: '25:00' } })
    fireEvent.change(timezone, { target: { value: 'Mars/Olympus' } })
    expect(screen.getByText(/valid 24-hour time/i)).toBeTruthy()
    expect(screen.getByText(/valid IANA timezone/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(time, { target: { value: '03:15' } })
    fireEvent.change(timezone, { target: { value: 'Asia/Shanghai' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(configPuts).toHaveLength(1))
    expect(configPuts[0]).toEqual({
      maintenanceSchedule: { kind: 'daily', at: '03:15', timezone: 'Asia/Shanghai' },
    })
  })

  test('renders current, last, next, progress, backlog, and degraded errors from status API', async () => {
    status = {
      version: 1,
      worker: { state: 'degraded', lastHeartbeatAt: 10, error: 'worker exited' },
      schedule: { kind: 'daily', at: '03:00', timezone: 'UTC' },
      nextRunAt: Date.UTC(2026, 7, 29, 3, 0),
      active: {
        runId: 'active-1',
        cycleKey: 'daily:2026-08-28',
        job: 'eventsArchive',
        startedAt: Date.UTC(2026, 7, 28, 3, 0),
        counters: { deleted: 42 },
      },
      last: {
        runId: 'last-1',
        job: 'tokenAuditGc',
        outcome: 'failed',
        finishedAt: Date.UTC(2026, 7, 27, 3, 0),
        counters: { deleted: 7 },
        errorCode: 'job-failed',
        errorMessage: 'disk unavailable',
      },
      backlog: [
        {
          runId: 'waiting-1',
          job: 'taskArchive',
          state: 'deferred',
          since: Date.UTC(2026, 7, 28, 4, 0),
        },
      ],
    }
    renderGc()

    expect((await screen.findByTestId('maintenance-worker-state')).textContent).toContain(
      'Degraded',
    )
    expect(screen.getByTestId('maintenance-active-job').textContent).toContain('Event archive')
    expect(screen.getByTestId('maintenance-last-run').textContent).toContain('Token audit cleanup')
    expect(screen.getByTestId('maintenance-progress').textContent).toContain('deleted: 42')
    expect(screen.getByTestId('maintenance-backlog').textContent).toContain('1 waiting or failed')
    expect(screen.getByText('worker exited')).toBeTruthy()
    expect(screen.getByText('disk unavailable')).toBeTruthy()
    expect(screen.getByText(/\(UTC\)/)).toBeTruthy()
  })
})
