// P-5-10: tests for the first-run onboarding component.
//
// `computeIsFirstRun` covers the decision rule directly. The render tests
// stub `@tanstack/react-router`'s Link as a plain <a> so we don't need a
// full RouterProvider — the component's responsibility here is layout +
// the "import demo" mutation wiring, not navigation.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { computeIsFirstRun, Onboarding, useOnboardingProbe } from '../src/components/Onboarding'
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
  test('initial loading without snapshots is never first-run', () => {
    expect(
      computeIsFirstRun({
        agents: undefined,
        workflows: undefined,
        isLoading: true,
        error: null,
      }),
    ).toBe(false)
  })

  test('initial error without both snapshots is never first-run', () => {
    expect(
      computeIsFirstRun({
        agents: undefined,
        workflows: [],
        isLoading: false,
        error: new Error('boom'),
      }),
    ).toBe(false)
  })

  test('loading/error preserve an existing empty snapshot decision', () => {
    expect(
      computeIsFirstRun({
        agents: [],
        workflows: [],
        isLoading: true,
        error: new Error('background refresh failed'),
      }),
    ).toBe(true)
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

describe('useOnboardingProbe', () => {
  test('initial failure has no renderable snapshot; retry refreshes both lists', async () => {
    let agentCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/agents')) {
        agentCalls += 1
        if (agentCalls === 1) {
          return new Response(
            JSON.stringify({ code: 'probe-failed', message: 'agents unavailable' }),
            {
              status: 503,
              headers: { 'content-type': 'application/json' },
            },
          )
        }
      }
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useOnboardingProbe(), { wrapper })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.hasData).toBe(false)
    expect(result.current.isFirstRun).toBe(false)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.hasData).toBe(true))
    expect(result.current.error).toBeNull()
    expect(result.current.isFirstRun).toBe(true)
    expect(agentCalls).toBe(2)
  })

  test('background failure retains cached first-run snapshots', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'probe-failed', message: 'refresh unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
    qc.setQueryData(['agents'], [])
    qc.setQueryData(['workflows'], [])
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useOnboardingProbe(), { wrapper })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.hasData).toBe(true)
    expect(result.current.isFirstRun).toBe(true)
  })
})

describe('Onboarding render', () => {
  test('uses the shared page header and keeps one primary action', () => {
    const { container } = wrap(<Onboarding />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Agent Workflow/)
    expect(container.querySelector('.page__header--row')).toBeTruthy()
    expect(container.querySelectorAll('.btn--primary')).toHaveLength(1)
  })

  test('keeps stale onboarding visible while probe failure offers retry', () => {
    const retry = vi.fn()
    wrap(<Onboarding probeError={new Error('probe failed')} onRetryProbe={retry} />)
    expect(screen.getByTestId('onboarding-hero')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('probe failed')
    fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

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
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'workflow-yaml-invalid',
              message: 'definition failed schema validation',
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'wf-retry' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    wrap(<Onboarding />)
    fireEvent.click(screen.getByText(/Import demo workflow/i))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('workflow-yaml-invalid')
    const retry = screen.getByRole('button', { name: /Retry|重试/ })
    expect(retry.getAttribute('aria-busy')).toBe('false')
    fireEvent.click(retry)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
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
