// RFC-201 PR-A: the daemon's EFFECTIVE port is a suggestion, not persisted
// config. Loading GET /api/daemon must not silently mutate the draft or enable
// Save; the user explicitly chooses whether to pin that currently ephemeral
// port into config.json.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { NetworkTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    language: 'zh-CN',
    theme: 'system',
    ...overrides,
  }
}

// Mock GET /api/daemon; every other request resolves to an empty JSON object.
function mockDaemon(body: unknown | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (s.includes('/api/daemon') && method === 'GET') {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

const DAEMON = {
  pid: 4321,
  host: '127.0.0.1',
  port: 52341,
  url: 'http://127.0.0.1:52341/',
  startedAt: '2026-07-08T00:00:00.000Z',
}

beforeEach(() => {
  setBaseUrl(`http://settings-network-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('NetworkTab treats the effective binding as an explicit suggestion', () => {
  test('shows the effective port as a suggestion without creating a dirty draft', async () => {
    mockDaemon(DAEMON)
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    await waitFor(() => expect(port.placeholder).toBe('52341'))
    expect(port.value).toBe('')
    expect(port.disabled).toBe(false)
    const save = screen.getByRole('button', { name: /^(保存|Save)$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('settings-use-effective-port'))
    expect(port.value).toBe('52341')
    expect(save.disabled).toBe(false)
  })

  test('does NOT overwrite a port the config already pins', async () => {
    mockDaemon(DAEMON) // effective 52341
    render(<NetworkTab config={mkConfig({ bindPort: 8080 })} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    expect(port.value).toBe('8080')
    // Give the backfill effect a tick to (not) fire, then re-assert.
    await new Promise((r) => setTimeout(r, 30))
    expect(port.value).toBe('8080')
  })

  test('leaves the port field blank when the daemon run-info is unavailable (null)', async () => {
    mockDaemon(null)
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    await new Promise((r) => setTimeout(r, 30))
    expect(port.value).toBe('')
  })
})
