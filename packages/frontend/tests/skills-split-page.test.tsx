// RFC-169 (T14) — the /skills split page end-to-end (real routes + mocked API):
//   - /skills empty pane hosts the guidance (RFC-178: managed-only);
//   - selecting a managed skill opens the four-tab detail;
//   - editing marks it dirty; Save stays in place (D2) and clears the dot;
//   - the file tree refuses to add the protected SKILL.md main file (guard).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as skillsIndexRoute, Route as skillsRoute } from '../src/routes/skills'
import { Route as skillDetailRoute } from '../src/routes/skills.detail'
import { Route as skillNewRoute } from '../src/routes/skills.new'
import '../src/i18n'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface SkillRow {
  id: string
  name: string
  description: string
  sourceKind: 'managed'
  managedPath: string | null
  schemaVersion: number
  contentVersion: number
  createdAt: number
  updatedAt: number
  visibility: 'public' | 'private'
  ownerUserId: string | null
}

let skills: SkillRow[]
let bodyByName: Record<string, string>

function makeSkill(name: string, description = ''): SkillRow {
  return {
    id: name,
    name,
    description,
    sourceKind: 'managed',
    managedPath: `/managed/${name}`,
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    visibility: 'public',
    ownerUserId: null,
  }
}

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!

      if (method === 'GET' && path === '/api/skills') return json(skills)
      if (method === 'POST' && path === '/api/users/lookup') return json([])
      const detailMatch = path.match(/^\/api\/skills\/([^/]+)$/)
      if (detailMatch) {
        const name = decodeURIComponent(detailMatch[1]!)
        const s = skills.find((x) => x.name === name)
        if (method === 'GET') return s ? json(s) : json({ error: 'nf' }, 404)
        if (method === 'PUT') {
          const i = skills.findIndex((x) => x.name === name)
          skills[i] = { ...skills[i]!, ...(body as object) }
          return json(skills[i])
        }
      }
      const contentMatch = path.match(/^\/api\/skills\/([^/]+)\/content$/)
      if (contentMatch) {
        const name = decodeURIComponent(contentMatch[1]!)
        // RFC-170 T-BSAFE③: the content read is the single fenced snapshot — it
        // carries the authoritative description + body + composite token, and Save
        // routes through the combined-save funnel below.
        if (method === 'GET')
          return json({
            name,
            description: skills.find((x) => x.name === name)?.description ?? '',
            bodyMd: bodyByName[name] ?? '',
            contentVersion: 1,
            token: `t-${name}`,
          })
      }
      // RFC-170 T-BSAFE③: combined-save is the single save funnel (the old
      // metadata/content PUTs are 410 Gone). Apply the description + body patch.
      const saveMatch = path.match(/^\/api\/skills\/([^/]+)\/save$/)
      if (saveMatch && method === 'POST') {
        const name = decodeURIComponent(saveMatch[1]!)
        const i = skills.findIndex((x) => x.name === name)
        const patch = (body ?? {}) as { description?: string; bodyMd?: string }
        if (i >= 0 && patch.description !== undefined)
          skills[i] = { ...skills[i]!, description: patch.description }
        if (patch.bodyMd !== undefined) bodyByName[name] = patch.bodyMd
        return json({
          name,
          bodyMd: bodyByName[name] ?? '',
          contentVersion: 2,
          token: `t-${name}-2`,
        })
      }
      if (/\/api\/skills\/[^/]+\/files$/.test(path))
        return json([{ path: 'SKILL.md', type: 'file' }])
      if (/\/api\/skills\/[^/]+\/versions$/.test(path)) return json([])
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderSkills(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = RootRoute.addChildren([
    skillsRoute.addChildren([skillNewRoute, skillDetailRoute, skillsIndexRoute]),
  ])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  skills = [makeSkill('sk1', 'first skill')]
  bodyByName = { sk1: 'orig body' }
  installFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('/skills split page', () => {
  test('empty pane hosts the guidance', async () => {
    renderSkills('/skills')
    const card = await waitFor(() => screen.getByTestId('split-card-sk1'))
    expect(card.querySelector('[data-icon="skill"]')).not.toBeNull()
    expect(card.textContent).toContain('Skill')
    expect(card.textContent).toContain('Content v1')
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'Content v1' } })
    expect(screen.getByTestId('split-card-sk1')).toBeTruthy()
    expect(screen.getByText('Nothing selected')).toBeTruthy()
    // The empty pane renders the guidance EmptyState in the detail column.
    await waitFor(() => expect(screen.getByTestId('split-detail').textContent).not.toBe(''))
  })

  test('selecting a managed skill opens the four-tab detail', async () => {
    renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    for (const tab of ['Overview', 'Content', 'Files', 'History']) {
      expect(screen.getByRole('tab', { name: tab })).toBeTruthy()
    }
  })

  test('edit description → dirty dot; Save stays in place and clears it', async () => {
    const router = renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    const desc = screen.getByRole('textbox', { name: /Description/ }) as HTMLInputElement
    fireEvent.change(desc, { target: { value: 'edited skill desc' } })
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-sk1')).not.toBeNull())
    fireEvent.click(screen.getByTestId('skill-save-button'))
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-sk1')).toBeNull())
    expect(router.state.location.pathname).toBe('/skills/sk1')
  })

  test('file tree refuses to add the protected SKILL.md main file', async () => {
    renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    const addInput = await waitFor(() => screen.getByPlaceholderText(/path/i) as HTMLInputElement)
    fireEvent.change(addInput, { target: { value: './SKILL.md' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    // Frontend guard blocks it with an error, no PUT attempted.
    await waitFor(() =>
      expect(screen.getByText(/SKILL\.md is edited in the Content tab/)).toBeTruthy(),
    )
  })

  test('the new view offers the managed + ZIP creation modes', async () => {
    renderSkills('/skills/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New skill/ }))
    expect(screen.getByRole('tab', { name: 'Managed' })).toBeTruthy()
    expect(screen.getByTestId('skills-tab-zip')).toBeTruthy()
  })
})
