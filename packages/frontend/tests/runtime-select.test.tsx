// RFC-117 — RuntimeSelect, the shared settings runtime-profile picker used by the
// distiller / commit / fusion runtime selectors (replacing the old per-feature
// ModelSelect pickers; model now comes from the chosen runtime profile). Mounts it
// with a mocked /api/runtimes + /api/config and locks: the "Inherit (global
// default)" empty option, the registered runtimes render as options, picking one
// calls onChange(name), and picking inherit calls onChange(undefined).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { RuntimeSelect } from '../src/components/RuntimeSelect'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mockFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const s = String(input)
    if (s.includes('/api/runtimes')) {
      return new Response(
        JSON.stringify({
          runtimes: [
            { name: 'opencode', protocol: 'opencode', enabled: true },
            { name: 'oc-haiku', protocol: 'opencode', enabled: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (s.includes('/api/config')) {
      return new Response(JSON.stringify({ claudeCodeEnabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  void i18n.changeLanguage('en-US')
})
afterEach(() => {
  document.body.innerHTML = ''
  clearToken()
  vi.restoreAllMocks()
})

describe('RuntimeSelect (RFC-117)', () => {
  test('renders the inherit option + registered runtimes; picking one → onChange(name)', async () => {
    mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const changes: Array<string | null> = []
    render(
      <RuntimeSelect
        value={undefined}
        ariaLabel="Distill runtime"
        onChange={(v) => changes.push(v)}
      />,
      { wrapper: wrap(qc) },
    )
    const trigger = await screen.findByRole('combobox', { name: 'Distill runtime' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('option', { name: /Inherit/ })).toBeTruthy()
    const opt = await screen.findByRole('option', { name: 'oc-haiku' })
    fireEvent.mouseDown(opt)
    expect(changes).toContain('oc-haiku')
  })

  test('selecting the inherit option → onChange(null)（清除已保存的 override）', async () => {
    mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const changes: Array<string | null> = []
    render(
      <RuntimeSelect
        value="oc-haiku"
        ariaLabel="Distill runtime"
        onChange={(v) => changes.push(v)}
      />,
      { wrapper: wrap(qc) },
    )
    const trigger = await screen.findByRole('combobox', { name: 'Distill runtime' })
    fireEvent.click(trigger)
    const inherit = await screen.findByRole('option', { name: /Inherit/ })
    fireEvent.mouseDown(inherit)
    // null (not undefined) so the PATCH clears a saved override (impl-gate P2).
    expect(changes).toContain(null)
  })
})
