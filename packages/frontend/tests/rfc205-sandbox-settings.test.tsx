// RFC-205 T5 (design D6) — Settings → Runtime sandbox observability card.
//
// Locks:
//   1. StatusChip renders the three D6 states off GET /api/runtimes/status
//      `sandbox`: available+mode!=off → success 「沙箱：<mechanism>」;
//      mode!=off+unavailable → warn 「沙箱不可用」; mode=off → neutral
//      「沙箱关闭」.
//   2. The `.segmented` three-way control reflects config.sandboxMode and a
//      click PUTs the MINIMAL patch `{ sandboxMode: 'enforce' }` (no other
//      keys on the wire), then refreshes the config cache (aria-checked
//      moves) AND invalidates the runtimes/status query (second GET).
//   3. enforce + unavailable shows the launch-will-be-refused warning banner
//      (and warn + unavailable does NOT); the three-mode hint line is always
//      visible.
//   4. RuntimeTab wires the card in (integration anchor).
//
// Harness mirrors language-switch.test.tsx: fetch-level mock + the REAL
// api client / config write coordinator, so the PUT body assertion is the
// actual wire payload. A unique baseUrl per test fences the coordinator.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_CONFIG, type SandboxStatus } from '@agent-workflow/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxCard } from '../src/components/settings/SandboxCard'
import { RuntimeTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function newQc(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

interface MockOptions {
  sandbox: SandboxStatus
  configSandboxMode?: 'enforce' | 'warn' | 'off'
  putFails?: boolean
}

interface MockState {
  putCalls: Array<{ body: unknown }>
  statusGets: () => number
}

function mockFetch(opts: MockOptions): MockState {
  const putCalls: Array<{ body: unknown }> = []
  let statusGetCount = 0
  let persistedMode = opts.configSandboxMode ?? DEFAULT_CONFIG.sandboxMode
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (s.includes('/api/runtimes/status') && method === 'GET') {
        statusGetCount += 1
        return json({ runtimes: [], sandbox: opts.sandbox })
      }
      // RuntimeTab integration render: the runtimes table list.
      if (s.includes('/api/runtimes') && method === 'GET') {
        return json({ runtimes: [] })
      }
      if (s.includes('/api/config') && method === 'GET') {
        return json({ ...DEFAULT_CONFIG, sandboxMode: persistedMode })
      }
      if (s.includes('/api/config') && method === 'PUT') {
        const body: unknown = init?.body !== undefined ? JSON.parse(String(init.body)) : null
        putCalls.push({ body })
        if (opts.putFails === true) return json({ code: 'bad', message: 'boom' }, 400)
        persistedMode = (body as { sandboxMode: 'enforce' | 'warn' | 'off' }).sandboxMode
        return json({ ...DEFAULT_CONFIG, sandboxMode: persistedMode })
      }
      return json({})
    },
  )
  return { putCalls, statusGets: () => statusGetCount }
}

