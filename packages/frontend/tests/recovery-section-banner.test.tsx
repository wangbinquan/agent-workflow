// LOCKS: RFC-108 recovery banner UX — the user-reported "太占地方 / 像标题 /
// 看不懂" fix. Replaces the old fully-expanded <h2> page__section.
//
//   - healthy task (no events, not suspended) → renders nothing (no space);
//   - history present → compact one-line summary, COLLAPSED by default; expand
//     reveals human-readable labels, never the raw recovery_event enum code;
//   - quarantined → warning-toned banner + 「解除隔离」 button that POSTs clear.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { Task } from '@agent-workflow/shared'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { RecoverySection } from '../src/components/tasks/RecoverySection'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderSection(status: Task['status'] = 'running') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RecoverySection taskId="task_1" status={status} />
    </QueryClientProvider>,
  )
}

describe('<RecoverySection />', () => {
  test('healthy task (no events, not suspended) renders nothing', async () => {
    const calls = installFetch(() => jsonResponse({ events: [], suspended: false }))
    renderSection('done')
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    // Let the resolved query flush through React before asserting nothing mounts.
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('[data-testid="task-recovery"]')).toBeNull()
  })

  test('history is collapsed by default and expands to human labels (no raw enum)', async () => {
    installFetch(() =>
      jsonResponse({
        events: [
          { id: 'r1', kind: 'auto-resume', reason: 'autoResumeOnBoot', createdAt: 1 },
          { id: 'r2', kind: 'boot-reap', reason: 'daemon-restart', createdAt: 1 },
        ],
        suspended: false,
      }),
    )
    renderSection('running')
    await waitFor(() =>
      expect(document.querySelector('[data-testid="task-recovery"]')).not.toBeNull(),
    )
    // Collapsed by default → the history list is not in the DOM yet, and the raw
    // enum code never appears regardless of UI language.
    expect(document.querySelector('[data-testid="task-recovery-list"]')).toBeNull()
    expect(document.body.innerHTML).not.toContain('auto-resume')
    expect(document.body.innerHTML).not.toContain('boot-reap')

    fireEvent.click(
      document.querySelector('[data-testid="task-recovery-toggle"]') as HTMLButtonElement,
    )
    await waitFor(() =>
      expect(document.querySelector('[data-testid="task-recovery-list"]')).not.toBeNull(),
    )
    // Each row shows a human label (not the raw kind code), language-agnostic.
    const labels = Array.from(document.querySelectorAll('.task-recovery__kind')).map(
      (el) => el.textContent,
    )
    expect(labels.length).toBe(2)
    for (const label of labels) {
      expect(label).toBeTruthy()
      expect(label).not.toBe('auto-resume')
      expect(label).not.toBe('boot-reap')
    }
    expect(document.body.innerHTML).not.toContain('auto-resume')
    expect(document.body.innerHTML).not.toContain('boot-reap')
  })

  test('quarantined → warning banner + Clear quarantine POSTs the clear route', async () => {
    const calls = installFetch((call) => {
      if (call.url.includes('/clear-recovery-suspension')) return jsonResponse({ ok: true })
      return jsonResponse({
        events: [{ id: 'r1', kind: 'quarantine', reason: 'breaker', createdAt: 1 }],
        suspended: true,
      })
    })
    renderSection('failed')
    await waitFor(() =>
      expect(document.querySelector('[data-testid="task-recovery-clear"]')).not.toBeNull(),
    )
    const banner = document.querySelector('[data-testid="task-recovery"]') as HTMLElement
    expect(banner.className).toMatch(/task-error-banner--warning/)

    fireEvent.click(
      document.querySelector('[data-testid="task-recovery-clear"]') as HTMLButtonElement,
    )
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.includes('/clear-recovery-suspension')),
      ).toBe(true),
    )
  })
})
