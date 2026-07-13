// RFC-170 F3 (G2-7) — SkillFileTree shares the skill's SINGLE canonical precondition
// token (the detail content query cache is the authority). A file write echoes the
// current token (OCC) and atomically advances the cache token from the response, so
// a save that landed between a file edit and its write is 409'd server-side, not
// silently clobbered; a 409 refetches the content query to reload a fresh token.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { SkillFileTree } from '../src/components/SkillFileTree'
import '../src/i18n'

interface Call {
  url: string
  method: string
  body?: string
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function seededClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The SINGLE canonical token lives on the detail content query cache.
  qc.setQueryData(['skills', 'sk1', 'content'], {
    name: 'sk1',
    description: 'd',
    bodyMd: 'b',
    frontmatterExtra: {},
    token: 'TOK1',
  })
  return qc
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SkillFileTree canonical token store (RFC-170 F3)', () => {
  test('a file add echoes the canonical token and advances it from the response', async () => {
    const calls: Call[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
        if (method === 'GET' && url.includes('/files')) return json([])
        if (method === 'PUT' && url.includes('/file?path='))
          return json({ ok: true, path: 'a.txt', token: 'TOK2' })
        return new Response('nf', { status: 404 })
      },
    )
    const qc = seededClient()
    render(
      <QueryClientProvider client={qc}>
        <SkillFileTree skillName="sk1" />
      </QueryClientProvider>,
    )

    const addInput = (await waitFor(() => screen.getByPlaceholderText(/path/i))) as HTMLInputElement
    fireEvent.change(addInput, { target: { value: 'a.txt' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))

    // The PUT carried the CURRENT canonical token...
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/file?path='))
      expect(put).toBeDefined()
      expect(JSON.parse(put!.body ?? '{}').expectedToken).toBe('TOK1')
    })
    // ...and the canonical token advanced to the response's fresh token.
    await waitFor(() => {
      expect((qc.getQueryData(['skills', 'sk1', 'content']) as { token?: string }).token).toBe(
        'TOK2',
      )
    })
  })

  test('a 409 on a file write invalidates the canonical content query (reload a fresh token)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/files')) return json([])
        // A concurrent save advanced the version — the file write's token is stale.
        if (method === 'PUT' && url.includes('/file?path='))
          return json({ code: 'skill-version-conflict', message: 'stale' }, 409)
        return new Response('nf', { status: 404 })
      },
    )
    const qc = seededClient()
    render(
      <QueryClientProvider client={qc}>
        <SkillFileTree skillName="sk1" />
      </QueryClientProvider>,
    )
    const addInput = (await waitFor(() => screen.getByPlaceholderText(/path/i))) as HTMLInputElement
    fireEvent.change(addInput, { target: { value: 'a.txt' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))

    // The 409's onError invalidated the canonical content query — in the mounted
    // detail page that query is observed, so this marks it stale → refetch (fresh
    // token). Here (isolated) we assert the invalidation flag flipped.
    await waitFor(() => {
      expect(qc.getQueryState(['skills', 'sk1', 'content'])?.isInvalidated).toBe(true)
    })
  })
})
