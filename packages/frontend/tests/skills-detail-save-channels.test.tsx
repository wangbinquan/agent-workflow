// RFC-170 T-BSAFE③ — /skills/$name saves through the SINGLE combined-save funnel
// (POST /api/skills/:name/save under composite-token OCC). The old double-PUT
// metadata/content writers (`PUT /api/skills/:name` + `.../content`) are retired
// → 410 Gone. This file — originally RFC-151 PR-4's dual-channel lock — now locks
// the single-funnel contract while preserving the <DetailHeaderActions> shell's
// `errors: ReadonlyArray<unknown>` intent (the array still carries combinedSave.error
// + del.error; save never navigates — it reseeds in place, the RFC-169 D2 flip).
// RFC-178: skills are managed-only, so every skill rides the same funnel:
//   1. managed + token       → ONE POST /save {description, bodyMd, expectedToken}, zero PUTs.
//   2. managed + token       → a save failure surfaces via the errors array, no navigate.
//   3. managed + token       → a 409 conflict surfaces AND refetches a fresh token.
//   4. managed, save succeeds → stays in place (no navigate), commitSaved reseeds.
//   5. description field stays editable (managed metadata authority).
//
// The FE must NEVER call the retired PUTs; installFetch answers them with the real
// 410 and every save scenario asserts `calls` contains zero such PUTs.

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
import { SplitDirtyContext } from '../src/components/split/splitDirty'

interface FetchCall {
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

function skillRow() {
  return {
    id: 'sk1',
    name: 'sk1',
    description: 'orig desc',
    sourceKind: 'managed',
    managedPath: '/managed/sk1',
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Routes the skill detail page's whole fetch surface. `postSave` drives the
 *  single combined-save channel's response; `token` (when set) is echoed on the
 *  content GET so the page routes Save through POST /save under token OCC. The
 *  retired PUT writers answer 410 — no scenario should ever hit them. */
function installFetch(opts: {
  token?: string
  postSave?: Response | (() => Response)
  // RFC-170 T-BSAFE③: lets a test make the fenced content read's description differ
  // from the metadata query's, to prove the draft seeds from content (authority).
  contentDescription?: string
}): FetchCall[] {
  const calls: FetchCall[] = []
  let contentGets = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined })
      if (method === 'POST' && url.endsWith('/api/skills/sk1/save')) {
        return typeof opts.postSave === 'function'
          ? opts.postSave()
          : (
              opts.postSave ??
              json({
                name: 'sk1',
                bodyMd: 'orig body',
                contentVersion: 2,
                token: opts.token === undefined ? undefined : `${opts.token}#saved`,
              })
            ).clone()
      }
      // RFC-170 T-BSAFE③: the old metadata/content PUTs are 410 Gone. The FE must
      // never call them; this realistic 410 + each test's "zero PUT" assertion catch it.
      if (
        method === 'PUT' &&
        (url.endsWith('/api/skills/sk1') || url.endsWith('/api/skills/sk1/content'))
      ) {
        return json({ code: 'skill-endpoint-gone', message: 'retired; use POST /save' }, 410)
      }
      if (method === 'GET' && url.endsWith('/api/skills/sk1')) return json(skillRow())
      if (method === 'GET' && url.endsWith('/api/skills/sk1/content')) {
        contentGets += 1
        // A refetch after a 409 hands back a bumped token so the next save is fresh.
        const token = opts.token === undefined ? undefined : `${opts.token}#${contentGets}`
        // RFC-170 T-BSAFE③: the draft seeds description from THIS fenced read
        // (SKILL.md authority), so the content response carries it alongside body+token.
        return json({
          name: 'sk1',
          description: opts.contentDescription ?? 'orig desc',
          bodyMd: 'orig body',
          contentVersion: 1,
          token,
        })
      }
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
  // RFC-169: skills.detail is now a child of the split page — provide the
  // SplitDirty context so useReportSplitDirty resolves.
  return render(
    <QueryClientProvider client={qc}>
      <SplitDirtyContext.Provider value={{ dirtyKey: null, report: () => {} }}>
        <Comp />
      </SplitDirtyContext.Provider>
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

function noRetiredPuts(calls: FetchCall[]): boolean {
  return !calls.some(
    (c) =>
      c.method === 'PUT' &&
      (c.url.endsWith('/api/skills/sk1') || c.url.endsWith('/api/skills/sk1/content')),
  )
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

// RFC-170 T4/T-BSAFE③ — a managed skill's content GET carries a composite
// precondition token; Save is ONE atomic POST /save (token OCC), never a PUT.
describe('skills.detail combined-save (managed + token)', () => {
  test('managed + token: Save is a single POST /save carrying {description, bodyMd, token}; zero PUTs', async () => {
    const calls = installFetch({
      token: 'TOK1',
      postSave: () => json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 2, token: 'TOK2' }),
    })
    renderDetail()
    await clickSave()
    // Exactly one POST /save carrying the token + BOTH fields; zero retired PUTs.
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/save'))
      expect(posts).toHaveLength(1)
      const sent = JSON.parse(posts[0]!.body ?? '{}') as Record<string, unknown>
      expect(sent.expectedToken).toBe('TOK1#1') // the token from the content GET
      expect(sent).toHaveProperty('description')
      expect(sent).toHaveProperty('bodyMd')
    })
    expect(noRetiredPuts(calls)).toBe(true)
    // Stays in place, reseeds, no error.
    await waitFor(() => expect(errorSpans()).toHaveLength(0))
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('managed + token: a save failure surfaces via the errors array; no navigate', async () => {
    installFetch({
      token: 'TOK1',
      postSave: () => json({ code: 'skill-save-boom', message: 'save went boom' }, 422),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const spans = errorSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0]).toContain('save went boom')
    })
    // A failed save must NOT navigate away — the page stays mounted (D2 flip).
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('managed + token: a 409 token conflict surfaces the error and refetches a fresh token', async () => {
    const calls = installFetch({
      token: 'STALE',
      postSave: () =>
        json({ code: 'skill-version-conflict', message: 'token stale — reload' }, 409),
    })
    renderDetail()
    // First content GET (seed) uses token STALE#1.
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/content'))).toBe(true))
    const contentGetsBefore = calls.filter(
      (c) => c.method === 'GET' && c.url.endsWith('/content'),
    ).length
    await clickSave()
    // The 409 surfaces via the combinedSave error slot...
    await waitFor(() => {
      const spans = errorSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0]).toContain('token stale — reload')
    })
    // ...and onError invalidated the content query → a fresh GET (new token) fired.
    await waitFor(() => {
      const contentGetsAfter = calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/content'),
      ).length
      expect(contentGetsAfter).toBeGreaterThan(contentGetsBefore)
    })
    expect(h.navigate).not.toHaveBeenCalled()
  })

