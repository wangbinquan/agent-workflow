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
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import {
  resolveEffectiveAccountPermissions,
  type PatPublic,
  type Role,
} from '@agent-workflow/shared'
import i18n from '@/i18n'
import { enUS } from '@/i18n/en-US'
import { CreateTokenDialog } from '@/components/account/CreateTokenDialog'
import { ApiError, api } from '@/api/client'
import {
  createPatReconciliationMarker,
  readPatReconciliationMarker,
  writePatReconciliationMarker,
} from '@/lib/pat-reconciliation'
import { BUSY_ESCAPE_AFTER_MS } from '@/components/split/UnsavedChangesGuard'

const ACTOR_ID = 'user-1'

interface RenderDialogOptions {
  actorId?: string
  onCreated?: () => Promise<void> | void
  onRefreshInventory?: () => Promise<readonly PatPublic[]>
  onClose?: () => void
  visiblePats?: readonly PatPublic[]
  open?: boolean
}

async function renderDialog(role: Role, options: RenderDialogOptions = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = options.onClose ?? vi.fn()
  const rootRoute = createRootRoute()
  const tokenRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <CreateTokenDialog
        open={options.open ?? true}
        onClose={onClose}
        actorId={options.actorId ?? ACTOR_ID}
        permissions={[...resolveEffectiveAccountPermissions({ role, additionalPermissions: [] })]}
        visiblePats={options.visiblePats ?? []}
        onCreated={options.onCreated ?? vi.fn()}
        onRefreshInventory={options.onRefreshInventory ?? vi.fn(async () => [])}
      />
    ),
  })
  const elsewhereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/elsewhere',
    component: () => <div data-testid="elsewhere-page">elsewhere</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([tokenRoute, elsewhereRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </I18nextProvider>
    </QueryClientProvider>,
  )
  return { ...view, router, onClose }
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
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RFC-247 AC-23 — the grid shows only what the role can grant', () => {
  test('a plain user sees no repos cell', async () => {
    await renderDialog('user')
    openAdvanced()
    expect(screen.queryByTestId('token-matrix-cell-repos:create')).toBeNull()
    expect(screen.queryByTestId('token-matrix-cell-repos:delete')).toBeNull()
    // …while a resource the user DOES own is present, so the assertion above
    // is about repos rather than about the grid failing to render.
    expect(screen.getByTestId('token-matrix-cell-agents:create')).toBeTruthy()
  })

  test('a manager sees the repos cells', async () => {
    await renderDialog('manager')
    openAdvanced()
    expect(screen.getByTestId('token-matrix-cell-repos:create')).toBeTruthy()
  })

  test('a plain user is not offered tasks:delete (admin-only)', async () => {
    await renderDialog('user')
    openAdvanced()
    expect(screen.queryByTestId('token-matrix-cell-tasks:delete')).toBeNull()
  })
})

