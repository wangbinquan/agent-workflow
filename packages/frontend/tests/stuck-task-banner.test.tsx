// RFC-053 PR-E — StuckTaskBanner unit test.
//
// Mocks `/api/tasks/:id/alerts` and asserts:
//   - no alerts → component renders null (banner hidden)
//   - warning-only alerts → warning variant chrome
//   - error alerts → danger variant chrome
//   - rules summary lists the affected rule codes
//   - "Diagnose" button opens the panel (via /diagnose POST mock)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { LIFECYCLE_ALERT_RULES } from '@agent-workflow/shared'

import { StuckTaskBanner } from '../src/components/tasks/StuckTaskBanner'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'
import { setBaseUrl, setToken } from '../src/stores/auth'

const realFetch = globalThis.fetch

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

interface MockRouter {
  alerts?: Array<{
    id: string
    rule: string
    severity: 'warning' | 'error'
    detail: Record<string, unknown>
    detectedAt: number
  }>
  diagnose?: {
    scanned: number
    newAlerts: number
    promotedAlerts: number
    resolvedAlerts: number
    openAlerts: Array<{
      id: string
      taskId: string
      rule: string
      severity: 'warning' | 'error'
      detail: Record<string, unknown>
      detectedAt: number
      resolvedAt: number | null
    }>
  }
}

function mockFetch(r: MockRouter): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/alerts') && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ alerts: r.alerts ?? [] })
    }
    if (url.endsWith('/diagnose') && init?.method === 'POST') {
      return jsonResponse(
        r.diagnose ?? {
          scanned: 1,
          newAlerts: 0,
          promotedAlerts: 0,
          resolvedAlerts: 0,
          openAlerts: r.alerts ?? [],
        },
      )
    }
    return new Response('not mocked: ' + url, { status: 404 })
  })
}

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('StuckTaskBanner', () => {
  beforeEach(() => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('renders nothing when alerts list is empty', async () => {
    globalThis.fetch = mockFetch({ alerts: [] }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    const { container } = render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )
    await waitFor(() => {
      // No banner at all — first child of the test root is nothing
      // visible.
      expect(container.querySelector('[data-testid="stuck-task-banner"]')).toBeNull()
    })
  })

  test('renders warning variant for warning-only alerts', async () => {
    globalThis.fetch = mockFetch({
      alerts: [
        {
          id: 'a',
          rule: 'S4',
          severity: 'warning',
          detail: { rule: 'S4' },
          detectedAt: 1000,
        },
      ],
    }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )
    const banner = await screen.findByTestId('stuck-task-banner')
    expect(banner.className).toContain('task-error-banner--warning')
    // Rules summary toggles open via <details>; the rule code appears in
    // the rendered text regardless of open state.
    expect(banner.textContent).toMatch(/S4/)
  })

  test('renders danger variant when at least one error severity is present', async () => {
    globalThis.fetch = mockFetch({
      alerts: [
        { id: 'a', rule: 'S4', severity: 'warning', detail: {}, detectedAt: 1 },
        { id: 'b', rule: 'R1', severity: 'error', detail: {}, detectedAt: 2 },
      ],
    }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )
    const banner = await screen.findByTestId('stuck-task-banner')
    expect(banner.className).not.toContain('task-error-banner--warning')
    const button = await screen.findByTestId('stuck-task-banner-diagnose')
    expect(button.className).toContain('btn--danger')
  })

  test('clicking Diagnose opens the panel', async () => {
    globalThis.fetch = mockFetch({
      alerts: [{ id: 'a', rule: 'S4', severity: 'warning', detail: {}, detectedAt: 1 }],
      diagnose: {
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [
          {
            id: 'a',
            taskId: 't1',
            rule: 'S4',
            severity: 'warning',
            detail: { rule: 'S4' },
            detectedAt: 1,
            resolvedAt: null,
          },
        ],
      },
    }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )
    const btn = await screen.findByTestId('stuck-task-banner-diagnose')
    fireEvent.click(btn)
    // Panel renders via portal — query via document.body.
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="task-diagnose-panel"]')).not.toBeNull()
    })
  })

  test('dismiss hides the current alert signature', async () => {
    globalThis.fetch = mockFetch({
      alerts: [{ id: 'a', rule: 'S4', severity: 'warning', detail: {}, detectedAt: 1 }],
    }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )

    await screen.findByTestId('stuck-task-banner')
    fireEvent.click(screen.getByTestId('stuck-task-banner-dismiss'))
    expect(screen.queryByTestId('stuck-task-banner')).toBeNull()
  })

  test('detail refresh stays dismissed, while severity promotion reappears', async () => {
    const initial = {
      id: 'a',
      rule: 'S4' as const,
      severity: 'warning' as const,
      detail: {},
      detectedAt: 1,
    }
    globalThis.fetch = mockFetch({ alerts: [initial] }) as unknown as typeof fetch
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <StuckTaskBanner taskId="t1" />
      </QueryClientProvider>,
    )

    await screen.findByTestId('stuck-task-banner')
    fireEvent.click(screen.getByTestId('stuck-task-banner-dismiss'))
    expect(screen.queryByTestId('stuck-task-banner')).toBeNull()

    act(() => {
      qc.setQueryData(['tasks', 't1', 'alerts'], {
        alerts: [{ ...initial, detail: { phase: 'changed' } }],
      })
    })
    expect(screen.queryByTestId('stuck-task-banner')).toBeNull()

    act(() => {
      qc.setQueryData(['tasks', 't1', 'alerts'], {
        alerts: [{ ...initial, severity: 'error', detail: { phase: 'changed' } }],
      })
    })
    expect(await screen.findByTestId('stuck-task-banner')).toBeTruthy()
  })

  // RFC-098 WP-8 (对抗检视修订 #5): the S5 rule landed with bilingual bundle
  // entries, and describeRule grew an unknown-rule fallback so a backend
  // that is AHEAD of this bundle (emitting a rule we have no entry for)
  // shows the bare rule code instead of leaking the raw i18n key.
  test('S5 renders its bundle label; unknown rule falls back to the bare code', async () => {
    globalThis.fetch = mockFetch({
      alerts: [
        { id: 'a', rule: 'S5', severity: 'warning', detail: { rule: 'S5' }, detectedAt: 1 },
        { id: 'b', rule: 'S9', severity: 'warning', detail: {}, detectedAt: 2 },
      ],
    }) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <StuckTaskBanner taskId="t1" />
      </Wrapper>,
    )
    const banner = await screen.findByTestId('stuck-task-banner')
    // S5 has a real entry in both bundles — never the raw key.
    expect(banner.textContent).toMatch(/S5/)
    expect(banner.textContent).not.toContain('tasks.diagnose.rule.S5')
    // 'S9' is unknown — describeRule falls back to the bare code.
    expect(banner.textContent).toContain('S9')
    expect(banner.textContent).not.toContain('tasks.diagnose.rule.S9')
  })

  test('rule label tables cover every shared LifecycleAlertRule (en + zh)', () => {
    const enRules = enUS.tasks.diagnose.rule as Record<string, string>
    const zhRules = zhCN.tasks.diagnose.rule as Record<string, string>
    for (const rule of LIFECYCLE_ALERT_RULES) {
      expect(enRules[rule], `en-US missing tasks.diagnose.rule.${rule}`).toBeTruthy()
      expect(zhRules[rule], `zh-CN missing tasks.diagnose.rule.${rule}`).toBeTruthy()
    }
  })
})
