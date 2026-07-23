// RFC-195 — InboxDrawer business behavior on top of the shared Dialog.
//
// This suite deliberately locks the user-facing seams rather than the old
// hand-rolled drawer chrome: three-source filtering/counts, failure-soft
// states, semantic dialog/focus behavior, and close-before-navigation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import type { RefObject } from 'react'
import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const navigateSpy = vi.fn()

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

// Imported AFTER vi.mock so the mock is bound.
import { InboxDrawer } from '../src/components/shell/InboxDrawer'

interface ReviewFixture {
  nodeRunId: string
  taskId: string
  taskName: string
  title: string
  workflowName: string
  createdAt: number
}

interface ClarifyFixture {
  id: string
  // RFC-058: legacy aliases stay on the fixture surface for readability;
  // mockLists maps them to the unified ClarifyRoundSummary fields.
  clarifyNodeRunId: string
  clarifyNodeId: string
  clarifyNodeTitle: string | null
  taskId: string
  taskName: string
  sourceAgentNodeId: string
  sourceAgentNodeTitle: string | null
  askingShardKey: string | null
  iteration: number
  createdAt: number
}

interface WorkgroupFixture {
  deliveries: number
  gates: number
  total: number
}

type FeedFixtures<T> = Array<Partial<T>> | 'error'

function mockLists(opts: {
  reviews?: FeedFixtures<ReviewFixture>
  clarify?: FeedFixtures<ClarifyFixture>
  workgroups?: WorkgroupFixture | 'error'
}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    if (s.includes('/api/reviews?status=pending')) {
      if (opts.reviews === 'error') return json({ code: 'reviews_failed', message: 'boom' }, 500)
      const rows = (opts.reviews ?? []).map((r, i) => ({
        nodeRunId: r.nodeRunId ?? `r${i}`,
        taskId: r.taskId ?? 'task_a',
        taskName: r.taskName ?? 'fixture-task',
        workflowId: 'wf_1',
        workflowName: r.workflowName ?? 'wf-name',
        reviewNodeId: 'rev_node',
        title: r.title ?? `review ${i}`,
        description: '',
        currentVersionIndex: 1,
        reviewIteration: 0,
        decision: 'awaiting',
        awaitingReview: true,
        shardKey: null,
        createdAt: r.createdAt ?? 1_700_000_000_000 + i * 1000,
        decidedAt: null,
      }))
      return json(rows)
    }

    if (s.includes('/api/clarify?status=awaiting_human')) {
      if (opts.clarify === 'error') return json({ code: 'clarify_failed', message: 'boom' }, 500)
      const rows = (opts.clarify ?? []).map((c, i) => ({
        id: c.id ?? `sess_${i}`,
        taskId: c.taskId ?? 'task_b',
        taskName: c.taskName ?? 'fixture-task',
        kind: 'self' as const,
        askingNodeId: c.sourceAgentNodeId ?? `agent_${i}`,
        askingNodeTitle: c.sourceAgentNodeTitle === undefined ? null : c.sourceAgentNodeTitle,
        askingShardKey: c.askingShardKey ?? null,
        intermediaryNodeId: c.clarifyNodeId ?? 'clarify_node',
        intermediaryNodeTitle: c.clarifyNodeTitle === undefined ? null : c.clarifyNodeTitle,
        intermediaryNodeRunId: c.clarifyNodeRunId ?? `cn${i}`,
        targetConsumerNodeId: null,
        loopIter: 0,
        iteration: c.iteration ?? 0,
        questionCount: 2,
        status: 'awaiting_human' as const,
        directive: null,
        createdAt: c.createdAt ?? 1_700_000_500_000 + i * 1000,
        answeredAt: null,
      }))
      return json(rows)
    }

    if (s.includes('/api/workgroup-tasks/pending-count')) {
      if (opts.workgroups === 'error') {
        return json({ code: 'workgroups_failed', message: 'boom' }, 500)
      }
      // The endpoint is count-only. Returning [] here makes the view-model
      // treat a malformed response as settled data and hides state bugs.
      return json(opts.workgroups ?? { deliveries: 0, gates: 0, total: 0 })
    }

    return json({})
  })
}

