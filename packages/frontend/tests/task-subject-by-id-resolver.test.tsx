// RFC-177 — the by-id subject resolver (frontend half).
//
// `useResolveResourceName(kind, id)` calls the ACL-gated `GET /api/{kind}/by-id/:id`
// endpoint and surfaces {name | isError}. The two redirect routes
// (workgroups.by-id / agents.by-id) consume it and <Navigate replace> to the
// resource's CURRENT canonical page, or show an EmptyState when the id is
// missing/invisible (404). The hook is covered behaviorally (mock fetch); the
// thin redirect glue is source-locked (its route component uses Route.useParams,
// awkward to mount standalone) — the backend endpoint + navigation targets are
// locked in resource-by-id-resolve.test.ts + task-subject-link.test.tsx.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setBaseUrl, setToken } from '../src/stores/auth'
import {
  useResolveResourceName,
  type ResolvableResourceKind,
} from '../src/hooks/useResolveResourceName'

function Probe({ kind, id }: { kind: ResolvableResourceKind; id: string }) {
  const { name, isLoading, isError } = useResolveResourceName(kind, id)
  if (isLoading) return <p>loading…</p>
  if (isError) return <p data-testid="err">error</p>
  return <p data-testid="name">{name}</p>
}

function mount(kind: ResolvableResourceKind, id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Probe kind={kind} id={id} />
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
})

describe('useResolveResourceName', () => {
  test('resolves the current name from GET /api/{kind}/by-id/:id', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input.toString())
      return new Response(JSON.stringify({ name: 'current-name' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    mount('workgroups', 'g1')
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('current-name'))
    expect(calls.some((u) => u.endsWith('/api/workgroups/by-id/g1'))).toBe(true)
  })

  test('a 404 (missing/invisible) surfaces as isError without retry-spin', async () => {
    let n = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1
      return new Response('not found', { status: 404 })
    })
    mount('agents', 'nope')
    await waitFor(() => expect(screen.getByTestId('err')).toBeTruthy())
    // retry: false → exactly one fetch (no spin on a legitimate 404).
    expect(n).toBe(1)
  })
})

describe('by-id redirect routes wire the resolver to a typed Navigate', () => {
  const wg = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'workgroups.by-id.tsx'),
    'utf-8',
  )
  const ag = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'agents.by-id.tsx'),
    'utf-8',
  )

  test('workgroup route resolves then redirects to /workgroups/$name (replace) + EmptyState on error', () => {
    expect(wg).toContain("useResolveResourceName('workgroups'")
    expect(wg).toContain("to: '/workgroups/$name'")
    expect(wg).toContain('replace: true')
    expect(wg).toContain('EmptyState')
  })

  test('agent route resolves then redirects to /agents/$name (replace) + EmptyState on error', () => {
    expect(ag).toContain("useResolveResourceName('agents'")
    expect(ag).toContain("to: '/agents/$name'")
    expect(ag).toContain('replace: true')
    expect(ag).toContain('EmptyState')
  })
})
