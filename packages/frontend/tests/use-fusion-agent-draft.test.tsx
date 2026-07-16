// RFC-201 PR-A — the Settings route owns the fusion-agent edit scope above
// active-only section rendering.  These tests lock the causal draft contract:
// section switches cannot drop edits, writes stay runtime-only, and late or
// outcome-unknown receipts never replace newer local intent.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Agent } from '@agent-workflow/shared'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError, api } from '../src/api/client'
import {
  FusionAgentGenerationError,
  SKILL_MERGER_AGENT_NAME,
  type FusionAgentPreparedSave,
  getFusionAgentDraftQueryKey,
  getFusionAgentQueryKey,
  useFusionAgentDraft,
} from '../src/components/settings/useFusionAgentDraft'
import { clearToken, getBaseUrl, setBaseUrl, setToken } from '../src/stores/auth'

function merger(runtime: string | null): Agent {
  return {
    name: SKILL_MERGER_AGENT_NAME,
    runtime,
    builtin: true,
  } as Agent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function harness() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

let testBaseUrl: string

beforeEach(() => {
  testBaseUrl = `http://fusion-agent-${crypto.randomUUID()}.test`
  setBaseUrl(testBaseUrl)
  setToken('fusion-agent-token')
})

afterEach(() => {
  cleanup()
  clearToken()
  setBaseUrl(`http://fusion-agent-cleanup-${crypto.randomUUID()}.test`)
  vi.restoreAllMocks()
})

describe('useFusionAgentDraft — route-owned section lifetime', () => {
  test('is disabled before first success and preserves a dirty draft across enabled false/true', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const { wrapper } = harness()
    const { result, rerender } = renderHook(({ enabled }) => useFusionAgentDraft({ enabled }), {
      wrapper,
      initialProps: { enabled: false },
    })

    expect(get).not.toHaveBeenCalled()
    expect(result.current.loaded).toBe(false)
    expect(result.current.value).toBeNull()
    act(() => result.current.setValue('ignored-before-load'))
    expect(result.current.dirty).toBe(false)

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.value).toBe('opencode')

    act(() => result.current.setValue('fast-oc'))
    expect(result.current.dirty).toBe(true)
    rerender({ enabled: false })
    expect(result.current.value).toBe('fast-oc')
    rerender({ enabled: true })

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(result.current.value).toBe('fast-oc')
    expect(result.current.dirty).toBe(true)
  })

  test('saves an exact runtime-only agent patch and never touches config', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const put = vi.spyOn(api, 'put').mockResolvedValue(merger('fast-oc') as never)
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('fast-oc'))
    act(() => result.current.save.mutate())

    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith(`/api/agents/${SKILL_MERGER_AGENT_NAME}`, {
      runtime: 'fast-oc',
    })
    expect(put.mock.calls.every(([path]) => !String(path).includes('/api/config'))).toBe(true)
    expect(client.getQueryData(getFusionAgentQueryKey())).toMatchObject({
      runtime: 'fast-oc',
    })
    expect(result.current.dirty).toBe(false)
  })

  test('a matching late receipt advances the baseline without replacing a newer edit', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const pending = deferred<Agent>()
    vi.spyOn(api, 'put').mockReturnValue(pending.promise as never)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('submitted'))
    act(() => result.current.save.mutate())
    await waitFor(() => expect(result.current.busy).toBe(true))
    act(() => result.current.setValue('newer-local-edit'))
    act(() => pending.resolve(merger('submitted')))

    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))
    expect(result.current.value).toBe('newer-local-edit')
    expect(result.current.dirty).toBe(true)
    expect(result.current.busy).toBe(false)
  })

  test('prepare synchronously captures the exact save and a later commit preserves newer editing', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const pending = deferred<Agent>()
    const put = vi.spyOn(api, 'put').mockReturnValue(pending.promise as never)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('captured-runtime'))
    const preparedRef: { current: FusionAgentPreparedSave | null } = { current: null }
    act(() => {
      preparedRef.current = result.current.save.prepare()
    })
    const prepared = preparedRef.current
    expect(prepared).not.toBeNull()
    expect(prepared).toMatchObject({
      submittedRevision: 1,
      runtime: 'captured-runtime',
    })
    expect(prepared?.requestId).toMatch(/^settings-fusion-/)
    expect(result.current.busy).toBe(true)
    expect(put).not.toHaveBeenCalled()

    act(() => result.current.setValue('newer-runtime'))
    act(() => prepared?.commit())
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith(`/api/agents/${SKILL_MERGER_AGENT_NAME}`, {
      runtime: 'captured-runtime',
    })
    act(() => pending.resolve(merger('captured-runtime')))

    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))
    expect(result.current.value).toBe('newer-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.busy).toBe(false)
  })

  test('cancel releases only an undispatched preparation and permits a new exact save', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const put = vi.spyOn(api, 'put').mockResolvedValue(merger('second-runtime') as never)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('first-runtime'))
    const cancelled = result.current.save.prepare()
    act(() => result.current.setValue('second-runtime'))
    act(() => cancelled?.cancel())

    expect(put).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
    expect(result.current.value).toBe('second-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.error).toBeNull()

    const committed = result.current.save.prepare()
    expect(committed?.runtime).toBe('second-runtime')
    expect(committed?.requestId).not.toBe(cancelled?.requestId)
    act(() => committed?.commit())
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))
    expect(put).toHaveBeenCalledTimes(1)
    expect(result.current.dirty).toBe(false)
  })

  test('a GET issued before an accepted write cannot overwrite its receipt or canonical cache', async () => {
    const oldRead = deferred<Agent>()
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockReturnValueOnce(oldRead.promise as never)
    vi.spyOn(api, 'put').mockResolvedValue(merger('fast-oc') as never)
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => {
      void result.current.query.refetch()
    })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    act(() => result.current.setValue('fast-oc'))
    act(() => result.current.save.mutate())
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true))

    act(() => oldRead.resolve(merger('opencode')))
    await waitFor(() => expect(result.current.query.isFetching).toBe(false))
    expect(result.current.value).toBe('fast-oc')
    expect(result.current.dirty).toBe(false)
    expect(client.getQueryData(getFusionAgentQueryKey())).toMatchObject({
      runtime: 'fast-oc',
    })
    expect(client.getQueryData(getFusionAgentDraftQueryKey())).toMatchObject({
      agent: { runtime: 'fast-oc' },
    })
  })

  test('an accepted save receipt survives unmount and a failing fresh GET in the same cache', async () => {
    const freshReadError = new TypeError('fresh read unavailable')
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockRejectedValueOnce(freshReadError)
    vi.spyOn(api, 'put').mockResolvedValue(merger('saved-runtime') as never)
    const { client, wrapper } = harness()
    const first = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(first.result.current.loaded).toBe(true))

    act(() => first.result.current.setValue('saved-runtime'))
    act(() => first.result.current.save.mutate())
    await waitFor(() => expect(first.result.current.save.isSuccess).toBe(true))
    first.unmount()

    const second = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    expect(second.result.current.loaded).toBe(true)
    expect(second.result.current.value).toBe('saved-runtime')
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(second.result.current.query.isFetching).toBe(false))

    expect(second.result.current.value).toBe('saved-runtime')
    expect(second.result.current.dirty).toBe(false)
    expect(client.getQueryData(getFusionAgentQueryKey())).toMatchObject({
      runtime: 'saved-runtime',
    })
    expect(client.getQueryData(getFusionAgentDraftQueryKey())).toMatchObject({
      agent: { runtime: 'saved-runtime' },
    })
  })
})

