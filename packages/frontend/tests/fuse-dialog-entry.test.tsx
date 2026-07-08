// RFC-151 PR-1 — FuseDialog entry discriminated union, two-state render lock.
//
// The dialog's two entry points used to be encoded as a PAIR of optional
// props (lockedSkillName? / presetMemoryIds?) whose undefined-ness implied
// the mode — nothing stopped a caller passing both or neither. `entry` is now
// an explicit union:
//   {kind:'from-skill', skillName}    → /skills/$name: skill locked, pick memories
//   {kind:'from-memories', memoryIds} → /memory: memories preset, pick the skill
// Locks each mode's render: which picker Field shows, which is replaced by
// the preset summary, and that the preset memory ids seed the launch payload.

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
    mount({ kind: 'from-skill', skillName: 'my-skill' })
    await waitFor(() => expect(screen.getByTestId('fusion-memory-picker')).toBeTruthy())
    // The target skill is locked → no skill Field, and no /api/skills query.
    expect(screen.queryByText('Target skill')).toBeNull()
    expect(calls.some((c) => c.url.includes('/api/skills'))).toBe(false)
  })

  test('from-skill: locked skill name is what gets submitted', async () => {
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
    mount({ kind: 'from-skill', skillName: 'my-skill' })
    await waitFor(() => expect(screen.getByTestId('fusion-memory-picker')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Start fusion' }))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.body).toMatchObject({ skillName: 'my-skill', memoryIds: ['mem_1'] })
    })
  })

  test('from-memories: skill Select shown, memory picker replaced by preset count', async () => {
    installFetch((c) => {
      if (c.url.includes('/api/skills')) {
        return json([
          { id: 's1', name: 'skill-a', description: '', sourceKind: 'managed' },
          { id: 's2', name: 'ext-b', description: '', sourceKind: 'external' },
        ])
      }
      return json({ items: [] })
    })
    mount({ kind: 'from-memories', memoryIds: ['mem_1', 'mem_2'] })
    await waitFor(() => expect(screen.getByText('Target skill')).toBeTruthy())
    // The two preset ids surface as the count summary, not as a picker.
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(screen.queryByTestId('fusion-memory-picker')).toBeNull()
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