describe('RFC-247 AC-8 — delete never rides a template', () => {
  test('picking "full" leaves every delete box unticked and shows no warning', async () => {
    await renderDialog('admin')
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

  test('ticking one delete box raises the warning and names the point', async () => {
    await renderDialog('admin')
    openAdvanced()
    fireEvent.click(screen.getByTestId('token-matrix-cell-agents:delete'))
    const warning = screen.getByTestId('token-delete-warning')
    expect(warning.textContent).toContain('agents:delete')
  })

  test('the confirm button turns destructive once delete is selected', async () => {
    await renderDialog('admin')
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
    await renderDialog('admin', { onCreated })

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

  test('an empty name blocks submission', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await renderDialog('admin')
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
    await renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    expect(
      await screen.findByText(/your role cannot grant some of the selected permissions/),
    ).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'none' })
    // …and it stays on the form, so the selection can be corrected.
    expect(screen.getByTestId('token-create-dialog')).toBeTruthy()
  })
})

describe('RFC-250 T8-T10 — PAT creation state integrity', () => {
  test('an unreadable existing marker locks creation until an explicit read proves none exists', async () => {
    let readable = false
    const backing = new Map<string, string>()
    const storage: Storage = {
      get length() {
        return backing.size
      },
      clear: () => backing.clear(),
      getItem: (key) => {
        if (!readable) throw new DOMException('storage blocked', 'SecurityError')
        return backing.get(key) ?? null
      },
      key: (index) => [...backing.keys()][index] ?? null,
      removeItem: (key) => backing.delete(key),
      setItem: (key, value) => backing.set(key, value),
    }
    vi.stubGlobal('sessionStorage', storage)
    const post = vi.spyOn(api, 'post')
    await renderDialog('admin')

    expect(await screen.findByTestId('token-recovery-read-error')).toBeTruthy()
    expect(screen.queryByTestId('token-create-confirm')).toBeNull()
    expect(post).not.toHaveBeenCalled()

    readable = true
    fireEvent.click(screen.getByTestId('token-recovery-read-retry'))
    expect(await screen.findByTestId('token-create-dialog')).toBeTruthy()
    expect(screen.getByTestId('token-create-confirm')).toBeTruthy()
  })

  test('a storage failure fails closed before POST and renders a structured error', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValue(new Error('POST must not run without a safety marker'))
    const blockedStorage: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('storage blocked', 'SecurityError')
      },
    }
    vi.stubGlobal('sessionStorage', blockedStorage)
    await renderDialog('admin')

    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))

    const error = await screen.findByTestId('token-create-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain(enUS.account.token.markerUnavailable)
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByTestId('token-create-dialog')).toBeTruthy()
  })

  test('creating locks every dismiss path, material control, cancel, and duplicate submit', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(
      async () =>
        await new Promise<never>(() => {
          // Intentionally unsettled: the creating phase must stay visible.
        }),
    )
    const onClose = vi.fn()
    await renderDialog('admin', { onClose })

    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    openAdvanced()
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))

    expect((screen.getByTestId('token-create-name') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('token-purpose-general') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('token-template-full') as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByTestId('token-matrix-cell-agents:create') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(screen.getByTestId('token-advanced-toggle').getAttribute('aria-disabled')).toBe('true')
    expect((screen.getByTestId('token-expiry') as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: enUS.common.cancel }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByTestId('token-create-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: enUS.common.close }) as HTMLButtonElement).disabled,
    ).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByTestId('token-create-dialog'))
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    expect(onClose).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledTimes(1)
  })

  test('revealed secret survives list refresh failure and only explicit Done clears it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            token: 'awpat_keep_until_done',
            pat: { id: 'p1', name: 'ci', scopes: [], purpose: 'mcp_only' },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const refreshFailure = new ApiError(0, 'network-unreachable', 'offline')
    const onCreated = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(refreshFailure)
      .mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    await renderDialog('admin', { onCreated, onClose })

    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    expect((await screen.findByTestId('token-created-value')).textContent).toBe(
      'awpat_keep_until_done',
    )
    expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'none' })
    expect(await screen.findByTestId('token-created-refresh-error')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: enUS.common.close }) as HTMLButtonElement).disabled,
    ).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByTestId('token-created-dialog'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('token-created-value').textContent).toBe('awpat_keep_until_done')

    fireEvent.click(screen.getByRole('button', { name: enUS.account.token.inventoryRefreshRetry }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('token-created-value').textContent).toBe('awpat_keep_until_done')
    await waitFor(() => expect(screen.queryByTestId('token-created-refresh-error')).toBeNull())

    fireEvent.click(screen.getByTestId('token-created-done'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('awpat_keep_until_done')).toBeNull()
  })

  test.each([
    ['HTTP 5xx', new ApiError(503, 'http-503', 'upstream unavailable')],
    ['transport loss', new ApiError(0, 'network-unreachable', 'connection reset')],
    ['body-read timeout', new ApiError(0, 'request-timeout', 'request timed out')],
  ])(
    '%s enters outcome-unknown, reconciles inventory, and never re-POSTs',
    async (_label, error) => {
      const post = vi.spyOn(api, 'post').mockRejectedValue(error)
      const onRefreshInventory = vi.fn(async (): Promise<readonly PatPublic[]> => {
        const stored = readPatReconciliationMarker(ACTOR_ID)
        if (stored.kind !== 'valid') return []
        return [
          {
            id: 'p-new',
            name: stored.marker.name,
            scopes: [...stored.marker.scopes],
            purpose: stored.marker.purpose,
            createdAt: stored.marker.startedAt + 1,
            lastUsedAt: null,
            expiresAt: stored.marker.expiresAt,
            revokedAt: null,
          },
        ]
      })
      const onClose = vi.fn()
      await renderDialog('admin', { onRefreshInventory, onClose })

      fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
      fireEvent.click(screen.getByTestId('token-create-confirm'))

      expect(await screen.findByTestId('token-outcome-unknown-dialog')).toBeTruthy()
      expect(await screen.findByTestId('token-reconcile-candidate-p-new')).toBeTruthy()
      expect(screen.queryByTestId('token-create-confirm')).toBeNull()
      expect(readPatReconciliationMarker(ACTOR_ID).kind).toBe('valid')
      expect(post).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByTestId('token-reconcile-refresh'))
      await waitFor(() => expect(onRefreshInventory).toHaveBeenCalledTimes(2))
      expect(post).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByTestId('token-reconcile-done'))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(readPatReconciliationMarker(ACTOR_ID)).toEqual({ kind: 'none' })
    },
  )

  test('an inventory failure keeps unknown outcome frozen and retries only the GET', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValue(new ApiError(503, 'http-503', 'upstream unavailable'))
    const onRefreshInventory = vi
      .fn<() => Promise<readonly PatPublic[]>>()
      .mockRejectedValueOnce(new ApiError(0, 'network-unreachable', 'offline'))
      .mockResolvedValueOnce([])
    await renderDialog('admin', { onRefreshInventory })

    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))

    expect(await screen.findByTestId('token-reconcile-refresh-error')).toBeTruthy()
    expect(post).toHaveBeenCalledTimes(1)
    expect(readPatReconciliationMarker(ACTOR_ID).kind).toBe('valid')

    fireEvent.click(screen.getByRole('button', { name: enUS.account.token.inventoryRefreshRetry }))
    expect(await screen.findByText(enUS.account.token.reconcileNoCandidates)).toBeTruthy()
    expect(onRefreshInventory).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenCalledTimes(1)
    expect((screen.getByTestId('token-reconcile-done') as HTMLButtonElement).disabled).toBe(false)
  })

  test('a persisted marker auto-opens recovery on remount even when normal Create is closed', async () => {
    const marker = createPatReconciliationMarker({
      actorId: ACTOR_ID,
      startedAt: 1_000,
      name: 'recovered-ci',
      purpose: 'mcp_only',
      scopes: [],
      expiresAt: null,
      visiblePats: [],
    })
    writePatReconciliationMarker(marker)
    const onRefreshInventory = vi.fn(async () => [])

    await renderDialog('admin', { open: false, onRefreshInventory })

    expect(await screen.findByTestId('token-outcome-unknown-dialog')).toBeTruthy()
    expect(screen.queryByTestId('token-create-dialog')).toBeNull()
    await waitFor(() => expect(onRefreshInventory).toHaveBeenCalledTimes(1))
  })

  test('a different actor does not inherit another account recovery marker', async () => {
    writePatReconciliationMarker(
      createPatReconciliationMarker({
        actorId: 'user-a',
        startedAt: 1_000,
        name: 'alice-private-name',
        purpose: 'general',
        scopes: ['tasks:execute'],
        expiresAt: null,
        visiblePats: [],
      }),
    )
    const onRefreshInventory = vi.fn(async () => [])

    await renderDialog('admin', { actorId: 'user-b', open: false, onRefreshInventory })

    expect(screen.queryByTestId('token-outcome-unknown-dialog')).toBeNull()
    expect(screen.queryByText('alice-private-name')).toBeNull()
    expect(onRefreshInventory).not.toHaveBeenCalled()
  })

  test('reload during an in-flight create aborts only the client and recovers from the marker', async () => {
    let requestSignal: AbortSignal | undefined
    vi.spyOn(api, 'post').mockImplementation(
      async (_path, _body, signal) =>
        await new Promise<never>((_resolve, reject) => {
          requestSignal = signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const first = await renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    await waitFor(() => expect(requestSignal).toBeDefined())

    first.unmount()
    expect(requestSignal?.aborted).toBe(true)
    expect(readPatReconciliationMarker(ACTOR_ID).kind).toBe('valid')

    const onRefreshInventory = vi.fn(async () => [])
    await renderDialog('admin', { open: false, onRefreshInventory })
    expect(await screen.findByTestId('token-outcome-unknown-dialog')).toBeTruthy()
    await waitFor(() => expect(onRefreshInventory).toHaveBeenCalledTimes(1))
  })

  test('force-leaving a stalled create aborts only the client wait and preserves recovery marker', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let requestSignal: AbortSignal | undefined
    vi.spyOn(api, 'post').mockImplementation(
      async (_path, _body, signal) =>
        await new Promise<never>((_resolve, reject) => {
          requestSignal = signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const onRefreshInventory = vi.fn(async () => [])
    const { router } = await renderDialog('admin', { onRefreshInventory })
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    await waitFor(() => expect(requestSignal).toBeDefined())

    now += BUSY_ESCAPE_AFTER_MS + 1
    const navigation = router.navigate({ to: '/elsewhere' } as never)
    expect(await screen.findByTestId('unsaved-guard-dialog')).toBeTruthy()
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    fireEvent.click(screen.getByTestId('unsaved-force-leave'))

    await navigation
    expect(requestSignal?.aborted).toBe(true)
    expect(readPatReconciliationMarker(ACTOR_ID).kind).toBe('valid')
    expect(await screen.findByTestId('elsewhere-page')).toBeTruthy()

    await router.navigate({ to: '/' })
    expect(await screen.findByTestId('token-outcome-unknown-dialog')).toBeTruthy()
    await waitFor(() => expect(onRefreshInventory).toHaveBeenCalled())
  })

  test('navigating away from reveal requires the guard confirmation and clears raw secret', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            token: 'awpat_guarded_secret',
            pat: { id: 'p1', name: 'ci', scopes: [], purpose: 'mcp_only' },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const { router } = await renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    expect(await screen.findByText('awpat_guarded_secret')).toBeTruthy()

    const navigation = router.navigate({ to: '/elsewhere' } as never)
    expect(await screen.findByTestId('unsaved-guard-dialog')).toBeTruthy()
    expect(screen.getByText('awpat_guarded_secret')).toBeTruthy()
    expect(screen.getByText(enUS.account.token.leaveRevealBody)).toBeTruthy()
    fireEvent.click(screen.getByTestId('unsaved-discard'))

    await navigation
    expect(await screen.findByTestId('elsewhere-page')).toBeTruthy()
    expect(screen.queryByText('awpat_guarded_secret')).toBeNull()
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
    await renderDialog('admin')
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
    // Both copy paths unavailable: no async Clipboard API, and the dialog-safe
    // execCommand fallback explicitly reports failure. Manual selection remains
    // the final recovery path.
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })

    await renderDialog('admin')
    fireEvent.change(screen.getByTestId('token-create-name'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByTestId('token-create-confirm'))
    fireEvent.click(await screen.findByTestId('token-copy'))

    expect(await screen.findByText(enUS.account.token.copyFailed)).toBeTruthy()
    vi.unstubAllGlobals()
  })
})
