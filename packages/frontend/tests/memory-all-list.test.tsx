// MemoryAllList contract — locks the post-RFC-041 bug-fix:
//   1. The Approved / Archived filter drives the GET status= param.
//   2. Archive and Delete go through the shared <Dialog> (no
//      window.confirm). Clicking the row button opens the dialog;
//      Cancel MUST NOT POST; Confirm POSTs to the right endpoint.
//   3. In Archived view, the row's primary action is Unarchive and
//      POSTs /unarchive directly (no dialog — restore is harmless).
//   4. Non-admin sees the action buttons disabled in both views.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { seedFullAccessActor } from './unexpectedNetwork'
import { MemoryAllList } from '../src/components/memory/MemoryAllList'
import '../src/i18n'

function mkMem(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_1',
    scopeType: 'global',
    scopeId: null,
    title: 'Prefer Option A',
    status: 'approved',
    tags: [],
    approvedAt: 1700000000000,
    version: 1,
    distillAction: null,
    fusedIntoSkillId: null,
    canManage: true,
    ...overrides,
  }
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
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

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seedFullAccessActor(qc)
  return render(
    <QueryClientProvider client={qc}>
      <MemoryAllList />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('MemoryAllList — Approved/Archived filter + in-app confirm dialog', () => {
  // RFC-352 T8 —— 分页是本次**新增**的能力，正向覆盖必须有：
  // 服务端给了 nextCursor 才出「加载更多」，点一次要带着游标再请求并把两页拼起来；
  // nextCursor 为 null 时按钮不该出现（否则用户会一直点一个什么都不加载的按钮）。
  test('分页：有 nextCursor 才出加载更多，点击后带游标续拉并拼接', async () => {
    const urls: string[] = []
    installFetch(({ url }) => {
      urls.push(url)
      const cursor = new URL(url).searchParams.get('cursor')
      return new Response(
        JSON.stringify(
          cursor === null
            ? { items: [mkMem({ id: 'mem_1' })], nextCursor: 'CURSOR_1' }
            : { items: [mkMem({ id: 'mem_2' })], nextCursor: null },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    wrap()
    await screen.findByTestId('memory-all-mem_1-archive')
    // 首页恒发 limit —— 不发就落回旧的全量形状，封套解析会炸。
    expect(urls[0]).toContain('limit=50')
    expect(urls[0]).not.toContain('cursor=')

    fireEvent.click(await screen.findByTestId('memory-all-load-more'))
    await screen.findByTestId('memory-all-mem_2-archive')
    expect(urls.some((u) => u.includes('cursor=CURSOR_1'))).toBe(true)
    // 两页都在，前一页没被替换掉。
    expect(screen.getByTestId('memory-all-mem_1-archive')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('memory-all-load-more')).toBeNull())
  })

  test('Approved / Archived reuses the task-list view switch without page-tab semantics', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap()
    await screen.findByTestId('memory-all-mem_1-archive')

    const switcher = screen.getByRole('radiogroup')
    expect(switcher.classList.contains('list-view-switch')).toBe(true)
    expect(switcher.parentElement?.classList.contains('page-filter')).toBe(true)
    expect(switcher.parentElement?.classList.contains('memory-all__filter')).toBe(true)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('memory-all-filter-approved').getAttribute('role')).toBe('radio')
    expect(screen.getByTestId('memory-all-filter-approved').getAttribute('aria-checked')).toBe(
      'true',
    )

    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    expect(screen.getByTestId('memory-all-filter-archived').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  test('default view is Approved → GET ?status=approved', async () => {
    const calls = installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap()
    await waitFor(() => {
      expect(screen.getByTestId('memory-all-mem_1-archive')).toBeTruthy()
    })
    const get = calls.find((c) => c.method === 'GET')
    expect(get?.url).toContain('status=approved')
  })

  test('switching to Archived re-queries with ?status=archived and shows Unarchive', async () => {
    let lastStatusParam: string | null = null
    installFetch(({ url }) => {
      const u = new URL(url)
      const status = u.searchParams.get('status')
      lastStatusParam = status
      if (status === 'archived') {
        return new Response(
          JSON.stringify({
            items: [mkMem({ id: 'mem_arc', status: 'archived' })],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap()
    await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    await screen.findByTestId('memory-all-mem_arc-unarchive')
    expect(lastStatusParam).toBe('archived')
    expect(screen.queryByTestId('memory-all-mem_arc-archive')).toBeNull()
  })

  test('Archive opens shared Dialog; Cancel closes it and DOES NOT POST', async () => {
    const calls = installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    // vitest 4 + happy-dom 20 no longer define window.confirm, so vi.spyOn
    // can't wrap it. Install our own fn to assert the component never calls it
    // (the shared Dialog path replaces window.confirm — also grep-locked below).
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    wrap()
    const btn = await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(btn)
    // Dialog rendered; the original window.confirm is NOT used.
    const dialog = await screen.findByTestId('memory-confirm-dialog')
    expect(dialog).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('memory-confirm-cancel'))
    await waitFor(() => {
      expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull()
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined()
  })

  test('Archive → Confirm POSTs /archive', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkMem({ status: 'archived' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap()
    const btn = await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(btn)
    await screen.findByTestId('memory-confirm-dialog')
    fireEvent.click(screen.getByTestId('memory-confirm-ok'))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_1/archive')
    })
    // Dialog closes after confirm.
    await waitFor(() => {
      expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull()
    })
  })

  test('Archive confirmation stays open and locked until fulfillment, then clears selection', async () => {
    let resolveArchive!: (response: Response) => void
    const archiveResponse = new Promise<Response>((resolve) => {
      resolveArchive = resolve
    })
    installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return archiveResponse
    })
    wrap()
    fireEvent.click(await screen.findByTestId('memory-row-mem_1-select'))
    expect(screen.getByTestId('memory-fuse-button')).toBeTruthy()

    fireEvent.click(screen.getByTestId('memory-all-mem_1-archive'))
    fireEvent.click(await screen.findByTestId('memory-confirm-ok'))
    await waitFor(() => {
      expect((screen.getByTestId('memory-confirm-ok') as HTMLButtonElement).disabled).toBe(true)
    })
    expect((screen.getByTestId('memory-confirm-cancel') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('memory-confirm-dialog')).toBeTruthy()

    await act(async () => {
      resolveArchive(
        new Response(JSON.stringify({ memory: mkMem({ status: 'archived' }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await archiveResponse
    })
    await waitFor(() => expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull())
    expect(screen.queryByTestId('memory-fuse-button')).toBeNull()
  })

  test('a submitted destructive target cannot be replaced by another row before settlement', async () => {
    let resolveArchive!: (response: Response) => void
    const archiveResponse = new Promise<Response>((resolve) => {
      resolveArchive = resolve
    })
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [mkMem({ id: 'mem_a' }), mkMem({ id: 'mem_b' })],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return archiveResponse
    })
    wrap()

    fireEvent.click(await screen.findByTestId('memory-all-mem_a-archive'))
    fireEvent.click(screen.getByTestId('memory-confirm-ok'))
    // Exercise the synchronous click-to-render gap as well as the rendered
    // disabled state. The ref lock must reject this attempted replacement.
    fireEvent.click(screen.getByTestId('memory-all-mem_b-delete'))
    await waitFor(() =>
      expect((screen.getByTestId('memory-all-mem_b-delete') as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
    await act(async () => {
      resolveArchive(
        new Response(JSON.stringify({ memory: mkMem({ id: 'mem_a', status: 'archived' }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await archiveResponse
    })

    await waitFor(() => expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull())
    expect(
      calls.filter((call) => call.method === 'POST' && call.url.includes('/mem_a/archive')),
    ).toHaveLength(1)
    expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/mem_b'))).toBe(
      false,
    )
    expect(await screen.findByTestId('memory-all-mem_b-delete')).toBeTruthy()
  })

  test('Archive failure stays in the dialog and Retry reuses the frozen target', async () => {
    let attempts = 0
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      attempts += 1
      if (attempts === 1) {
        return new Response(JSON.stringify({ code: 'archive-failed', message: 'archive failed' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkMem({ status: 'archived' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap()
    fireEvent.click(await screen.findByTestId('memory-all-mem_1-archive'))
    fireEvent.click(await screen.findByTestId('memory-confirm-ok'))

    const error = await screen.findByTestId('memory-confirm-error')
    expect(screen.getByTestId('memory-confirm-dialog')).toBeTruthy()
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(attempts).toBe(2))
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.includes('/api/memories/mem_1/archive'),
      ),
    ).toHaveLength(2)
    await waitFor(() => expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull())
  })

  test('Delete also routes through the shared Dialog, not window.confirm', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkMem()], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    // vitest 4 + happy-dom 20 no longer define window.confirm, so vi.spyOn
    // can't wrap it. Install our own fn to assert the component never calls it
    // (the shared Dialog path replaces window.confirm — also grep-locked below).
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    wrap()
    const btn = await screen.findByTestId('memory-all-mem_1-delete')
    fireEvent.click(btn)
    await screen.findByTestId('memory-confirm-dialog')
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('memory-confirm-ok'))
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE')
      expect(del?.url).toContain('/api/memories/mem_1')
      expect(del?.url).toContain('confirm=true')
    })
  })

  test('Unarchive click POSTs /unarchive without opening a Dialog', async () => {
    const calls = installFetch(({ method, url }) => {
      if (method === 'GET') {
        const u = new URL(url)
        if (u.searchParams.get('status') === 'archived') {
          return new Response(
            JSON.stringify({
              items: [mkMem({ id: 'mem_arc', status: 'archived' })],
              nextCursor: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkMem({ status: 'approved' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap()
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    const btn = await screen.findByTestId('memory-all-mem_arc-unarchive')
    fireEvent.click(btn)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_arc/unarchive')
    })
    expect(screen.queryByTestId('memory-confirm-dialog')).toBeNull()
  })

  test('Unarchive pending/error is target-scoped; failed row stays and retries that id', async () => {
    let resolveFirst!: (response: Response) => void
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    let attempts = 0
    const calls = installFetch(({ method, url }) => {
      if (method === 'GET') {
        const status = new URL(url).searchParams.get('status')
        return new Response(
          JSON.stringify({
            items:
              status === 'archived'
                ? [
                    mkMem({ id: 'mem_a', status: 'archived' }),
                    mkMem({ id: 'mem_b', status: 'archived' }),
                  ]
                : [],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      attempts += 1
      if (attempts === 1) return first
      return new Response(JSON.stringify({ memory: mkMem({ id: 'mem_a' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap()
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    const target = (await screen.findByTestId('memory-all-mem_a-unarchive')) as HTMLButtonElement
    const unrelated = screen.getByTestId('memory-all-mem_b-unarchive') as HTMLButtonElement
    fireEvent.click(target)
    await waitFor(() => expect(target.disabled).toBe(true))
    expect(unrelated.disabled).toBe(false)

    await act(async () => {
      resolveFirst(
        new Response(JSON.stringify({ code: 'restore-failed', message: 'restore failed' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      await first
    })
    const error = await screen.findByTestId('memory-unarchive-error-mem_a')
    expect(screen.getByTestId('memory-row-mem_a')).toBeTruthy()
    fireEvent.click(within(error).getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(attempts).toBe(2))
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.includes('/api/memories/mem_a/unarchive'),
      ),
    ).toHaveLength(2)
  })

  test('server canManage=false disables archive + unarchive across views', async () => {
    installFetch(({ url }) => {
      const u = new URL(url)
      if (u.searchParams.get('status') === 'archived') {
        return new Response(
          JSON.stringify({
            items: [mkMem({ id: 'mem_arc', status: 'archived', canManage: false })],
            nextCursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ items: [mkMem({ canManage: false })], nextCursor: null }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    wrap()
    const archiveBtn = (await screen.findByTestId('memory-all-mem_1-archive')) as HTMLButtonElement
    expect(archiveBtn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    const unarchiveBtn = (await screen.findByTestId(
      'memory-all-mem_arc-unarchive',
    )) as HTMLButtonElement
    expect(unarchiveBtn.disabled).toBe(true)
  })
})

describe('MemoryAllList source-level grep — no native window.confirm', () => {
  test('component file does not call window.confirm anywhere', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const body = readFileSync(
      path.resolve(here, '../src/components/memory/MemoryAllList.tsx'),
      'utf8',
    )
    // Native browser modal must be replaced by the shared <Dialog>.
    expect(body.includes('window.confirm')).toBe(false)
    expect(body.includes("from '@/components/Dialog'")).toBe(true)
    expect(/<Dialog[\s>]/.test(body)).toBe(true)
  })
})
