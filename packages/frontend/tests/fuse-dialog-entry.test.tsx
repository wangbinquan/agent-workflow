// RFC-151 PR-1 — FuseDialog entry discriminated union, two-state render lock.
//
// The dialog's two entry points used to be encoded as a PAIR of optional
// props (lockedSkillName? / presetMemoryIds?) whose undefined-ness implied
// the mode — nothing stopped a caller passing both or neither. `entry` is now
// an explicit union:
//   {kind:'from-skill', skillId, skillName} → /skills/$name: skill locked, pick memories
//   {kind:'from-memories', memoryIds} → /memory: memories preset, pick the skill
// Locks each mode's render: which picker Field shows, which is replaced by
// the preset summary, and that every launch payload carries the canonical skill id.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const h = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}))

import { FuseDialog, type FuseDialogEntry } from '../src/components/fusion/FuseDialog'

interface FetchCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        body = JSON.parse(init.body) as Record<string, unknown>
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function mount(entry: FuseDialogEntry) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FuseDialog open onClose={() => {}} entry={entry} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  h.navigate.mockReset()
})

afterEach(() => {
  // React 19 + happy-dom + createPortal: never manually wipe document.body —
  // let testing-library unmount so the Dialog portal detaches itself.
  cleanup()
  vi.restoreAllMocks()
})

describe('FuseDialog entry union — two-state render', () => {
  test('from-skill: memory picker shown, target-skill Field absent', async () => {
    const calls = installFetch((c) => {
      if (c.url.includes('/api/memories')) {
        return json({
          items: [
            { id: 'mem_1', scopeType: 'global', scopeId: null, title: 'Prefer A', canManage: true },
          ],
        })
      }
      return json([])
    })
    mount({ kind: 'from-skill', skillId: 'skill_1', skillName: 'my-skill' })
    await waitFor(() => expect(screen.getByTestId('fusion-memory-picker')).toBeTruthy())
    // The target skill is locked → no skill Field, and no /api/skills query.
    expect(screen.queryByText('Target skill')).toBeNull()
    expect(calls.some((c) => c.url.includes('/api/skills'))).toBe(false)
  })

  test('from-skill: picker includes only explicit canManage=true rows', async () => {
    installFetch((c) => {
      if (c.url.includes('/api/memories')) {
        return json({
          items: [
            {
              id: 'allowed',
              scopeType: 'global',
              scopeId: null,
              title: 'Allowed',
              canManage: true,
            },
            { id: 'denied', scopeType: 'global', scopeId: null, title: 'Denied', canManage: false },
            { id: 'legacy', scopeType: 'global', scopeId: null, title: 'Legacy missing bit' },
          ],
        })
      }
      return json([])
    })
    mount({ kind: 'from-skill', skillId: 'skill_1', skillName: 'my-skill' })
    expect(await screen.findByText('Allowed')).toBeTruthy()
    expect(screen.queryByText('Denied')).toBeNull()
    expect(screen.queryByText('Legacy missing bit')).toBeNull()
  })

  test('from-skill: locked canonical skill id is what gets submitted', async () => {
    const calls = installFetch((c) => {
      if (c.url.includes('/api/memories')) {
        return json({
          items: [
            { id: 'mem_1', scopeType: 'global', scopeId: null, title: 'Prefer A', canManage: true },
          ],
        })
      }
      if (c.method === 'POST' && c.url.includes('/api/fusions')) {
        return json({ id: 'fus_1' }, 201)
      }
      return json([])
    })
    mount({ kind: 'from-skill', skillId: 'skill_1', skillName: 'my-skill' })
    await waitFor(() => expect(screen.getByTestId('fusion-memory-picker')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Start fusion' }))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.body).toMatchObject({ skillId: 'skill_1', memoryIds: ['mem_1'] })
      expect(post!.body).not.toHaveProperty('skillName')
    })
  })

  test('from-memories: same-name skills are owner-labelled, remain unselected, and submit by id', async () => {
    const calls = installFetch((c) => {
      if (c.url.includes('/api/skills')) {
        return json([
          {
            id: 'skill_a_1',
            name: 'shared',
            description: '',
            sourceKind: 'managed',
            ownerUserId: 'u1',
          },
          {
            id: 'skill_a_2',
            name: 'shared',
            description: '',
            sourceKind: 'managed',
            ownerUserId: 'u2',
          },
          { id: 's2', name: 'ext-b', description: '', sourceKind: 'external' },
        ])
      }
      if (c.url.includes('/api/users/lookup')) {
        return json([
          { id: 'u1', username: 'alice', displayName: 'Alice' },
          { id: 'u2', username: 'bob', displayName: 'Bob' },
        ])
      }
      if (c.method === 'POST' && c.url.includes('/api/fusions')) {
        return json({ id: 'fus_2' }, 201)
      }
      return json({ items: [] })
    })
    mount({ kind: 'from-memories', memoryIds: ['mem_1', 'mem_2'] })
    await waitFor(() => expect(screen.getByText('Target skill')).toBeTruthy())
    // The two preset ids surface as the count summary, not as a picker.
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(screen.queryByTestId('fusion-memory-picker')).toBeNull()

    const select = await screen.findByRole('combobox')
    expect(select.textContent).toContain('Pick a managed skill')
    fireEvent.click(select)
    const alice = await screen.findByRole('option', { name: /shared · Alice · skill_a_/ })
    const bob = screen.getByRole('option', { name: /shared · Bob · skill_a_/ })
    expect(alice.textContent).not.toBe(bob.textContent)
    fireEvent.mouseDown(bob)
    fireEvent.click(screen.getByRole('button', { name: 'Start fusion' }))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/fusions'))
      expect(post?.body).toMatchObject({ skillId: 'skill_a_2', memoryIds: ['mem_1', 'mem_2'] })
      expect(post?.body).not.toHaveProperty('skillName')
    })
  })
})

describe('FuseDialog — implicit undefined-prop mode is gone (source lock)', () => {
  test('component keys every mode branch off entry.kind', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fusion', 'FuseDialog.tsx'),
      'utf8',
    )
    expect(src).toContain('FuseDialogEntry')
    expect(src.includes('lockedSkillName'), 'old optional prop survives').toBe(false)
    expect(src.includes('presetMemoryIds'), 'old optional prop survives').toBe(false)
  })
})