  // RFC-170 T-BSAFE③ (Codex F2-review): the metadata query and the fenced content
  // read can disagree (a concurrent edit advanced SKILL.md). The draft must seed
  // description from CONTENT (authority + same token), so a save can never ship the
  // stale metadata description under a fresh token and silently roll back the edit.
  test('managed + token: Save ships the description from the fenced content read, not the stale metadata query', async () => {
    const calls = installFetch({
      token: 'TOK1',
      contentDescription: 'CONTENT-FRESH', // metadata GET still returns skillRow "orig desc"
      postSave: () => json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 2, token: 'TOK2' }),
    })
    renderDetail()
    await clickSave()
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/save'))
      expect(posts).toHaveLength(1)
      const sent = JSON.parse(posts[0]!.body ?? '{}') as Record<string, unknown>
      expect(sent.description).toBe('CONTENT-FRESH')
      expect(sent.description).not.toBe('orig desc')
    })
    expect(noRetiredPuts(calls)).toBe(true)
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test('managed: save succeeds → stays in place (no navigate), commitSaved reseeds', async () => {
    const calls = installFetch({
      token: 'TOK1',
      postSave: () => json({ name: 'sk1', bodyMd: 'orig body', contentVersion: 2, token: 'TOK2' }),
    })
    renderDetail()
    await clickSave()
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/save'))).toHaveLength(1),
    )
    await waitFor(() => expect(errorSpans()).toHaveLength(0))
    expect(noRetiredPuts(calls)).toBe(true)
    expect(h.navigate).not.toHaveBeenCalled()
  })
})

// RFC-178 — skills are managed-only, so the description field always follows the
// managed metadata authority (editable).
describe('skills.detail description gate', () => {
  function descInput(): HTMLInputElement {
    return document.querySelector('[data-testid="skill-description-input"]') as HTMLInputElement
  }

  test('managed → description input is editable', async () => {
    installFetch({})
    renderDetail()
    await waitFor(() => expect(descInput()).not.toBeNull())
    expect(descInput().disabled).toBe(false)
  })
})