beforeEach(async () => {
  setBaseUrl(`http://rfc205-sandbox-${crypto.randomUUID()}.test`)
  setToken('tok')
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-205 sandbox status chip', () => {
  test('available + mode!=off → success chip naming the mechanism', async () => {
    mockFetch({ sandbox: { mode: 'warn', mechanism: 'seatbelt', available: true } })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const chip = await screen.findByTestId('sandbox-status-chip')
    expect(chip.className).toContain('status-chip--success')
    expect(chip.textContent).toBe(i18n.t('settings.sandbox.chipActive', { mechanism: 'seatbelt' }))
  })

  test('bwrap mechanism is named too', async () => {
    mockFetch({ sandbox: { mode: 'enforce', mechanism: 'bwrap', available: true } })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const chip = await screen.findByTestId('sandbox-status-chip')
    expect(chip.className).toContain('status-chip--success')
    expect(chip.textContent).toBe(i18n.t('settings.sandbox.chipActive', { mechanism: 'bwrap' }))
  })

  test('mode!=off + unavailable → warn chip 「沙箱不可用」', async () => {
    mockFetch({ sandbox: { mode: 'warn', mechanism: null, available: false } })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const chip = await screen.findByTestId('sandbox-status-chip')
    expect(chip.className).toContain('status-chip--warn')
    expect(chip.textContent).toBe(i18n.t('settings.sandbox.chipUnavailable'))
  })

  test('mode=off → neutral (muted) chip 「沙箱关闭」 even when available', async () => {
    mockFetch({
      sandbox: { mode: 'off', mechanism: 'seatbelt', available: true },
      configSandboxMode: 'off',
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const chip = await screen.findByTestId('sandbox-status-chip')
    expect(chip.className).toContain('status-chip--neutral')
    expect(chip.textContent).toBe(i18n.t('settings.sandbox.chipOff'))
  })
})

describe('RFC-205 sandboxMode segmented control', () => {
  test('renders three radios; aria-checked follows config.sandboxMode', async () => {
    mockFetch({
      sandbox: { mode: 'warn', mechanism: 'seatbelt', available: true },
      configSandboxMode: 'warn',
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3))
    const enforce = screen.getByRole('radio', { name: i18n.t('settings.sandbox.modeEnforce') })
    const warn = screen.getByRole('radio', { name: i18n.t('settings.sandbox.modeWarn') })
    const off = screen.getByRole('radio', { name: i18n.t('settings.sandbox.modeOff') })
    await waitFor(() => expect(warn.getAttribute('aria-checked')).toBe('true'))
    expect(enforce.getAttribute('aria-checked')).toBe('false')
    expect(off.getAttribute('aria-checked')).toBe('false')
  })

  test('clicking enforce PUTs the minimal {sandboxMode} patch, updates config cache, re-fetches status', async () => {
    const state = mockFetch({
      sandbox: { mode: 'warn', mechanism: 'seatbelt', available: true },
      configSandboxMode: 'warn',
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const enforce = await screen.findByRole('radio', {
      name: i18n.t('settings.sandbox.modeEnforce'),
    })
    await waitFor(() => expect(state.statusGets()).toBe(1))
    act(() => {
      fireEvent.click(enforce)
    })
    await waitFor(() => expect(state.putCalls).toHaveLength(1))
    // The wire payload is the MINIMAL patch — exactly one key.
    expect(state.putCalls[0]?.body).toEqual({ sandboxMode: 'enforce' })
    // Config cache refresh: the control flips to the accepted value.
    await waitFor(() => expect(enforce.getAttribute('aria-checked')).toBe('true'))
    // Status invalidation: the chip's query re-fetched after the write.
    await waitFor(() => expect(state.statusGets()).toBeGreaterThanOrEqual(2))
  })

  test('a rejected PUT surfaces the error banner and keeps the saved value', async () => {
    mockFetch({
      sandbox: { mode: 'warn', mechanism: 'seatbelt', available: true },
      configSandboxMode: 'warn',
      putFails: true,
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const off = await screen.findByRole('radio', { name: i18n.t('settings.sandbox.modeOff') })
    act(() => {
      fireEvent.click(off)
    })
    await screen.findByTestId('sandbox-save-error')
    const warn = screen.getByRole('radio', { name: i18n.t('settings.sandbox.modeWarn') })
    expect(warn.getAttribute('aria-checked')).toBe('true')
  })
})

describe('RFC-205 enforce + unavailable warning', () => {
  test('shows the launch-refused banner and the three-mode hint', async () => {
    mockFetch({
      sandbox: { mode: 'enforce', mechanism: null, available: false },
      configSandboxMode: 'enforce',
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    const banner = await screen.findByTestId('sandbox-enforce-unavailable')
    expect(banner.textContent).toContain(i18n.t('settings.sandbox.enforceUnavailable'))
    // The chip reads warn/unavailable at the same time.
    const chip = screen.getByTestId('sandbox-status-chip')
    expect(chip.className).toContain('status-chip--warn')
    // The per-mode meanings hint stays visible.
    expect(screen.getByText(i18n.t('settings.sandbox.modeHint'))).toBeTruthy()
  })

  test('warn + unavailable does NOT show the enforce banner', async () => {
    mockFetch({
      sandbox: { mode: 'warn', mechanism: null, available: false },
      configSandboxMode: 'warn',
    })
    render(<SandboxCard />, { wrapper: wrap(newQc()) })
    await screen.findByTestId('sandbox-status-chip')
    expect(screen.queryByTestId('sandbox-enforce-unavailable')).toBeNull()
  })
})

describe('RFC-205 RuntimeTab wiring', () => {
  test('the Runtime tab renders the sandbox card above the runtimes list', async () => {
    mockFetch({ sandbox: { mode: 'warn', mechanism: 'seatbelt', available: true } })
    render(<RuntimeTab />, { wrapper: wrap(newQc()) })
    await screen.findByTestId('sandbox-card')
    await screen.findByTestId('sandbox-status-chip')
  })
})
