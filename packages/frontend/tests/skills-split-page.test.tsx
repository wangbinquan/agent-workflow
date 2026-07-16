// RFC-169 (T14) — the /skills split page end-to-end (real routes + mocked API):
//   - /skills empty pane hosts the guidance (RFC-178: managed-only);
//   - selecting a managed skill opens the task-oriented detail tabs;
//   - editing marks it dirty; Save stays in place (D2) and clears the dot;
//   - the file tree refuses to add the protected SKILL.md main file (guard).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function installFetch(
  opts: {
    saveGate?: Promise<void>
    ambiguousSave?: boolean
    failContentAfterSave?: boolean
    restoreGate?: Promise<void>
    withRestorableVersion?: boolean
  } = {},
) {
  let saveAttempted = false
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
        if (method === 'GET') {
          if (saveAttempted && opts.failContentAfterSave) {
            return json({ code: 'snapshot-unavailable', message: 'snapshot unavailable' }, 500)
          }
          return json({
            name,
            description: skills.find((x) => x.name === name)?.description ?? '',
            bodyMd: bodyByName[name] ?? '',
            contentVersion: 1,
            token: `t-${name}`,
          })
        }
      }
      // RFC-170 T-BSAFE③: combined-save is the single save funnel (the old
      // metadata/content PUTs are 410 Gone). Apply the description + body patch.
      const saveMatch = path.match(/^\/api\/skills\/([^/]+)\/save$/)
      if (saveMatch && method === 'POST') {
        await opts.saveGate
        saveAttempted = true
        if (opts.ambiguousSave) throw new TypeError('response lost')
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
      if (/\/api\/skills\/[^/]+\/versions$/.test(path)) {
        return json(
          opts.withRestorableVersion
            ? [
                {
                  id: 'sk1-v0',
                  skillName: 'sk1',
                  versionIndex: 0,
                  source: 'editor',
                  summary: 'Earlier version',
                  fusionId: null,
                  restoredFromVersion: null,
                  authorUserId: null,
                  contentHash: 'hash-v0',
                  createdAt: 1,
                },
              ]
            : [],
        )
      }
      if (/\/api\/skills\/[^/]+\/versions\/\d+\/restore$/.test(path) && method === 'POST') {
        await opts.restoreGate
        return json({ ok: true })
      }
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
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(screen.queryByTestId('skills-mobile-back')).toBeNull()
    expect(screen.getAllByRole('link', { name: '+ New skill' })).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('list')
    // The empty pane renders the guidance EmptyState in the detail column.
    await waitFor(() => expect(screen.getByTestId('split-detail').textContent).not.toBe(''))
  })

  test('selecting a managed skill opens the three task-oriented tabs', async () => {
    renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    for (const [key, name] of [
      ['edit', 'Edit'],
      ['files', 'Files'],
      ['history', 'History'],
    ] as const) {
      const tab = screen.getByRole('tab', { name })
      const panel = screen.getByTestId(`skill-panel-${key}`)
      expect(tab.id).toBe(`skills-detail-tab-${key}`)
      expect(tab.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.id).toBe(`skills-detail-panel-${key}`)
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    expect(screen.getByTestId('skills-mobile-back').getAttribute('href')).toBe('/skills')
    expect(screen.getAllByTestId('skills-mobile-back')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
  })

  test('edit description → dirty dot; Save stays in place and clears it', async () => {
    const router = renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    const desc = screen.getByRole('textbox', { name: /Description/ }) as HTMLInputElement
    fireEvent.change(desc, { target: { value: 'edited skill desc' } })
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-sk1')).not.toBeNull())
    expect(screen.getByRole('tab', { name: /Edit.*unsaved/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /History.*Save or discard/i })).toBeTruthy()
    fireEvent.click(screen.getByTestId('skill-save-button'))
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-sk1')).toBeNull())
    expect(router.state.location.pathname).toBe('/skills/sk1')
  })

  test('Save All holds the route busy guard until the write and reconciliation settle', async () => {
    vi.restoreAllMocks()
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    installFetch({ saveGate })
    const router = renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'pending skill save' },
    })

    fireEvent.click(screen.getByTestId('skill-save-button'))
    fireEvent.click(screen.getByTestId('skills-mobile-back'))

    const dialog = await screen.findByTestId('unsaved-guard-dialog')
    expect(dialog.textContent).toMatch(/save is still in progress/i)
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/skills/sk1')

    releaseSave()
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/skills/sk1')
    fireEvent.click(screen.getByTestId('skills-mobile-back'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills'))
  })

  test('outcome-unknown keeps the busy guard armed and never exposes Discard', async () => {
    vi.restoreAllMocks()
    installFetch({ ambiguousSave: true, failContentAfterSave: true })
    const router = renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'unknown outcome' },
    })
    fireEvent.click(screen.getByTestId('skill-save-button'))

    await screen.findByText(/save result unknown/i)
    fireEvent.click(screen.getByTestId('skills-mobile-back'))

    const dialog = await screen.findByTestId('unsaved-guard-dialog')
    expect(dialog.textContent).toMatch(/save is still in progress/i)
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/skills/sk1')
  })

  test('restore acquires busy synchronously before POST so same-tick Back has no Discard', async () => {
    vi.restoreAllMocks()
    let releaseRestore!: () => void
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    installFetch({ restoreGate, withRestorableVersion: true })
    const router = renderSkills('/skills/sk1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'sk1' }))
    fireEvent.click(screen.getByRole('tab', { name: /^History$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^Restore$/i }))
    const confirm = screen.getByRole('button', { name: /Restore the skill to v0/i })
    const back = screen.getByTestId('skills-mobile-back')

    act(() => {
      confirm.click()
      back.click()
    })

    const dialog = await screen.findByTestId('unsaved-guard-dialog')
    expect(dialog.textContent).toMatch(/save is still in progress/i)
    expect(screen.queryByTestId('unsaved-discard')).toBeNull()
    expect(router.state.location.pathname).toBe('/skills/sk1')

    releaseRestore()
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
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
      expect(screen.getByText(/SKILL\.md is edited in the Edit tab/)).toBeTruthy(),
    )
  })

  test('the new view offers the managed + ZIP creation modes', async () => {
    renderSkills('/skills/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New skill/ }))
    const managedTab = screen.getByRole('tab', { name: 'Manual creation' })
    expect(managedTab.id).toBe('skills-new-tab-managed')
    expect(managedTab.getAttribute('aria-controls')).toBe('skills-new-panel-managed')
    expect(
      document.getElementById('skills-new-panel-managed')?.getAttribute('aria-labelledby'),
    ).toBe('skills-new-tab-managed')
    const sharedBack = screen.getByTestId('skills-mobile-back')
    expect(sharedBack.getAttribute('href')).toBe('/skills')
    expect(screen.getAllByTestId('skills-mobile-back')).toHaveLength(1)
    expect(
      screen
        .getByTestId('split-detail')
        .querySelectorAll('a.split__mobile-back, a.skill-import__mobile-back'),
    ).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
    fireEvent.click(screen.getByTestId('skills-tab-zip'))
    expect(screen.getByRole('heading', { level: 2, name: 'Import skills' })).toBeTruthy()
    const zipTab = screen.getByRole('tab', { name: 'Import ZIP' })
    expect(zipTab.id).toBe('skills-new-tab-zip')
    expect(zipTab.getAttribute('aria-controls')).toBe('skills-new-panel-zip')
    expect(document.getElementById('skills-new-panel-zip')?.getAttribute('aria-labelledby')).toBe(
      'skills-new-tab-zip',
    )
    expect(screen.getByText(/Structure and name conflicts/)).toBeTruthy()
    expect(screen.queryByTestId('skill-create-button')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Manual creation' }))
    expect(screen.getByRole('heading', { level: 2, name: 'New skill' })).toBeTruthy()
    expect(screen.getByTestId('skill-create-button')).toBeTruthy()
  })

  test('a selected ZIP participates in the route guard and Discard clears it', async () => {
    const router = renderSkills('/skills/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New skill/ }))
    fireEvent.click(screen.getByTestId('skills-tab-zip'))
    fireEvent.change(screen.getByTestId('zip-file-input'), {
      target: {
        files: [new File(['zip'], 'staged.zip', { type: 'application/zip' })],
      },
    })
    expect(screen.getByText('staged.zip')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Import ZIP.*unsaved/i })).toBeTruthy()

    fireEvent.click(screen.getByTestId('skills-mobile-back'))
    expect(await screen.findByTestId('unsaved-guard-dialog')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/skills/new')

    fireEvent.click(screen.getByTestId('unsaved-discard'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills'))
  })

  test('manual progress stays announced after switching creation modes', async () => {
    renderSkills('/skills/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New skill/ }))

    const name = screen.getAllByRole('textbox')[0] as HTMLInputElement
    fireEvent.change(name, { target: { value: 'draft-skill' } })
    expect(screen.getByRole('tab', { name: /Manual creation.*unsaved/i })).toBeTruthy()

    fireEvent.click(screen.getByTestId('skills-tab-zip'))
    expect(screen.getByRole('tab', { name: /Manual creation.*unsaved/i })).toBeTruthy()
  })
})