describe('useFusionAgentDraft — failure classification and reconciliation', () => {
  test('an ApiError is definitive: it remains dirty and does not issue a reconciliation GET', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(merger('opencode') as never)
    const failure = new ApiError(422, 'runtime-not-found', 'missing runtime')
    vi.spyOn(api, 'put').mockRejectedValue(failure)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('missing'))
    act(() => result.current.save.mutate())

    await waitFor(() => expect(result.current.save.error).toBe(failure))
    expect(get).toHaveBeenCalledTimes(1)
    expect(result.current.value).toBe('missing')
    expect(result.current.dirty).toBe(true)
    expect(result.current.busy).toBe(false)
    expect(result.current.save.isSuccess).toBe(false)
  })

  test('an HTTP 5xx after dispatch remains outcome-unknown and cannot be retried or discarded', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(merger('initial-runtime') as never)
    const failure = new ApiError(
      500,
      'internal-error',
      'failed after the update may have committed',
    )
    const put = vi.spyOn(api, 'put').mockRejectedValue(failure)
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('initial-runtime'))

    act(() => result.current.setValue('possibly-written-runtime'))
    act(() => result.current.save.mutate({ onSuccess, onError }))

    await waitFor(() => expect(result.current.outcomeUnknown).toBe(true))
    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.value).toBe('possibly-written-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
    expect(result.current.save.prepare()).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()

    act(() => result.current.save.mutate())
    expect(put).toHaveBeenCalledTimes(1)
    let discarded = true
    await act(async () => {
      discarded = await result.current.discard()
    })
    expect(discarded).toBe(false)
    expect(result.current.outcomeUnknown).toBe(true)
  })

  test('an exact-match GET after response loss remains outcome-unknown and blocks success or retry', async () => {
    const transportError = new TypeError('connection closed after send')
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockResolvedValue(merger('fast-oc') as never)
    const put = vi.spyOn(api, 'put').mockRejectedValue(transportError)
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onSettled = vi.fn()
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('fast-oc'))
    act(() => result.current.save.mutate({ onSuccess, onError, onSettled }))

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.outcomeUnknown).toBe(true))
    await waitFor(() => expect(onError).toHaveBeenCalledWith(transportError))
    expect(result.current.value).toBe('fast-oc')
    expect(result.current.dirty).toBe(true)
    expect(result.current.stale).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
    expect(result.current.save.error).toBe(transportError)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(undefined, transportError)

    act(() => result.current.save.mutate())
    expect(put).toHaveBeenCalledTimes(1)
    expect(result.current.save.prepare()).toBeNull()

    let resolved = true
    await act(async () => {
      resolved = await result.current.reconcile()
    })
    expect(resolved).toBe(false)
    expect(get).toHaveBeenCalledTimes(3)
    expect(result.current.outcomeUnknown).toBe(true)
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledTimes(1)
  })

  test('a failed observation stays outcome-unknown and a later matching observation cannot confirm it', async () => {
    const reconciliationError = new TypeError('reconciliation read unavailable')
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockRejectedValueOnce(reconciliationError)
      .mockResolvedValueOnce(merger('fast-oc') as never)
    vi.spyOn(api, 'put').mockRejectedValue(new TypeError('connection closed after send'))
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('fast-oc'))
    act(() => result.current.save.mutate())
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.outcomeUnknown).toBe(true))
    expect(result.current.stale).toBe(true)
    expect(result.current.save.error).toBe(reconciliationError)
    expect(result.current.save.prepare()).toBeNull()

    let resolved = false
    await act(async () => {
      resolved = await result.current.reconcile()
    })
    expect(resolved).toBe(false)
    expect(get).toHaveBeenCalledTimes(3)
    expect(result.current.outcomeUnknown).toBe(true)
    expect(result.current.stale).toBe(true)
    expect(result.current.value).toBe('fast-oc')
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
  })

  test('a non-matching reconciliation remains fail-closed and cannot discard or retry', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockResolvedValue(merger('foreign-runtime') as never)
    vi.spyOn(api, 'put').mockRejectedValue(new TypeError('connection closed after send'))
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('possibly-late-runtime'))
    act(() => result.current.save.mutate())
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.outcomeUnknown).toBe(true))

    expect(result.current.value).toBe('possibly-late-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.stale).toBe(true)
    expect(result.current.save.prepare()).toBeNull()
    let discarded = true
    await act(async () => {
      discarded = await result.current.discard()
    })
    expect(discarded).toBe(false)
    expect(result.current.outcomeUnknown).toBe(true)
    expect(result.current.value).toBe('possibly-late-runtime')
  })

  test('discard adopts an accepted foreign remote for an ordinary stale draft', async () => {
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(merger('opencode') as never)
      .mockResolvedValueOnce(merger('foreign-runtime') as never)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => result.current.setValue('local-runtime'))
    await act(async () => {
      await result.current.query.refetch()
    })
    await waitFor(() => expect(result.current.stale).toBe(true))
    expect(result.current.value).toBe('local-runtime')

    let discarded = false
    await act(async () => {
      discarded = await result.current.discard()
    })
    expect(discarded).toBe(true)
    expect(result.current.value).toBe('foreign-runtime')
    expect(result.current.dirty).toBe(false)
    expect(result.current.stale).toBe(false)
  })
})

