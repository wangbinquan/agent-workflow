// RFC-032 PR3 index route — locks `routes/index.tsx`'s first-run vs.
// non-first-run branches, and the source-code guard that the legacy
// `<Navigate to="/agents">` fallback is gone.
//
// Why this test exists: the previous fallback silently forced `/agents`
// to be the de-facto home; PR3 replaces it with `<Homepage />` and
// keeps Onboarding intact for first-run environments. A regression
// that puts the Navigate back, or drops Onboarding, would break a
// well-trodden UX path. The cases below cover both branches plus a
// source-level grep to keep the contract explicit.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import '../src/i18n'
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
    useNavigate: () => vi.fn(),
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate-stub" data-to={to} />,
  }
})

// IndexPage isn't exported (only the Route is via createRoute). The
// component-level branch logic lives inline; we exercise it by mocking
// `useOnboardingProbe` at module-load time so the import in
// `routes/index.tsx` resolves through the mock factory.
const probeReturn: { current: OnboardingModule.OnboardingProbe } = {
  current: {
    isLoading: false,
    isFirstRun: false,
    hasData: true,
    error: null,
    retry: vi.fn(),
  },
}

vi.mock('../src/components/Onboarding', async () => {
  const actual = await vi.importActual<typeof OnboardingModule>('../src/components/Onboarding')
  return {
    ...actual,
    useOnboardingProbe: () => probeReturn.current,
  }
})

// Imported AFTER the mocks so the wired behaviour applies.
import type * as OnboardingModule from '../src/components/Onboarding'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function mockTasksRuntimeEmpty(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    // RFC-135: the hero reads the registry status endpoint (per-enabled-runtime
    // rows, version-gate free) instead of the legacy /api/runtime/opencode.
    if (s.includes('/api/runtimes/status')) {
      return new Response(
        JSON.stringify({
          runtimes: [
            {
              name: 'opencode',
              protocol: 'opencode',
              binary: '/usr/local/bin/opencode',
              ok: true,
              version: '0.13.2',
              isDefault: true,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // RFC-190: the homepage branch fetches /api/overview — the fallback `[]`
    // is not a legal OverviewResponse, so answer with an empty-but-valid one.
    if (s.includes('/api/overview')) {
      return new Response(
        JSON.stringify({
          resources: {
            agents: 0,
            skills: 0,
            mcps: 0,
            plugins: 0,
            workflows: 0,
            workgroups: 0,
            repos: 0,
            scheduled: 0,
            memories: 0,
          },
          tasks: { running: 0, awaiting: 0, done7d: 0, failed7d: 0 },
          generatedAt: '2026-07-15T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  probeReturn.current = {
    isLoading: false,
    isFirstRun: false,
    hasData: true,
    error: null,
    retry: vi.fn(),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-032 / route — locks first-run vs. non-first-run branching', () => {
  test('isFirstRun:true → Onboarding renders (P-5-10 path)', async () => {
    probeReturn.current = { ...probeReturn.current, isFirstRun: true }
    mockTasksRuntimeEmpty()
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    await waitFor(() => {
      // Onboarding renders a button labelled "Import demo workflow" in en-US.
      expect(screen.queryByText(/Import demo workflow|导入示例工作流/)).not.toBeNull()
    })
    expect(screen.queryByTestId('homepage')).toBeNull()
  })

  test('isFirstRun:false → Homepage renders (no Navigate)', async () => {
    probeReturn.current = { ...probeReturn.current, isFirstRun: false }
    mockTasksRuntimeEmpty()
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    await waitFor(() => {
      expect(screen.queryByTestId('homepage')).not.toBeNull()
    })
    // The Navigate stub must NOT appear — we replaced it with <Homepage />.
    expect(screen.queryByTestId('navigate-stub')).toBeNull()
  })

  test('initial probe loading uses the shared page header/loading state', async () => {
    probeReturn.current = {
      ...probeReturn.current,
      isLoading: true,
      hasData: false,
    }
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    expect(screen.getByTestId('home-probe-state')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Home|首页/)
    expect(screen.getByTestId('loading-state')).toBeTruthy()
    expect(screen.queryByTestId('homepage')).toBeNull()
  })

  test('initial probe failure never masquerades as Homepage and exposes retry', async () => {
    const retry = vi.fn()
    probeReturn.current = {
      isLoading: false,
      isFirstRun: false,
      hasData: false,
      error: new Error('agents probe failed'),
      retry,
    }
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    expect(screen.getByRole('alert').textContent).toContain('agents probe failed')
    expect(screen.queryByTestId('homepage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('background probe failure keeps stale Homepage visible with retry feedback', async () => {
    const retry = vi.fn()
    probeReturn.current = {
      isLoading: false,
      isFirstRun: false,
      hasData: true,
      error: new Error('refresh failed'),
      retry,
    }
    mockTasksRuntimeEmpty()
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    expect(await screen.findByTestId('homepage')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('refresh failed')
    fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('background probe failure keeps stale Onboarding visible', async () => {
    probeReturn.current = {
      ...probeReturn.current,
      isFirstRun: true,
      error: new Error('refresh failed'),
    }
    const { Route } = await import('../src/routes/index')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Comp = (Route.options as any).component as React.ComponentType
    wrap(<Comp />)
    expect(screen.getByTestId('onboarding-hero')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('refresh failed')
  })

  test('source guard: routes/index.tsx no longer ships Navigate.*/agents', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '..', 'src', 'routes', 'index.tsx'), 'utf8')
    expect(src).not.toMatch(/Navigate\b.*to=["'`]\/agents["'`]/)
    expect(src).toContain('<Homepage />')
    expect(src).toContain('useOnboardingProbe')
  })
})
