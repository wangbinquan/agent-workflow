// P-5-10: tests for the first-run onboarding component.
//
// `computeIsFirstRun` covers the decision rule directly. The render tests
// stub `@tanstack/react-router`'s Link as a plain <a> so we don't need a
// full RouterProvider — the component's responsibility here is layout +
// the "import demo" mutation wiring, not navigation.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { computeIsFirstRun, Onboarding } from '../src/components/Onboarding'
import { DEMO_WORKFLOW_YAML } from '../src/fixtures/demo-workflow'
import { setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('computeIsFirstRun', () => {
  test('loading state is never first-run', () => {
    expect(computeIsFirstRun({ agents: [], workflows: [], isLoading: true, error: null })).toBe(
      false,
    )
  })

  test('error state is never first-run', () => {
    expect(
      computeIsFirstRun({
        agents: [],
        workflows: [],
        isLoading: false,
        error: new Error('boom'),
      }),
    ).toBe(false)
  })

  test('both lists empty → first-run', () => {
    expect(computeIsFirstRun({ agents: [], workflows: [], isLoading: false, error: null })).toBe(
      true,
    )
  })

  test('any list has items → not first-run', () => {
    expect(
      computeIsFirstRun({
        agents: [{ name: 'x' } as never],
        workflows: [],
        isLoading: false,
        error: null,
      }),
    ).toBe(false)
    expect(
      computeIsFirstRun({
        agents: [],
        workflows: [{ id: 'w' } as never],
        isLoading: false,
        error: null,
      }),
    ).toBe(false)
  })

  test('undefined data (between mount and first response) is not first-run', () => {
    expect(
      computeIsFirstRun({
        agents: undefined,
        workflows: undefined,
        isLoading: false,
        error: null,
      }),
    ).toBe(false)
  })
})

describe('Onboarding render', () => {
  test('renders all four step titles', () => {
    wrap(<Onboarding />)
    expect(screen.getByText(/1\..*agent/i)).toBeTruthy()
    expect(screen.getByText(/2\..*skill/i)).toBeTruthy()
    expect(screen.getByText(/3\..*workflow/i)).toBeTruthy()
    expect(screen.getByText(/4\..*task/i)).toBeTruthy()
  })

  test('Import demo workflow POSTs the bundled YAML and shows a success hint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'wf-x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<Onboarding />)
    const btn = screen.getByText(/Import demo workflow/i)
    fireEvent.click(btn)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('/api/workflows/import')
    expect(String(url)).toContain('onConflict=new')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['content-type']).toBe('text/yaml')
    expect(headers.Authorization).toBe('Bearer tok')
    expect((init as RequestInit).body).toBe(DEMO_WORKFLOW_YAML)

    await waitFor(() => expect(screen.getByText(/imported|已导入/i)).toBeTruthy())
  })

  test('Import demo surfaces backend error code on 422 / 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'workflow-yaml-invalid', message: 'definition failed schema validation' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<Onboarding />)
    fireEvent.click(screen.getByText(/Import demo workflow/i))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('workflow-yaml-invalid')
  })
})

// ---------------------------------------------------------------------------
// RFC-190 — first-run hero + capability intro grid. The four-step walkthrough
// above stays byte-identical; the renewal only ADDS the pipeline hero and the
// count-less intro tiles (which must not fire /api/overview on a fresh,
// unauthenticated install).
// ---------------------------------------------------------------------------
describe('RFC-190 Onboarding renewal', () => {
  test('renders the pipeline hero + intro capability grid without counts', () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    wrap(<Onboarding />)
    expect(screen.getByTestId('onboarding-hero')).toBeTruthy()
    expect(screen.getByTestId('pipeline-hero')).toBeTruthy()
    expect(screen.getByTestId('home-cap-grid')).toBeTruthy()
    // intro variant: tiles render, counts don't, and no overview request fires
    expect(screen.getByTestId('home-cap-agents')).toBeTruthy()
    expect(screen.queryByTestId('home-cap-agents-count')).toBeNull()
    const overviewCalls = spy.mock.calls.filter((c) => String(c[0]).includes('/api/overview'))
    expect(overviewCalls.length).toBe(0)
  })
})