describe('useFusionAgentDraft — daemon and credential identity fences', () => {
  test('daemon B never renders or saves daemon A cache while its own read is pending', async () => {
    const daemonA = testBaseUrl
    const daemonB = `http://fusion-agent-b-${crypto.randomUUID()}.test`
    const bRead = deferred<Agent>()
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation(() =>
        getBaseUrl() === daemonA
          ? (Promise.resolve(merger('daemon-a-runtime')) as never)
          : (bRead.promise as never),
      )
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('daemon-a-runtime'))

    act(() => setBaseUrl(daemonB))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))

    expect(result.current.loaded).toBe(false)
    expect(result.current.value).toBeNull()
    expect(result.current.save.prepare()).toBeNull()
    expect(client.getQueryData(getFusionAgentDraftQueryKey(daemonB))).toBeUndefined()

    act(() => bRead.resolve(merger('daemon-b-runtime')))
    await waitFor(() => expect(result.current.value).toBe('daemon-b-runtime'))
    expect(client.getQueryData(getFusionAgentDraftQueryKey(daemonA))).toMatchObject({
      agent: { runtime: 'daemon-a-runtime' },
    })
    expect(client.getQueryData(getFusionAgentDraftQueryKey(daemonB))).toMatchObject({
      agent: { runtime: 'daemon-b-runtime' },
    })
  })

  test('a daemon A PUT that settles after switching to B cannot settle or pollute B', async () => {
    const daemonA = testBaseUrl
    const daemonB = `http://fusion-agent-b-${crypto.randomUUID()}.test`
    const aWrite = deferred<Agent>()
    vi.spyOn(api, 'get').mockImplementation(
      () =>
        Promise.resolve(
          merger(getBaseUrl() === daemonA ? 'daemon-a-runtime' : 'daemon-b-runtime'),
        ) as never,
    )
    const put = vi.spyOn(api, 'put').mockReturnValue(aWrite.promise as never)
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('daemon-a-runtime'))

    act(() => result.current.setValue('daemon-a-intent'))
    act(() => result.current.save.mutate())
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))

    act(() => setBaseUrl(daemonB))
    await waitFor(() => expect(result.current.value).toBe('daemon-b-runtime'))
    expect(result.current.outcomeUnknown).toBe(false)
    act(() => result.current.setValue('daemon-b-local'))

    act(() => aWrite.resolve(merger('daemon-a-intent')))
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.value).toBe('daemon-b-local')
    expect(result.current.dirty).toBe(true)
    expect(result.current.outcomeUnknown).toBe(false)
    expect(client.getQueryData(getFusionAgentDraftQueryKey(daemonB))).toMatchObject({
      agent: { runtime: 'daemon-b-runtime' },
    })

    act(() => setBaseUrl(daemonA))
    await waitFor(() => expect(result.current.value).toBe('daemon-a-intent'))
    expect(result.current.outcomeUnknown).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
  })

  test('token rotation preserves dirty intent and rejects an old-token GET before accepting a fresh one', async () => {
    const oldTokenRead = deferred<Agent>()
    const freshTokenRead = deferred<Agent>()
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(merger('initial-runtime') as never)
      .mockReturnValueOnce(oldTokenRead.promise as never)
      .mockReturnValueOnce(freshTokenRead.promise as never)
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('initial-runtime'))

    act(() => result.current.setValue('local-dirty-runtime'))
    act(() => {
      void result.current.query.refetch()
    })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))

    act(() => setToken('rotated-fusion-agent-token'))
    act(() => oldTokenRead.resolve(merger('old-token-foreign-runtime')))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
    expect(result.current.value).toBe('local-dirty-runtime')
    expect(result.current.dirty).toBe(true)

    act(() => freshTokenRead.resolve(merger('fresh-token-runtime')))
    await waitFor(() => expect(result.current.query.isFetching).toBe(false))
    expect(result.current.value).toBe('local-dirty-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.stale).toBe(true)
  })

  test('token rotation makes an already-dispatched PUT outcome-unknown and late success cannot clean it', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(merger('initial-runtime') as never)
    const write = deferred<Agent>()
    vi.spyOn(api, 'put').mockReturnValue(write.promise as never)
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onSettled = vi.fn()
    const { wrapper } = harness()
    const { result } = renderHook(() => useFusionAgentDraft({ enabled: true }), { wrapper })
    await waitFor(() => expect(result.current.value).toBe('initial-runtime'))

    act(() => result.current.setValue('possibly-written-runtime'))
    act(() => result.current.save.mutate({ onSuccess, onError, onSettled }))
    await waitFor(() => expect(result.current.busy).toBe(true))

    act(() => setToken('rotated-fusion-agent-token'))
    await waitFor(() => expect(result.current.outcomeUnknown).toBe(true))
    expect(result.current.busy).toBe(false)
    expect(result.current.value).toBe('possibly-written-runtime')
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.any(FusionAgentGenerationError)),
    )

    act(() => write.resolve(merger('possibly-written-runtime')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.outcomeUnknown).toBe(true)
    expect(result.current.dirty).toBe(true)
    expect(result.current.save.isSuccess).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(undefined, expect.any(FusionAgentGenerationError))
  })
})
