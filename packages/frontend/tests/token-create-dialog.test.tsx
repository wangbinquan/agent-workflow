// RFC-247 D1 / D2 / D3 / D4 / AC-8 / AC-23 — the token creation surface.
//
// `token-matrix.test.ts` locks the derivation; this file locks what the user
// actually experiences on top of it, which is where the safety properties are
// either honoured or quietly lost:
//
//   · a plain user is never shown a permission their role cannot grant
//   · no template selects a delete point, and picking delete forces the grid
//   · the request body carries the matrix verbatim (no silent widening)
//   · the raw token is displayed once and never re-fetched

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { Role } from '@agent-workflow/shared'
import i18n from '@/i18n'
import { enUS } from '@/i18n/en-US'
import { CreateTokenDialog } from '@/components/account/CreateTokenDialog'

function renderDialog(role: Role, onCreated = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <CreateTokenDialog open onClose={vi.fn()} role={role} onCreated={onCreated} />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

function openAdvanced(): void {
  // <details> does not toggle from a click in jsdom the way it does in a
  // browser; drive the element's own state so the grid mounts.
  const details = document.querySelector('details.account-technical-details')
  if (details === null) throw new Error('advanced section missing')
  fireEvent.click(within(details as HTMLElement).getByText(enUS.account.token.advanced))
  ;(details as HTMLDetailsElement).open = true
  fireEvent(details, new Event('toggle'))
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-247 AC-23 — the grid shows only what the role can grant', () => {
  test('a plain user sees no repos cell', () => {
    renderDialog('user')
    openAdvanced()
    expect(screen.queryByTestId('token-matrix-cell-repos:create')).toBeNull()
    expect(screen.queryByTestId('token-matrix-cell-repos:delete')).toBeNull()
    // …while a resource the user DOES own is present, so the assertion above
    // is about repos rather than about the grid failing to render.
    expect(screen.getByTestId('token-matrix-cell-agents:create')).toBeTruthy()
  })

  test('a manager sees the repos cells', () => {
    renderDialog('manager')
    openAdvanced()
    expect(screen.getByTestId('token-matrix-cell-repos:create')).toBeTruthy()
  })

  test('a plain user is not offered tasks:delete (admin-only)', () => {
    renderDialog('user')
    openAdvanced()
    expect(screen.queryByTestId('token-matrix-cell-tasks:delete')).toBeNull()
  })
})

describe('RFC-247 AC-8 — delete never rides a template', () => {
  test('picking "full" leaves every delete box unticked and shows no warning', () => {
    renderDialog('admin')
    fireEvent.click(screen.getByTestId('token-template-full'))
    openAdvanced()
    for (const point of ['agents:delete', 'workflows:delete', 'tasks:delete']) {
      expect((screen.getByTestId(`token-matrix-cell-${point}`) as HTMLInputElement).checked).toBe(
        false,
      )
    }
    // The write verbs it DID select — otherwise this test would pass on a
    // template that grants nothing at all.
    expect(
      (screen.getByTestId('token-matrix-cell-agents:create') as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.queryByTestId('token-delete-warning')).toBeNull()
  })

  test('ticking one delete box raises the warning and names the point', () => {
    renderDialog('admin')
    openAdvanced()
    fireEvent.click(screen.getByTestId('token-matrix-cell-agents:delete'))
    const warning = screen.getByTestId('token-delete-warning')
    expect(warning.textContent).toContain('agents:delete')
  })

  test('the confirm button turns destructive once delete is selected', () => {
    renderDialog('admin')
    const confirm = screen.getByTestId('token-create-confirm')
    expect(confirm.className).toContain('btn--primary')
    openAdvanced()
    fireEvent.click(screen.getByTestId('token-matrix-cell-agents:delete'))
    expect(screen.getByTestId('token-create-confirm').className).toContain('btn--danger')
  })
})

describe('RFC-247 — submission carries the matrix verbatim', () => {
  test('the POST body is exactly what was ticked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          token: 'awpat_deadbeefdeadbeefdeadbeef',
          pat: { id: 'p1', name: 'ci', scopes: [], purpose: 'general' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const onCreated = vi.fn()
    renderDialog('admin', onCreated)

    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci-launcher' } })
    fireEvent.click(screen.getByTestId('token-template-task-automation'))
    fireEvent.click(screen.getByTestId('token-purpose-general'))
    fireEvent.click(screen.getByTestId('token-create-confirm'))

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(init.body)) as {
      name: string
      scopes: string[]
      purpose: string
      expiresAt: number | null
    }
    expect(body.name).toBe('ci-launcher')
    expect(body.purpose).toBe('general')
    expect(body.scopes).toContain('tasks:execute')
    expect(body.scopes.filter((s) => s.endsWith(':delete'))).toEqual([])
    // Default expiry is 90 days, not "never" — a token that never expires
    // should be a decision, not what you get by not making one.
    expect(body.expiresAt).not.toBeNull()

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  test('an empty name blocks submission', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderDialog('admin')
    const confirm = screen.getByTestId('token-create-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('a backend refusal is surfaced verbatim, not flattened', async () => {
    // `pat-scope-ungrantable` names which points were refused; replacing that
    // with "creation failed" throws away the only useful part.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 'pat-scope-ungrantable',
            message: 'your role cannot grant some of the selected permissions',
          },
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      )
    })
    renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    expect(
      await screen.findByText(/your role cannot grant some of the selected permissions/),
    ).toBeTruthy()
    // …and it stays on the form, so the selection can be corrected.
    expect(screen.getByTestId('token-create-dialog')).toBeTruthy()
  })
})

describe('RFC-247 — the secret is shown once', () => {
  test('the raw token appears after creation and the form is gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          token: 'awpat_visible_once_only',
          pat: { id: 'p1', name: 'ci', scopes: [], purpose: 'mcp_only' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    })
    renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))

    expect((await screen.findByTestId('token-created-value')).textContent).toBe(
      'awpat_visible_once_only',
    )
    expect(screen.queryByTestId('token-create-confirm')).toBeNull()
    expect(screen.getByText(enUS.account.token.shownOnceTitle)).toBeTruthy()
  })

  test('a failed copy says so instead of silently doing nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            token: 'awpat_x',
            pat: { id: 'p1', name: 'ci', scopes: [], purpose: 'mcp_only' },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    // Both copy paths unavailable: no async Clipboard API, and execCommand
    // reporting failure — the plain-http LAN case lib/clipboard.ts warns about,
    // made worse inside a Dialog whose focus trap fights the fallback.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })

    renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    fireEvent.click(await screen.findByTestId('token-copy'))

    expect(await screen.findByText(enUS.account.token.copyFailed)).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
