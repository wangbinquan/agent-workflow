// RFC-201 PR-A — Settings renders only its active panel.  These tests lock the
// React ownership boundary: panel unmount must not discard a draft, and an
// older save receipt must not clear edits made while that request was pending.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  SettingsDraftProvider,
  useSettingsConfigDraft,
} from '../src/components/settings/SettingsDraftProvider'
import {
  configReceiptCoordinator,
  readConfigReceipt,
  writeConfigPatch,
} from '../src/lib/config-resource'
import { ConfigAmbiguousWriteError, ConfigReceiptGenerationError } from '../src/lib/config-receipts'
import { SETTINGS_CONFIG_SCOPE_IDS } from '../src/lib/settings-drafts'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

// Navigation policy itself is covered by unsaved-guard.test.tsx.  This focused
// provider suite has no router and isolates draft ownership/receipt behavior.
vi.mock('../src/components/split/UnsavedChangesGuard', () => ({
  UnsavedChangesGuard: () => null,
}))

const initialConfig: Config = { ...DEFAULT_CONFIG, maxConcurrentNodes: 4 }
const limitsScope = SETTINGS_CONFIG_SCOPE_IDS.limits

function wrapper(client: QueryClient) {
  return function Provider({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function LimitsEditor() {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return (
    <div>
      <label>
        Max concurrent
        <input
          aria-label="Max concurrent"
          value={String(draft.state.maxConcurrentNodes)}
          onChange={(event) =>
            draft.setState((previous) => ({
              ...previous,
              maxConcurrentNodes: Number(event.target.value),
            }))
          }
        />
      </label>
      <output data-testid="limits-dirty">{String(draft.dirty)}</output>
    </div>
  )
}

function PersistentHarness({ show }: { show: boolean }) {
  return (
    <SettingsDraftProvider config={initialConfig}>
      {show ? <LimitsEditor /> : <div>another panel</div>}
    </SettingsDraftProvider>
  )
}

function SaveRaceHarness() {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return (
    <div>
      <output data-testid="value">{String(draft.state.maxConcurrentNodes)}</output>
      <output data-testid="dirty">{String(draft.dirty)}</output>
      <output data-testid="pending">{String(draft.save.isPending)}</output>
      <button
        type="button"
        onClick={() => draft.setState((previous) => ({ ...previous, maxConcurrentNodes: 8 }))}
      >
        edit 8
      </button>
      <button type="button" onClick={() => draft.save.mutate()}>
        save
      </button>
      <button
        type="button"
        onClick={() => draft.setState((previous) => ({ ...previous, maxConcurrentNodes: 12 }))}
      >
        edit 12
      </button>
    </div>
  )
}

function NoopSequenceHarness({ onSuccess }: { onSuccess: (config: Config) => void }) {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return (
    <button type="button" onClick={() => draft.save.mutate(undefined, { onSuccess })}>
      continue sequence
    </button>
  )
}

function StaleDiscardHarness() {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return (
    <div>
      <output data-testid="value">{String(draft.state.maxConcurrentNodes)}</output>
      <output data-testid="dirty">{String(draft.dirty)}</output>
      <output data-testid="stale">{String(draft.stale)}</output>
      <button
        type="button"
        onClick={() => draft.setState((previous) => ({ ...previous, maxConcurrentNodes: 8 }))}
      >
        edit local
      </button>
      <button type="button" onClick={draft.discard}>
        use server
      </button>
    </div>
  )
}

function WriteBlockHarness() {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return <output data-testid="config-write-blocked">{String(draft.writeBlocked)}</output>
}

function TokenRotateSaveHarness({
  onSuccess,
  onError,
}: {
  onSuccess: (config: Config) => void
  onError: (error: unknown) => void
}) {
  const draft = useSettingsConfigDraft(limitsScope, initialConfig)
  return (
    <div>
      <output data-testid="token-rotate-pending">{String(draft.save.isPending)}</output>
      <button
        type="button"
        onClick={() => draft.setState((previous) => ({ ...previous, maxConcurrentNodes: 8 }))}
      >
        token edit
      </button>
      <button type="button" onClick={() => draft.save.mutate(undefined, { onSuccess, onError })}>
        token save
      </button>
    </div>
  )
}

let providerBaseUrl: string

beforeEach(() => {
  providerBaseUrl = `http://settings-draft-provider-${crypto.randomUUID()}.test`
  setBaseUrl(providerBaseUrl)
  setToken(`settings-provider-${crypto.randomUUID()}`)
})

afterEach(() => {
  clearToken()
  vi.restoreAllMocks()
})

describe('SettingsDraftProvider', () => {
  test('active panel unmount/remount keeps the route-owned section draft', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<PersistentHarness show />, { wrapper: wrapper(client) })

    fireEvent.change(screen.getByRole('textbox', { name: 'Max concurrent' }), {
      target: { value: '9' },
    })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Max concurrent' }).value).toBe(
      '9',
    )

    view.rerender(<PersistentHarness show={false} />)
    expect(screen.queryByRole('textbox', { name: 'Max concurrent' })).toBeNull()
    view.rerender(<PersistentHarness show />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Max concurrent' }).value).toBe(
      '9',
    )
  })

  test('credential rotation preserves the same-daemon draft', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<PersistentHarness show />, { wrapper: wrapper(client) })

    fireEvent.change(screen.getByRole('textbox', { name: 'Max concurrent' }), {
      target: { value: '9' },
    })
    expect(screen.getByTestId('limits-dirty').textContent).toBe('true')

    act(() => setToken(`rotated-${crypto.randomUUID()}`))

    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Max concurrent' }).value).toBe(
        '9',
      ),
    )
    expect(screen.getByTestId('limits-dirty').textContent).toBe('true')
  })

  test('daemon switch resets the old resource draft instead of carrying its patch', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<PersistentHarness show />, { wrapper: wrapper(client) })

    fireEvent.change(screen.getByRole('textbox', { name: 'Max concurrent' }), {
      target: { value: '9' },
    })
    expect(screen.getByTestId('limits-dirty').textContent).toBe('true')

    act(() => setBaseUrl(`${providerBaseUrl}-other`))

    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Max concurrent' }).value).toBe(
        '4',
      ),
    )
    expect(screen.getByTestId('limits-dirty').textContent).toBe('false')
  })

  test('an external ambiguous Config write updates an already-mounted Settings leaf', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection lost'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <SettingsDraftProvider config={initialConfig}>
        <WriteBlockHarness />
      </SettingsDraftProvider>,
      { wrapper: wrapper(client) },
    )
    expect(screen.getByTestId('config-write-blocked').textContent).toBe('false')

    let writeError: unknown
    await act(async () => {
      try {
        await writeConfigPatch({ language: 'en-US' })
      } catch (error) {
        writeError = error
      }
    })

    expect(writeError).toBeInstanceOf(ConfigAmbiguousWriteError)
    await waitFor(() => expect(screen.getByTestId('config-write-blocked').textContent).toBe('true'))
  })

  test('token rotation after receipt publication settles busy but does not continue success', async () => {
    let persisted = initialConfig
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        const patch = JSON.parse(String(init?.body)) as Partial<Config>
        persisted = { ...persisted, ...patch }
      }
      return new Response(JSON.stringify(persisted), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <SettingsDraftProvider config={initialConfig}>
        <TokenRotateSaveHarness onSuccess={onSuccess} onError={onError} />
      </SettingsDraftProvider>,
      { wrapper: wrapper(client) },
    )

    let rotated = false
    const unsubscribe = configReceiptCoordinator.subscribe(() => {
      if (!rotated && configReceiptCoordinator.getSnapshot()?.type === 'write') {
        rotated = true
        setToken(`receipt-rotation-${crypto.randomUUID()}`)
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'token edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'token save' }))

    await waitFor(() =>
      expect(screen.getByTestId('token-rotate-pending').textContent).toBe('false'),
    )
    expect(rotated).toBe(true)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ConfigReceiptGenerationError)
    unsubscribe()
  })

  test('writes only the owned projection and keeps a newer edit dirty after the older receipt', async () => {
    let resolvePut!: (response: Response) => void
    const pendingPut = new Promise<Response>((resolve) => {
      resolvePut = resolve
    })
    let persisted: Config = initialConfig
    const putBodies: unknown[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (path.includes('/api/config') && method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body)))
        return pendingPut
      }
      if (path.includes('/api/config') && method === 'GET') {
        return new Response(JSON.stringify(persisted), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <SettingsDraftProvider config={initialConfig}>
        <SaveRaceHarness />
      </SettingsDraftProvider>,
      { wrapper: wrapper(client) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'edit 8' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(putBodies).toHaveLength(1))
    expect(screen.getByTestId('pending').textContent).toBe('true')

    const body = putBodies[0] as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['maxConcurrentNodes'])
    expect(body.maxConcurrentNodes).toBe(8)
    expect(body).not.toHaveProperty('language')
    expect(body).not.toHaveProperty('bindHost')

    fireEvent.click(screen.getByRole('button', { name: 'edit 12' }))
    expect(screen.getByTestId('value').textContent).toBe('12')
    persisted = { ...initialConfig, maxConcurrentNodes: 8 }
    await act(async () => {
      resolvePut(
        new Response(JSON.stringify(persisted), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await pendingPut
    })

    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('false'))
    expect(screen.getByTestId('value').textContent).toBe('12')
    expect(screen.getByTestId('dirty').textContent).toBe('true')
  })

  test('clean config scope continues a caller sequence without manufacturing a PUT', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const onSuccess = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <SettingsDraftProvider config={initialConfig}>
        <NoopSequenceHarness onSuccess={onSuccess} />
      </SettingsDraftProvider>,
      { wrapper: wrapper(client) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'continue sequence' }))
    expect(onSuccess).toHaveBeenCalledWith(initialConfig)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('discarding a stale draft adopts the accepted server projection, not the old baseline', async () => {
    const foreignConfig = { ...initialConfig, maxConcurrentNodes: 6 }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(foreignConfig), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <SettingsDraftProvider config={initialConfig}>
        <StaleDiscardHarness />
      </SettingsDraftProvider>,
      { wrapper: wrapper(client) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'edit local' }))
    expect(screen.getByTestId('value').textContent).toBe('8')

    await act(async () => {
      await readConfigReceipt()
    })
    await waitFor(() => expect(screen.getByTestId('stale').textContent).toBe('true'))
    expect(screen.getByTestId('value').textContent).toBe('8')

    fireEvent.click(screen.getByRole('button', { name: 'use server' }))
    expect(screen.getByTestId('value').textContent).toBe('6')
    expect(screen.getByTestId('dirty').textContent).toBe('false')
    expect(screen.getByTestId('stale').textContent).toBe('false')
  })
})
