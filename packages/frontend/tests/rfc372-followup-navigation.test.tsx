import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { api } from '../src/api/client'
import { useClarifyFollowup } from '../src/lib/clarify/useClarifyFollowup'

vi.mock('../src/api/client', () => ({ api: { post: vi.fn(), delete: vi.fn() } }))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request = { parentQuestionId: 'q', basis: 'basis', instruction: '' }

test('same mounted page isolates pending state, late replies and cancellation by original round', async () => {
  const a = deferred(),
    b = deferred()
  vi.mocked(api.post).mockImplementation((path) => (path.includes('/A/') ? a.promise : b.promise))
  vi.mocked(api.delete).mockResolvedValue(undefined)
  const refresh = vi.fn(async () => {})
  const { result, rerender } = renderHook(({ id }) => useClarifyFollowup(id, refresh), {
    initialProps: { id: 'A' },
  })
  let first!: Promise<void>, second!: Promise<void>
  await act(async () => {
    first = result.current.start(request, async () => {})
  })
  expect(result.current.pending).toBe(true)
  rerender({ id: 'B' })
  expect(result.current.pending).toBe(false)
  await act(async () => {
    second = result.current.start(request, async () => {})
  })
  expect(result.current.pending).toBe(true)
  await act(async () => {
    a.resolve()
    await first
  })
  expect(refresh).toHaveBeenCalledWith('A')
  expect(result.current.pending).toBe(true)
  await act(async () => {
    await result.current.cancel()
  })
  expect(api.delete).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/clarify\/B\/followup\//))
  expect(result.current.pending).toBe(false)
  await act(async () => {
    b.resolve()
    await second
  })
  rerender({ id: 'A' })
  expect(result.current.pending).toBe(false)
})

test('navigation during draft flush retains the original request context and can cancel on return', async () => {
  const flush = deferred(),
    response = deferred()
  vi.mocked(api.post)
    .mockClear()
    .mockImplementation(() => response.promise)
  vi.mocked(api.delete).mockClear().mockResolvedValue(undefined)
  const refresh = vi.fn(async () => {})
  const { result, rerender } = renderHook(({ id }) => useClarifyFollowup(id, refresh), {
    initialProps: { id: 'A' },
  })
  let pending!: Promise<void>
  await act(async () => {
    pending = result.current.start(request, () => flush.promise)
  })
  rerender({ id: 'B' })
  await act(async () => {
    flush.resolve()
  })
  expect(api.post).toHaveBeenCalledWith('/api/clarify/A/followup', expect.objectContaining(request))
  expect(result.current.pending).toBe(false)
  rerender({ id: 'A' })
  expect(result.current.pending).toBe(true)
  await act(async () => {
    await result.current.cancel()
  })
  expect(api.delete).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/clarify\/A\/followup\//))
  await act(async () => {
    response.resolve()
    await pending
  })
  expect(result.current.pending).toBe(false)
})

test('category retries retain identity only for the same path and instruction', async () => {
  vi.mocked(api.post).mockClear().mockRejectedValue(new Error('lost response'))
  const { result } = renderHook(() => useClarifyFollowup('A', async () => {}))
  const call = async (categoryPath: string[]) =>
    act(async () => {
      await result.current
        .start({ categoryPath, basis: 'same', instruction: 'database' }, async () => {})
        .catch(() => {})
    })
  await call(['Performance'])
  await call(['Performance'])
  await call(['Data'])
  await call([])
  const requests = vi.mocked(api.post).mock.calls.map((call) => call[1] as { requestId: string })
  expect(requests[0]!.requestId).toBe(requests[1]!.requestId)
  expect(requests[1]!.requestId).not.toBe(requests[2]!.requestId)
  expect(requests[2]!.requestId).not.toBe(requests[3]!.requestId)
})
