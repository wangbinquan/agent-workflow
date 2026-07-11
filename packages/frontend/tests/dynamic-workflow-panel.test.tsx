// RFC-167 PR-3 — DynamicWorkflowPanel contract (the dynamic task's primary
// view until its generated DAG is confirmed).
//
// Locks:
//   1. generating: progress copy carries the attempt counter (attempts+1);
//      a rejection-feedback block renders when the round is a regeneration.
//   2. generation exhausted (task failed while phase=generating): the error
//      summary surfaces in-panel instead of an infinite spinner.
//   3. awaiting_confirm: the read-only DAG preview mounts (real WorkflowCanvas
//      over the generated def — node visible) + approve POSTs
//      {decision:'approve'} to /dw-confirm.
//   4. reject flows through a REQUIRED-comment dialog; submit POSTs
//      {decision:'reject', comment}.
//   5. save-as: name-required dialog POSTs /dw-save-as-workflow and surfaces
//      the saved-as note on success.
//   6. executing: pointer card renders (no gate buttons), save-as stays.
//   7. a 409 from the gate (e.g. dw-generated-def-stale) renders in-panel.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DwState, TaskStatus } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { DynamicWorkflowPanel } from '../src/components/workgroup/DynamicWorkflowPanel'
import type { WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import '../src/i18n'

const GENERATED_DEF = {
  $schema_version: 4,
  inputs: [],
  nodes: [{ id: 'plan-step', kind: 'agent-single', agentName: 'wg-planner', promptTemplate: 'x' }],
  edges: [],
}

function makeRoom(dw: DwState | null, taskStatus: TaskStatus = 'running'): WorkgroupRoomResponse {
  return {
    taskId: 't1',
    taskStatus,
    config: {
      workgroupId: 'wg1',
      workgroupName: 'dyn-squad',
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 10,
      completionGate: false,
      instructions: '',
      goal: 'fix the race',
      members: [
        {
          id: 'm1',
          memberType: 'agent',
          agentName: 'wg-planner',
          userId: null,
          displayName: 'planner',
          roleDesc: '',
        },
      ],
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false, summary: null },
    dw,
    messages: [],
    assignments: [],
  }
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(
  room: WorkgroupRoomResponse,
  overrides: { confirm?: () => Response; saveAs?: () => Response } = {},
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/dw-confirm') && method === 'POST') {
        return overrides.confirm !== undefined ? overrides.confirm() : json({ decision: 'ok' })
      }
      if (url.includes('/dw-save-as-workflow') && method === 'POST') {
        return overrides.saveAs !== undefined
          ? overrides.saveAs()
          : json({ id: 'wf1', name: 'saved-dw' }, 201)
      }
      if (url.includes('/room')) return json(room)
      if (url.includes('/api/agents')) {
        return json([
          {
            name: 'wg-planner',
            description: '',
            outputs: ['plan'],
            skills: [],
            dependsOn: [],
            mcp: [],
            plugins: [],
            frontmatterExtra: {},
            bodyMd: '',
          },
        ])
      }
      return json({})
    },
  )
  return calls
}

function renderPanel(taskStatus: TaskStatus = 'running', errorSummary: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DynamicWorkflowPanel taskId="t1" taskStatus={taskStatus} errorSummary={errorSummary} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('DynamicWorkflowPanel — generating', () => {
  test('progress card carries the attempt counter and the rejection feedback block', async () => {
    installFetch(
      makeRoom({
        phase: 'generating',
        generateAttempts: 1,
        rejectRounds: 1,
        rejectionComment: '拆得太粗',
      }),
    )
    renderPanel()
    const card = await screen.findByTestId('dw-generating-card')
    expect(card.textContent).toContain('2') // attempts + 1
    expect((await screen.findByTestId('dw-rejection-feedback')).textContent).toContain('拆得太粗')
  })

  test('generation exhausted (task failed) surfaces the error summary in-panel', async () => {
    installFetch(makeRoom({ phase: 'generating', generateAttempts: 3, rejectRounds: 0 }, 'failed'))
    renderPanel('failed', 'dw-generate-exhausted')
    const box = await screen.findByTestId('dw-generate-failed')
    expect(box.textContent).toContain('dw-generate-exhausted')
  })
})

describe('DynamicWorkflowPanel — confirm gate', () => {
  const AWAITING: DwState = {
    phase: 'awaiting_confirm',
    generateAttempts: 0,
    rejectRounds: 0,
    generatedDef: GENERATED_DEF,
  }

  test('read-only preview mounts the generated DAG; approve POSTs the decision', async () => {
    const calls = installFetch(makeRoom(AWAITING, 'awaiting_review'))
    renderPanel('awaiting_review')
    // the real canvas renders the generated node
    expect(await screen.findByTestId('dw-preview-canvas')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('wg-planner')).toBeTruthy())

    fireEvent.click(await screen.findByTestId('dw-gate-approve'))
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/dw-confirm') && c.method === 'POST')
      expect(post).toBeDefined()
      expect(post?.body).toEqual({ decision: 'approve' })
    })
  })

  test('reject requires a comment; submit POSTs decision+comment', async () => {
    const calls = installFetch(makeRoom(AWAITING, 'awaiting_review'))
    renderPanel('awaiting_review')
    fireEvent.click(await screen.findByTestId('dw-gate-reject'))
    const submit = await screen.findByTestId('dw-reject-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('dw-reject-comment'), {
      target: { value: '按模块拆开' },
    })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/dw-confirm') && c.method === 'POST')
      expect(post?.body).toEqual({ decision: 'reject', comment: '按模块拆开' })
    })
  })

  test('a 409 gate error (stale proposal) renders in-panel', async () => {
    installFetch(makeRoom(AWAITING, 'awaiting_review'), {
      confirm: () =>
        new Response(
          JSON.stringify({ ok: false, code: 'dw-generated-def-stale', message: 'stale' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    })
    renderPanel('awaiting_review')
    fireEvent.click(await screen.findByTestId('dw-gate-approve'))
    expect(await screen.findByTestId('dw-gate-error')).toBeTruthy()
  })

  test('save-as: name-required dialog POSTs and surfaces the saved note', async () => {
    const calls = installFetch(makeRoom(AWAITING, 'awaiting_review'))
    renderPanel('awaiting_review')
    fireEvent.click(await screen.findByTestId('dw-save-as-btn'))
    const submit = await screen.findByTestId('dw-save-as-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('dw-save-as-name'), { target: { value: 'saved-dw' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/dw-save-as-workflow') && c.method === 'POST')
      expect(post?.body).toEqual({ name: 'saved-dw' })
    })
    expect((await screen.findByTestId('dw-saved-note')).textContent).toContain('saved-dw')
  })
})

describe('DynamicWorkflowPanel — executing', () => {
  test('pointer card renders without gate buttons; save-as stays available', async () => {
    installFetch(
      makeRoom({
        phase: 'executing',
        generateAttempts: 0,
        rejectRounds: 0,
        generatedDef: GENERATED_DEF,
      }),
    )
    renderPanel()
    expect(await screen.findByTestId('dw-executing-card')).toBeTruthy()
    expect(screen.queryByTestId('dw-gate-approve')).toBeNull()
    expect(screen.queryByTestId('dw-gate-reject')).toBeNull()
    expect(screen.getByTestId('dw-save-as-btn')).toBeTruthy()
  })
})
