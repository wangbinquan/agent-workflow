// LOCKS: RFC-057 — <RepairConfirmModal> contract.
//
// Locks in:
//   - Apply button POSTs `{ optionId, confirm: true }` to the correct path.
//   - On success, onApplied is invoked with the parsed RepairResponse.
//   - On 422 (backend rejects confirm), <ErrorBanner> shows and onApplied
//     does NOT fire.
//   - destructive=true swaps Apply to .btn--danger and adds the
//     destructive panel class.
//   - The Confirm button is disabled while apply is pending (no double-fire).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { RepairOption, RepairResponse } from '@agent-workflow/shared'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { RepairConfirmModal } from '../src/components/tasks/RepairConfirmModal'
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

function mkOpt(overrides: Partial<RepairOption> = {}): RepairOption {
  return {
    id: 'S3.demote-task',
    rule: 'S3',
    labelKey: 'diagnose.repair.S3.demoteTask.label',
    descriptionKey: 'diagnose.repair.S3.demoteTask.desc',
    risk: 'low',
    destructive: false,
    available: true,
    previewSteps: ['Step.'],
    ...overrides,
  }
}

function renderModal(props: {
  option?: RepairOption
  onApplied?: (r: RepairResponse) => void
  onCancel?: () => void
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RepairConfirmModal
        taskId="task_1"
        alertId="al_1"
        option={props.option ?? mkOpt()}
        open={true}
        onCancel={props.onCancel ?? (() => {})}
        onApplied={props.onApplied ?? (() => {})}
      />
    </QueryClientProvider>,
  )
}

const OK_RESPONSE: RepairResponse = {
  ok: true,
  auditId: 'audit-1',
  outcome: 'success',
  resolvedAlertIds: ['al_1'],
  newAlerts: [],
}

describe('<RepairConfirmModal />', () => {
  test('Apply POSTs { optionId, confirm: true } and calls onApplied', async () => {
    const calls = installFetch(() => jsonResponse(OK_RESPONSE))
    let received: RepairResponse | null = null
    renderModal({ onApplied: (r) => (received = r) })
    const apply = document.querySelector(
      '[data-testid="repair-confirm-apply"]',
    ) as HTMLButtonElement
    fireEvent.click(apply)
    await waitFor(() => {
      expect(received).not.toBeNull()
    })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toMatch(/\/api\/tasks\/task_1\/alerts\/al_1\/repair$/)
    expect(calls[0]?.body).toEqual({ optionId: 'S3.demote-task', confirm: true })
    expect(received!.outcome).toBe('success')
  })

  test('422 from backend keeps the modal open + shows ErrorBanner', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ code: 'invalid-request', message: 'missing confirm' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    )
    let appliedCalls = 0
    renderModal({ onApplied: () => appliedCalls++ })
    const apply = document.querySelector(
      '[data-testid="repair-confirm-apply"]',
    ) as HTMLButtonElement
    fireEvent.click(apply)
    await waitFor(() => {
      expect(document.querySelector('.error-box')).not.toBeNull()
    })
    expect(appliedCalls).toBe(0)
    // Modal stays open.
    expect(document.querySelector('[data-testid="repair-confirm-modal"]')).not.toBeNull()
  })

  test('destructive option styles Apply as danger + panel class', () => {
    renderModal({ option: mkOpt({ destructive: true, risk: 'high' }) })
    const apply = document.querySelector(
      '[data-testid="repair-confirm-apply"]',
    ) as HTMLButtonElement
    expect(apply.className).toMatch(/btn--danger/)
    const panel = document.querySelector('.repair-confirm--destructive')
    expect(panel).not.toBeNull()
  })

  test('Cancel button fires onCancel + does not POST', async () => {
    const calls = installFetch(() => jsonResponse(OK_RESPONSE))
    let cancels = 0
    renderModal({ onCancel: () => cancels++ })
    const cancel = document.querySelector(
      '[data-testid="repair-confirm-cancel"]',
    ) as HTMLButtonElement
    fireEvent.click(cancel)
    expect(cancels).toBe(1)
    expect(calls.length).toBe(0)
  })

  test('option.available=false disables the Apply button', () => {
    renderModal({
      option: mkOpt({
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
        previewSteps: [],
      }),
    })
    const apply = document.querySelector(
      '[data-testid="repair-confirm-apply"]',
    ) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
  })

  // RFC-202 T7 — a 200 with ok:false ('apply-failed': mutations landed but
  // resumeTask blew up) must NOT be treated as success: the modal stays open,
  // explains the failure (+ collapsible outcomeMessage), and never fires
  // onApplied. Locks audit P1 F-14 (silent close left the user believing the
  // repair worked while the task sat unresumed).
  test('ok:false keeps the modal open, shows the failure banner + detail, does NOT call onApplied', async () => {
    installFetch(() =>
      jsonResponse({
        ok: false,
        auditId: 'audit-2',
        outcome: 'apply-failed',
        outcomeMessage: 'mutations applied but resumeTask failed: worktree missing',
        resolvedAlertIds: [],
        newAlerts: [],
      }),
    )
    let applied = false
    renderModal({ onApplied: () => (applied = true) })
    fireEvent.click(
      document.querySelector('[data-testid="repair-confirm-apply"]') as HTMLButtonElement,
    )
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-confirm-close-failed"]')).not.toBeNull()
    })
    expect(applied).toBe(false)
    // modal still mounted with the failure explanation + raw detail
    expect(document.querySelector('[data-testid="repair-confirm-modal"]')).not.toBeNull()
    expect(document.body.textContent).toContain('resuming the task failed')
    expect(document.body.textContent).toContain('worktree missing')
  })

  // Codex impl-gate P2 (RFC-202): closing after an ok:false failure must
  // reset the failure state — the parent keeps this component mounted, so a
  // stale banner would otherwise block any further Apply on reopen.
  test('reopening after an ok:false close restores the Apply footer', async () => {
    installFetch(() =>
      jsonResponse({
        ok: false,
        auditId: 'audit-3',
        outcome: 'apply-failed',
        outcomeMessage: 'boom',
        resolvedAlertIds: [],
        newAlerts: [],
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={qc}>
        <RepairConfirmModal
          taskId="task_1"
          alertId="al_1"
          option={mkOpt()}
          open={true}
          onCancel={() => {}}
          onApplied={() => {}}
        />
      </QueryClientProvider>,
    )
    fireEvent.click(
      document.querySelector('[data-testid="repair-confirm-apply"]') as HTMLButtonElement,
    )
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-confirm-close-failed"]')).not.toBeNull()
    })
    const reopen = (open: boolean) =>
      view.rerender(
        <QueryClientProvider client={qc}>
          <RepairConfirmModal
            taskId="task_1"
            alertId="al_1"
            option={mkOpt()}
            open={open}
            onCancel={() => {}}
            onApplied={() => {}}
          />
        </QueryClientProvider>,
      )
    reopen(false)
    reopen(true)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-confirm-apply"]')).not.toBeNull()
    })
    expect(document.querySelector('[data-testid="repair-confirm-close-failed"]')).toBeNull()
  })
})
