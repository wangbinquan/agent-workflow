// RFC-032 PR3 Homepage — locks the three-section structure + greeting
// + start-task button + section counts.
//
// Why this test exists: PR3 replaces the previous `<Navigate to="/agents">`
// fallback with a task-driven dashboard. A regression that drops one of
// the three sections, swaps the count badges, or breaks the greeting
// would silently revert the dashboard for everyone (since the first-run
// onboarding path is unaffected). The cases here cover the visual
// structure end-to-end with mocked fetches; the underlying merge /
// greeting logic is exhaustively covered by `homepage-lib.test.ts`.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import type { TaskStatus } from '@agent-workflow/shared'
import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string
      children: React.ReactNode
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
  }
})

// Imported AFTER vi.mock so the mock binds.
import { Homepage } from '../src/components/home/Homepage'

interface MockTask {
  id: string
  status: TaskStatus
  finishedAt?: number | null
}

function mockEndpoints(opts: {
  tasks?: MockTask[]
  reviews?: Array<{ nodeRunId: string; title?: string }>
  clarify?: Array<{ clarifyNodeRunId: string }>
  runtime?: 'ready' | 'missing' | 'checking'
}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    // RFC-135: the hero reads the registry status endpoint (one entry per
    // enabled runtime, version-gate free) instead of /api/runtime/opencode.
    if (s.includes('/api/runtimes/status')) {
      if (opts.runtime === 'missing') {
        // Missing DEFAULT runtime → fault; the non-default row stays ok.
        return json({
          runtimes: [
            {
              name: 'opencode',
              protocol: 'opencode',
              binary: '/usr/local/bin/opencode',
              ok: false,
              version: null,
              isDefault: true,
            },
            {
              name: 'claude-code',
              protocol: 'claude-code',
              binary: 'claude',
              ok: true,
              version: '2.1.193',
              isDefault: false,
            },
          ],
        })
      }
      return json({
        runtimes: [
          {
            name: 'opencode',
            protocol: 'opencode',
            binary: '/usr/local/bin/opencode',
            ok: true,
            version: '0.13.2',
            isDefault: true,
          },
          {
            name: 'claude-code',
            protocol: 'claude-code',
            binary: 'claude',
            ok: true,
            version: '2.1.193',
            isDefault: false,
          },
        ],
      })
    }
    if (s.includes('/api/tasks')) {
      const rows = (opts.tasks ?? []).map((t, i) => ({
        id: t.id,
        workflowId: 'wf_1',
        workflowName: `wf-${i}`,
        repoPath: '/tmp/x',
        repoUrl: null,
        status: t.status,
        startedAt: 1_700_000_000_000 - i * 60_000,
        finishedAt: t.finishedAt ?? null,
        errorSummary: null,
      }))
      return json(rows)
    }
    if (s.includes('/api/reviews?status=pending')) {
      const rows = (opts.reviews ?? []).map((r, i) => ({
        nodeRunId: r.nodeRunId,
        taskId: 'task_a',
        workflowId: 'wf_1',
        workflowName: 'wf-name',
        reviewNodeId: 'rev_node',
        title: r.title ?? `review ${i}`,
        description: '',
        currentVersionIndex: 1,
        reviewIteration: 0,
        decision: 'pending',
        awaitingReview: true,
        shardKey: null,
        createdAt: 1_700_000_000_000 + i,
        decidedAt: null,
      }))
      return json(rows)
    }
    if (s.includes('/api/clarify?status=awaiting_human')) {
      const rows = (opts.clarify ?? []).map((c, i) => ({
        id: `sess_${i}`,
        taskId: 'task_b',
        sourceAgentNodeId: `agent_${i}`,
        sourceShardKey: null,
        clarifyNodeId: 'c1',
        clarifyNodeRunId: c.clarifyNodeRunId,
        iterationIndex: 0,
        questionCount: 2,
        status: 'awaiting_human',
        createdAt: 1_700_000_500_000 + i,
        answeredAt: null,
      }))
      return json(rows)
    }
    return json([])
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RFC-032 Homepage dashboard', () => {
  test('renders the three sections + a Start task button', async () => {
    mockEndpoints({})
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('homepage')).toBeTruthy()
    })
    expect(screen.getByTestId('homepage-section-running')).toBeTruthy()
    expect(screen.getByTestId('homepage-section-inbox')).toBeTruthy()
    expect(screen.getByTestId('homepage-section-recent')).toBeTruthy()
    const startBtn = screen.getByTestId('homepage-start-task')
    expect(startBtn.getAttribute('href')).toBe('/tasks/new')
  })

  // Locks the section order: Inbox ("等你处理") sits above Running, so the
  // awaiting_review / awaiting_human rows the Running list also surfaces
  // don't dominate the page above the actually-actionable inbox queue.
  test('Inbox section renders above Running section', async () => {
    mockEndpoints({})
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('homepage-section-inbox')).toBeTruthy()
    })
    const inbox = screen.getByTestId('homepage-section-inbox')
    const running = screen.getByTestId('homepage-section-running')
    const order = inbox.compareDocumentPosition(running)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('Running section lists running + awaiting tasks; the others sit under Recent', async () => {
    mockEndpoints({
      tasks: [
        { id: 'T_RUN_1', status: 'running' },
        { id: 'T_AWH_1', status: 'awaiting_human' },
        { id: 'T_AWR_1', status: 'awaiting_review' },
        { id: 'T_DONE_1', status: 'done', finishedAt: 1_700_000_100_000 },
        { id: 'T_FAIL_1', status: 'failed', finishedAt: 1_700_000_200_000 },
      ],
    })
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('task-row-T_RUN_1')).toBeTruthy()
    })
    // All three "in flight" rows in the running section.
    expect(screen.getByTestId('task-row-T_AWH_1')).toBeTruthy()
    expect(screen.getByTestId('task-row-T_AWR_1')).toBeTruthy()
    // Terminal rows render in the recent section.
    expect(screen.getByTestId('task-row-T_DONE_1')).toBeTruthy()
    expect(screen.getByTestId('task-row-T_FAIL_1')).toBeTruthy()
  })

  test('empty running queue shows the "No running tasks" hint', async () => {
    mockEndpoints({
      tasks: [{ id: 'T_DONE_1', status: 'done', finishedAt: 1_700_000_100_000 }],
    })
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('homepage-section-running').textContent ?? '').toMatch(
        /No running tasks|暂无运行中任务/,
      )
    })
  })

  test('Waiting on you section merges reviews + clarify pending', async () => {
    mockEndpoints({
      reviews: [{ nodeRunId: 'rev_a' }, { nodeRunId: 'rev_b' }],
      clarify: [{ clarifyNodeRunId: 'cln_a' }],
    })
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-preview-review-rev_a')).toBeTruthy()
    })
    expect(screen.getByTestId('inbox-preview-review-rev_b')).toBeTruthy()
    // testid is keyed on the clarify session `id` (unique across rows),
    // not on `clarifyNodeRunId` which can repeat across loop iterations.
    expect(screen.getByTestId('inbox-preview-clarify-sess_0')).toBeTruthy()
  })

  test('runtime status ready → renders BOTH enabled runtimes with versions (RFC-135)', async () => {
    mockEndpoints({})
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('homepage-runtime').textContent ?? '').toMatch(/0\.13\.2/)
    })
    const text = screen.getByTestId('homepage-runtime').textContent ?? ''
    expect(text).toContain('opencode')
    expect(text).toContain('claude-code')
    expect(text).toMatch(/2\.1\.193/)
  })

  test('default runtime missing → per-runtime "not found" while the other stays versioned', async () => {
    mockEndpoints({ runtime: 'missing' })
    wrap(<Homepage />)
    await waitFor(() => {
      expect(screen.getByTestId('homepage-runtime').textContent ?? '').toMatch(
        /opencode not found|opencode 未找到/,
      )
    })
    // The healthy non-default runtime still renders its version alongside.
    expect(screen.getByTestId('homepage-runtime').textContent ?? '').toMatch(/2\.1\.193/)
  })

  // Regression: the inbox section header link previously hard-coded `to:
  // '/reviews'`, so clicking "Open Inbox" only surfaced reviews — the
  // clarify (反问) items merged into the same preview list had no way to
  // reach. The fix re-points the link at the unified inbox drawer via
  // stores/inbox.ts. This test locks both halves: (a) the link no longer
  // navigates to /reviews, and (b) clicking it flips the inbox store to
  // open.
  test('inbox section "Open inbox" link opens the unified drawer (not /reviews)', async () => {
    const inboxStore = await import('../src/stores/inbox')
    inboxStore.setInboxOpen(false)
    mockEndpoints({ reviews: [{ nodeRunId: 'rev_a' }] })
    wrap(<Homepage />)
    const section = await screen.findByTestId('homepage-section-inbox')
    const link = section.querySelector<HTMLElement>('.homepage-section__link')
    expect(link).toBeTruthy()
    // Bug regression: the link must NOT be a plain <a href="/reviews"> —
    // that's what surfaced only one of the two inbox feeds.
    expect(link?.tagName.toLowerCase()).toBe('button')
    expect(link?.getAttribute('href')).toBeNull()
    expect(inboxStore.getInboxOpen()).toBe(false)
    ;(link as HTMLButtonElement).click()
    expect(inboxStore.getInboxOpen()).toBe(true)
    inboxStore.setInboxOpen(false)
  })
})
