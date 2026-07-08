// RFC-151 PR-4 — /skills/$name dual-mutation save channels through the
// shared <DetailHeaderActions> shell (design-gate mandated scenarios).
//
// skills.detail is the hard boundary that shaped the shell's `errors:
// ReadonlyArray<unknown>` contract: Save fans out to TWO mutations (meta
// PUT + content PUT) whose failures must surface independently — a single
// save.error slot could not represent both channels. Scenarios locked:
//   1. meta save fails (content succeeds)   → meta error span renders.
//   2. content save fails (meta succeeds)   → content error span renders.
//   3. BOTH fail                            → two spans render side by side.
//   4. external skill                        → Save skips the content PUT
//      entirely (capability gate), only meta goes out on the wire.
//   5. managed, both succeed                 → navigate fires exactly ONCE.
//
// Impl-gate regression (scenarios 1-3 + 5): navigation must be a whole-save
// outcome. Per-channel navigate-on-success let the first fulfilled PUT unmount
// the page and mask the sibling's failure (the mocked navigate hid the unmount
// here, so these tests also assert `h.navigate` is NEVER called while any
// channel failed — the JSDOM-faithful proxy for "the page stays mounted").

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: {} as Record<string, string>,
}))
vi.mock('@tanstack/react-router', () => ({
  createRoute: (o: unknown) => ({
    ...(o as Record<string, unknown>),
    useParams: () => h.params,
  }),
  useNavigate: () => h.navigate,
}))
vi.mock('../src/routes/__root', () => ({ Route: {} }))

// Imported AFTER the mocks so createRoute/useNavigate resolve to the stubs.
import { Route as SkillDetailRoute } from '../src/routes/skills.detail'

interface FetchCall {
  url: string
  method: string
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function skillRow(sourceKind: 'managed' | 'external') {
  return {
    id: 'sk1',
    name: 'sk1',
    description: 'orig desc',
    sourceKind,
    managedPath: sourceKind === 'managed' ? '/managed/sk1' : null,
    externalPath: sourceKind === 'external' ? '/ext/sk1' : null,
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Routes the skill detail page's whole fetch surface; `putMeta` / `putContent`
 *  control the two save channels' responses. */
function installFetch(opts: {
  sourceKind: 'managed' | 'external'
  putMeta: Response | (() => Response)
  putContent: Response | (() => Response)
}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method })
      if (method === 'PUT' && url.endsWith('/api/skills/sk1/content')) {
        return typeof opts.putContent === 'function' ? opts.putContent() : opts.putContent.clone()
      }
      if (method === 'PUT' && url.endsWith('/api/skills/sk1')) {
        return typeof opts.putMeta === 'function' ? opts.putMeta() : opts.putMeta.clone()
      }
      if (method === 'GET' && url.endsWith('/api/skills/sk1'))
        return json(skillRow(opts.sourceKind))
      if (method === 'GET' && url.endsWith('/api/skills/sk1/content'))
        return json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 1 })
      if (method === 'GET' && url.endsWith('/api/skills/sk1/files')) return json([])
      if (method === 'GET' && url.endsWith('/api/skills/sk1/versions')) return json([])
      return new Response('not found', { status: 404 })
    },
  )
  return calls
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Comp = (SkillDetailRoute as unknown as { component: ComponentType }).component
  return render(
    <QueryClientProvider client={qc}>
      <Comp />
    </QueryClientProvider>,
  )
}

/** Waits for the hydrate-once seed, then clicks the header Save button. */
async function clickSave() {
  const save = (await waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>('.page__actions .btn--primary')
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)
    return btn!
  })) as HTMLButtonElement
  fireEvent.click(save)
}

function errorSpans(): string[] {
  return [...document.querySelectorAll('.form-actions__error')].map((s) => s.textContent ?? '')
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  h.navigate.mockReset()
  h.params = { name: 'sk1' }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('skills.detail save channels (DetailHeaderActions errors array)', () => {
  test('meta save failure surfaces its own form-actions error', async () => {
    installFetch({
      sourceKind: 'managed',
      putMeta: () => json({ code: 'skill-meta-boom', message: 'meta went boom' }, 422),
      putContent: () => json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 2 }),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const spans = errorSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0]).toContain('meta went boom')
    })
    // The succeeding content channel must NOT navigate away from the failure.
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('content save failure surfaces its own form-actions error', async () => {
    installFetch({
      sourceKind: 'managed',
      putMeta: () => json(skillRow('managed')),
      putContent: () => json({ code: 'skill-content-boom', message: 'content went boom' }, 422),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const spans = errorSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0]).toContain('content went boom')
    })
    // The succeeding meta channel must NOT navigate away from the failure.
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('double failure renders BOTH channel errors side by side', async () => {
    // The reason `errors` is an array: one slot per channel, none masked.
    installFetch({
      sourceKind: 'managed',
      putMeta: () => json({ code: 'skill-meta-boom', message: 'meta went boom' }, 422),
      putContent: () => json({ code: 'skill-content-boom', message: 'content went boom' }, 422),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const spans = errorSpans()
      expect(spans).toHaveLength(2)
      expect(spans[0]).toContain('meta went boom')
      expect(spans[1]).toContain('content went boom')
    })
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('external skill: Save PUTs meta only — the content channel is skipped', async () => {
    const calls = installFetch({
      sourceKind: 'external',
      putMeta: () => json(skillRow('external')),
      putContent: () => json({ code: 'unexpected', message: 'must not be called' }, 500),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const puts = calls.filter((c) => c.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]!.url.endsWith('/api/skills/sk1')).toBe(true)
    })
    // Successful meta save navigates back to the list; no error spans.
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
    expect(errorSpans()).toHaveLength(0)
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/content'))).toBe(false)
  })

  test('managed, both channels succeed: navigate fires exactly once (coordinated, not per-channel)', async () => {
    installFetch({
      sourceKind: 'managed',
      putMeta: () => json(skillRow('managed')),
      putContent: () => json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 2 }),
    })
    renderDetail()
    await clickSave()
    // Pre-fix shape navigated once per fulfilled channel (twice here).
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
    expect(errorSpans()).toHaveLength(0)
  })
})