interface DrawerRenderProps {
  open: boolean
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
}

function renderDrawer(initial: DrawerRenderProps) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const node = (props: DrawerRenderProps) => (
    <QueryClientProvider client={queryClient}>
      <InboxDrawer {...props} />
    </QueryClientProvider>
  )
  const view = render(node(initial))
  return {
    ...view,
    rerenderDrawer: (next: DrawerRenderProps) => view.rerender(node(next)),
  }
}

function expectCloseBeforeNavigate(onClose: ReturnType<typeof vi.fn>): void {
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(navigateSpy).toHaveBeenCalledTimes(1)
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(navigateSpy.mock.invocationCallOrder[0]!)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  navigateSpy.mockReset()
})

afterEach(() => {
  // Unmount before restoring globals because Dialog portals into body.
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-195 InboxDrawer', () => {
  test('open=false renders nothing', () => {
    mockLists({})
    renderDrawer({ open: false, onClose: () => {} })
    expect(screen.queryByTestId('inbox-drawer')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('delegates modal lifecycle to the shared Dialog primitive', () => {
    const source = readFileSync(
      resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../src/components/shell/InboxDrawer.tsx',
      ),
      'utf8',
    )
    expect(source).toContain("from '@/components/Dialog'")
    expect(source).not.toMatch(/createPortal|addEventListener\(\s*['"]keydown/)
  })

  test('uses shared Dialog semantics and exposes a labelled heading', async () => {
    mockLists({})
    renderDrawer({ open: true, onClose: () => {} })

    const dialog = await screen.findByRole('dialog', { name: /Inbox|收件箱/ })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByRole('heading', { name: /Inbox|收件箱/, level: 2 })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /Close|关闭/ })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /Filter inbox|按待办类型筛选/ })).toBeTruthy()
  })

  test('three-source counts stay visible while filtering review/clarify rows', async () => {
    mockLists({
      reviews: [{ nodeRunId: 'r1' }, { nodeRunId: 'r2' }],
      clarify: [{ id: 'c1', clarifyNodeRunId: 'cn1' }],
      workgroups: { deliveries: 2, gates: 1, total: 3 },
    })
    renderDrawer({ open: true, onClose: () => {} })

    await screen.findByTestId('inbox-row-review-r1')
    await waitFor(() => {
      expect(screen.getByTestId('inbox-tab-all').textContent ?? '').toMatch(/6/)
      expect(screen.getByTestId('inbox-tab-reviews').textContent ?? '').toMatch(/2/)
      expect(screen.getByTestId('inbox-tab-clarify').textContent ?? '').toMatch(/1/)
    })
    expect(screen.getByRole('radio', { name: /All\s*6|全部\s*6/ })).toBeTruthy()
    expect(screen.getByTestId('inbox-row-workgroups')).toBeTruthy()
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('inbox-dialog__item')),
    ).toHaveLength(4)

    fireEvent.click(screen.getByTestId('inbox-tab-reviews'))
    await waitFor(() => expect(screen.queryByTestId('inbox-row-clarify-c1')).toBeNull())
    expect(screen.queryByTestId('inbox-row-workgroups')).toBeNull()
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('inbox-dialog__item')),
    ).toHaveLength(2)
  })

  test('review row closes synchronously before detail navigation', async () => {
    mockLists({ reviews: [{ nodeRunId: 'r99' }] })
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })

    fireEvent.click(await screen.findByTestId('inbox-row-review-r99'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/reviews/$nodeRunId',
      params: { nodeRunId: 'r99' },
    })
    expectCloseBeforeNavigate(onClose)
  })

  test('clarify row closes synchronously before detail navigation', async () => {
    mockLists({ clarify: [{ id: 'round-42', clarifyNodeRunId: 'cn-42' }] })
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })

    fireEvent.click(await screen.findByTestId('inbox-row-clarify-round-42'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/clarify/$nodeRunId',
      params: { nodeRunId: 'cn-42' },
    })
    expectCloseBeforeNavigate(onClose)
  })

  test('ESC and overlay click close; clicking the dialog panel does not', async () => {
    mockLists({})
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })

    const overlay = await screen.findByTestId('inbox-drawer')
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  test('selected filter receives initial focus when the dialog reopens', async () => {
    mockLists({})
    const onClose = vi.fn()
    const view = renderDrawer({ open: true, onClose })

    const clarify = await screen.findByTestId('inbox-tab-clarify')
    fireEvent.click(clarify)
    expect(clarify.getAttribute('aria-checked')).toBe('true')

    view.rerenderDrawer({ open: false, onClose })
    expect(screen.queryByTestId('inbox-drawer')).toBeNull()
    view.rerenderDrawer({ open: true, onClose })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('inbox-tab-clarify')),
    )
  })

  // RFC-121 regression: fusion and memory approval data live on /memory and
  // must never leak back into the task-flow inbox, including for admins.
  test('fusion and memory candidate data never leak into the dialog', async () => {
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = typeof url === 'string' ? url : url.toString()
      requested.push(s)
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (s.includes('/api/auth/me')) {
        return json({
          user: { id: 'u', username: 'u', displayName: 'u', role: 'admin', status: 'active' },
          source: 'session',
          permissions: ['memory:approve'],
          linkedIdentities: [],
          pats: [],
        })
      }
      if (s.includes('/api/fusions')) {
        return json([
          {
            id: 'fus_1',
            skillId: 'skill_1',
            skillName: 'sk',
            status: 'awaiting_approval',
            memoryIds: ['m1'],
            createdAt: 1,
          },
        ])
      }
      if (s.includes('/api/memories')) {
        return json({ items: [{ id: 'mem_1', title: 'cand', status: 'candidate' }] })
      }
      if (s.includes('/api/workgroup-tasks/pending-count')) {
        return json({ deliveries: 0, gates: 0, total: 0 })
      }
      return json([])
    })

    renderDrawer({ open: true, onClose: () => {} })
    await screen.findByTestId('inbox-drawer')
    expect(screen.queryByTestId('inbox-tab-fusion')).toBeNull()
    expect(screen.queryByTestId('inbox-tab-memory')).toBeNull()
    expect(screen.queryByTestId('inbox-row-fusion-fus_1')).toBeNull()
    expect(screen.queryByTestId('inbox-row-memory-mem_1')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy())
    expect(
      requested.filter((url) => /\/api\/(reviews|clarify|workgroup-tasks)/.test(url)),
    ).toHaveLength(3)
    expect(requested.some((url) => /\/api\/(fusions|memories)/.test(url))).toBe(false)
  })

  test('shows the shared loading state while the selected feeds are unresolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
    renderDrawer({ open: true, onClose: () => {} })
    expect(await screen.findByTestId('inbox-loading')).toBeTruthy()
  })

  test('each retry action refetches only its failed feed', async () => {
    mockLists({ reviews: 'error', clarify: 'error', workgroups: 'error' })
    renderDrawer({ open: true, onClose: () => {} })
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3))

    const callsFor = (fragment: string) =>
      vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes(fragment))
        .length

    expect(callsFor('/api/reviews?status=pending')).toBe(1)
    expect(callsFor('/api/clarify?status=awaiting_human')).toBe(1)
    expect(callsFor('/api/workgroup-tasks/pending-count')).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /Retry Reviews|重试加载评审/ }))
    await waitFor(() => expect(callsFor('/api/reviews?status=pending')).toBe(2))
    expect(callsFor('/api/clarify?status=awaiting_human')).toBe(1)
    expect(callsFor('/api/workgroup-tasks/pending-count')).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /Retry Clarify|重试加载反问/ }))
    await waitFor(() => expect(callsFor('/api/clarify?status=awaiting_human')).toBe(2))
    expect(callsFor('/api/reviews?status=pending')).toBe(2)
    expect(callsFor('/api/workgroup-tasks/pending-count')).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /Retry Workgroup|重试加载工作组/ }))
    await waitFor(() => expect(callsFor('/api/workgroup-tasks/pending-count')).toBe(2))
    expect(callsFor('/api/reviews?status=pending')).toBe(2)
    expect(callsFor('/api/clarify?status=awaiting_human')).toBe(2)
  })

  test('clarify title prefers node title and context keeps the asking agent', async () => {
    mockLists({
      clarify: [
        {
          id: 'round-titled',
          clarifyNodeRunId: 'cn-titled',
          clarifyNodeId: 'clarify_db',
          clarifyNodeTitle: 'Ask user about the DB',
          sourceAgentNodeId: 'agent_xy_01',
          sourceAgentNodeTitle: 'Implementation Coder',
        },
      ],
    })
    renderDrawer({ open: true, onClose: () => {} })

    const row = await screen.findByTestId('inbox-row-clarify-round-titled')
    expect(row.textContent ?? '').toContain('Ask user about the DB')
    expect(row.textContent ?? '').toContain('Implementation Coder')
    expect(row.textContent ?? '').not.toContain('clarify_db')
  })

  test('clarify title and agent labels fall back to stable ids', async () => {
    mockLists({
      clarify: [
        {
          id: 'round-untitled',
          clarifyNodeRunId: 'cn-untitled',
          clarifyNodeId: 'clarify_legacy',
          clarifyNodeTitle: null,
          sourceAgentNodeId: 'agent_legacy_99',
          sourceAgentNodeTitle: null,
        },
      ],
    })
    renderDrawer({ open: true, onClose: () => {} })

    const row = await screen.findByTestId('inbox-row-clarify-round-untitled')
    expect(row.textContent ?? '').toContain('clarify_legacy')
    expect(row.textContent ?? '').toContain('agent_legacy_99')
  })

  test('settled zero feeds render shared EmptyState title and guidance', async () => {
    mockLists({ reviews: [], clarify: [], workgroups: { deliveries: 0, gates: 0, total: 0 } })
    renderDrawer({ open: true, onClose: () => {} })

    const empty = await screen.findByTestId('empty-state')
    expect(empty.textContent ?? '').toMatch(/Nothing waiting|当前没有待处理事项/)
    expect(empty.textContent ?? '').toMatch(/New reviews|新的评审/)
  })

  test('partial feed failure keeps surviving content and never reports empty', async () => {
    mockLists({
      reviews: 'error',
      clarify: [{ id: 'round-survives', clarifyNodeRunId: 'cn-survives' }],
      workgroups: { deliveries: 0, gates: 0, total: 0 },
    })
    renderDrawer({ open: true, onClose: () => {} })

    await screen.findByTestId('inbox-row-clarify-round-survives')
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByTestId('empty-state')).toBeNull()
    expect(screen.getByTestId('inbox-drawer').textContent ?? '').toMatch(
      /Some to-dos could not be loaded|部分待办未加载/,
    )
  })

  test('all failed feeds render alerts instead of the empty state', async () => {
    mockLists({ reviews: 'error', clarify: 'error', workgroups: 'error' })
    renderDrawer({ open: true, onClose: () => {} })

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3))
    expect(screen.queryByTestId('empty-state')).toBeNull()
  })

  test('row exposes RelativeTime plus task-name source and task-id tooltip', async () => {
    const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5)
    mockLists({
      reviews: [
        {
          nodeRunId: 'r-source',
          taskId: 'task-source-id',
          taskName: 'Customer migration',
          title: 'Check the migration plan',
          workflowName: 'Release workflow',
          createdAt,
        },
      ],
    })
    renderDrawer({ open: true, onClose: () => {} })

    const row = await screen.findByTestId('inbox-row-review-r-source')
    const time = row.querySelector('time')
    expect(time).not.toBeNull()
    expect(time?.getAttribute('datetime')).toBe(new Date(createdAt).toISOString())
    expect(time?.getAttribute('title')).toBeTruthy()
    expect(row.textContent ?? '').toContain('Customer migration')
    expect(row.textContent ?? '').toContain('Release workflow')
    const taskName = within(row).getByTestId('inbox-row-task-name')
    expect(taskName.getAttribute('title')).toBe('task-source-id')
    expect(row.getAttribute('aria-label')).toBeNull()
    expect(row.textContent ?? '').toContain('Release workflow')
  })

  test('128-character title and task name stay intact behind the clamp/ellipsis classes', async () => {
    const title = 'T'.repeat(128)
    const taskName = 'S'.repeat(128)
    mockLists({
      reviews: [
        {
          nodeRunId: 'r-long-copy',
          taskId: 'task-long-copy',
          title,
          taskName,
        },
      ],
    })
    renderDrawer({ open: true, onClose: () => {} })

    const row = await screen.findByTestId('inbox-row-review-r-long-copy')
    const titleNode = row.querySelector('.inbox-dialog__item-title')
    const taskNode = within(row).getByTestId('inbox-row-task-name')
    expect(titleNode?.textContent).toBe(title)
    expect(titleNode?.className).toContain('inbox-dialog__item-title')
    expect(taskNode.textContent).toBe(taskName)
    expect(taskNode.className).toContain('inbox-dialog__task-name')
  })

  test('footer entries navigate and close before leaving the dialog', async () => {
    mockLists({})
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await screen.findByTestId('inbox-drawer')

    fireEvent.click(screen.getByTestId('inbox-drawer-open-reviews'))
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/reviews' })
    expectCloseBeforeNavigate(onClose)
  })

  test('clarify footer entry also closes before navigation', async () => {
    mockLists({})
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await screen.findByTestId('inbox-drawer')

    fireEvent.click(screen.getByTestId('inbox-drawer-open-clarify'))
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/clarify' })
    expectCloseBeforeNavigate(onClose)
  })

  test('clarify sessions sharing a node-run keep stable round keys and filter cleanly', async () => {
    mockLists({
      reviews: [{ nodeRunId: 'r1' }],
      clarify: [
        { id: 'sess_x', clarifyNodeRunId: 'shared_nrun' },
        { id: 'sess_y', clarifyNodeRunId: 'shared_nrun' },
        { id: 'sess_z', clarifyNodeRunId: 'shared_nrun' },
      ],
    })
    renderDrawer({ open: true, onClose: () => {} })
    await screen.findByTestId('inbox-row-review-r1')
    expect(screen.getByTestId('inbox-row-clarify-sess_x')).toBeTruthy()
    expect(screen.getByTestId('inbox-row-clarify-sess_y')).toBeTruthy()
    expect(screen.getByTestId('inbox-row-clarify-sess_z')).toBeTruthy()

    const countItems = () =>
      screen
        .getAllByRole('button')
        .filter((button) => button.className.includes('inbox-dialog__item')).length
    expect(countItems()).toBe(4)

    fireEvent.click(screen.getByTestId('inbox-tab-reviews'))
    await waitFor(() => expect(screen.queryByTestId('inbox-row-clarify-sess_x')).toBeNull())
    expect(countItems()).toBe(1)

    fireEvent.click(screen.getByTestId('inbox-tab-clarify'))
    await screen.findByTestId('inbox-row-clarify-sess_x')
    expect(screen.queryByTestId('inbox-row-review-r1')).toBeNull()
    expect(countItems()).toBe(3)
  })

  test('clarify navigation uses intermediary node-run id, never round id', async () => {
    mockLists({ clarify: [{ id: 'sess_abc', clarifyNodeRunId: 'nrun_xyz' }] })
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })

    fireEvent.click(await screen.findByTestId('inbox-row-clarify-sess_abc'))
    expect(navigateSpy).toHaveBeenCalledWith({
      to: '/clarify/$nodeRunId',
      params: { nodeRunId: 'nrun_xyz' },
    })
    expectCloseBeforeNavigate(onClose)
  })
})
