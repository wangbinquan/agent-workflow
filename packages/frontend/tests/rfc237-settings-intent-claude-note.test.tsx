// RFC-237 — the intent-builder card annotates the enforcement difference when
// the EFFECTIVE runtime (explicit pick, else the inherited defaultRuntime)
// resolves to the claude-code protocol: read-only is enforced by declared CLI
// permissions (sealed binary + tool allow-list), with no opencode-style
// post-launch attestation. Locks: note visible for an explicit claude pick AND
// for claude inherited via defaultRuntime; absent on opencode either way.
// (New file on purpose — settings-system-agents-render.test.tsx belongs to a
// concurrent workstream.)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { SystemAgentsTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, language: 'en-US', theme: 'system', ...overrides }
}

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes('/api/runtimes')) {
      return json({
        runtimes: [
          { name: 'opencode', protocol: 'opencode', enabled: true },
          { name: 'claude-code', protocol: 'claude-code', enabled: true },
        ],
      })
    }
    return json({})
  })
}

function renderTab(config: Config) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<SystemAgentsTab config={config} />, { wrapper: wrap(qc) })
}

const NOTE_TESTID = 'intent-runtime-claude-note'

beforeEach(() => {
  setBaseUrl(`http://rfc237-intent-note-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-237 intent runtime claude-code enforcement note', () => {
  test('explicit claude-code selection shows the note', async () => {
    mockFetch()
    renderTab(mkConfig({ intentBuilderRuntime: 'claude-code' }))
    await waitFor(() => {
      expect(screen.getByTestId(NOTE_TESTID).textContent).toContain('no post-launch config')
    })
  })

  test('claude-code inherited via defaultRuntime (intent unset) shows the note', async () => {
    mockFetch()
    renderTab(mkConfig({ defaultRuntime: 'claude-code' }))
    await waitFor(() => {
      expect(screen.getByTestId(NOTE_TESTID)).toBeTruthy()
    })
  })

  test('opencode (explicit or inherited) shows no note', async () => {
    mockFetch()
    renderTab(mkConfig({ intentBuilderRuntime: 'opencode' }))
    // Let the runtimes query settle before asserting absence.
    await waitFor(() => {
      expect(
        screen.getByRole('combobox', {
          name: i18n.t('settings.systemAgents.intentRuntime'),
        }),
      ).toBeTruthy()
    })
    expect(screen.queryByTestId(NOTE_TESTID)).toBeNull()
    cleanup()
    mockFetch()
    renderTab(mkConfig()) // unset + defaultRuntime unset → platform default opencode
    await waitFor(() => {
      expect(
        screen.getByRole('combobox', {
          name: i18n.t('settings.systemAgents.intentRuntime'),
        }),
      ).toBeTruthy()
    })
    expect(screen.queryByTestId(NOTE_TESTID)).toBeNull()
  })
})
