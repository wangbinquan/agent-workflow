// RFC-329 PR-B —— 人工门工具的契约（proposal §2.2，AC-5…AC-7、AC-9、AC-10）。
//
// 这一层锁的是「工具说自己会做什么」与「它实际打向哪条路由、带什么 body」之间的一致性。
// 它抓不到的（路由自身的业务行为、真实数据下的聚合口径）由 rfc329-workgroup-pending.test.ts
// 与既有的 routes-clarify / rfc164-workgroup-room 承担。
//
// 为什么连描述都要断言：这些工具里有 6 个会**推进任务**（dispatch / messages / confirm /
// dw-confirm / deliver），5 个不会。模型分不清「stage 了」和「发出去了」，而错一次的代价是
// 一个本该继续跑的任务停在那里没人管——所以「会不会推进」必须写在描述里，并由测试钉死。

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { SubmitClarifyAnswersSchema } from '@agent-workflow/shared'
import { ALL_TOOLS, type McpToolContext } from '@/mcp/tools'

function toolNamed(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool '${name}' not found`)
  return tool
}

interface Call {
  method: string
  path: string
  body?: unknown
  query?: Record<string, string | undefined>
}

/** Runs a tool against a recording dispatcher and returns what it dispatched. */
async function dispatchOf(
  name: string,
  args: Record<string, unknown>,
  respond: (path: string) => unknown = () => ({}),
): Promise<Call[]> {
  const calls: Call[] = []
  const ctx: McpToolContext = {
    actor: {} as McpToolContext['actor'],
    dispatch: async (req) => {
      calls.push({
        method: req.method,
        path: req.path,
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.query !== undefined ? { query: req.query } : {}),
      })
      return { status: 200, body: respond(req.path) }
    },
    progress: async () => {},
    signal: new AbortController().signal,
  }
  await toolNamed(name).handler(args, ctx)
  return calls
}

describe('RFC-329 AC-5 — answer_clarify can express the control channel', () => {
  test('the three control-channel fields reach the route', async () => {
    const calls = await dispatchOf('answer_clarify', {
      nodeRunId: 'NR1',
      answers: [{ questionId: 'q1' }],
      ifMatchIteration: 3,
      directive: 'continue',
      defer: true,
      questionIds: ['q1'],
      resubmitQuestionIds: ['q0'],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/api/clarify/NR1/answers')
    expect(calls[0]?.body).toEqual({
      answers: [{ questionId: 'q1' }],
      ifMatchIteration: 3,
      directive: 'continue',
      defer: true,
      questionIds: ['q1'],
      resubmitQuestionIds: ['q0'],
    })
  })

  test('the quick channel is byte-identical to what it sent before RFC-329', async () => {
    // Golden lock: omitting the new fields must not start sending `defer: false`
    // or an empty `questionIds` — the route branches on `defer` being truthy and
    // refuses `questionIds` without it, so a helpfully-filled default would turn
    // every plain answer into a 422.
    const calls = await dispatchOf('answer_clarify', {
      nodeRunId: 'NR1',
      answers: [],
      directive: 'stop',
    })
    expect(calls[0]?.body).toEqual({
      answers: [],
      ifMatchIteration: undefined,
      directive: 'stop',
      defer: undefined,
      questionIds: undefined,
      resubmitQuestionIds: undefined,
    })
  })

  test('every field the route accepts is expressible here (the gap that started RFC-329)', () => {
    // `answer_clarify` dispatched to the right route all along; what it could not
    // do was say `defer`. A path-only guard cannot see that, so this is the
    // assertion that actually pins the original finding.
    const routeKeys = new Set(Object.keys(SubmitClarifyAnswersSchema.shape))
    const toolKeys = new Set(Object.keys(toolNamed('answer_clarify').inputSchema))
    expect([...routeKeys].filter((key) => !toolKeys.has(key)).sort()).toEqual([])
  })

  test('the description tells the caller the two channels apart', () => {
    const description = toolNamed('answer_clarify').description
    expect(description).toContain('defer')
    expect(description.toLowerCase()).toContain('does not advance')
  })
})

describe('RFC-329 AC-7 — the clarify board is reachable, and says what advances the run', () => {
  const BOARD: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    ['list_task_questions', { id: 'T1' }, 'GET', '/api/tasks/T1/questions'],
    [
      'raise_task_question',
      { id: 'T1', title: 't', body: 'b' },
      'POST',
      '/api/tasks/T1/questions/manual',
    ],
    [
      'confirm_task_question',
      { id: 'T1', entryId: 'E1' },
      'POST',
      '/api/tasks/T1/questions/E1/confirm',
    ],
    [
      'reassign_task_question',
      { id: 'T1', entryId: 'E1', targetNodeId: 'N1' },
      'POST',
      '/api/tasks/T1/questions/E1/reassign',
    ],
    [
      'stage_task_question',
      { id: 'T1', entryId: 'E1' },
      'POST',
      '/api/tasks/T1/questions/E1/stage',
    ],
    ['dispatch_task_questions', { id: 'T1' }, 'POST', '/api/tasks/T1/questions/dispatch'],
    ['list_clarify_directives', { id: 'T1' }, 'GET', '/api/tasks/T1/clarify-directives'],
    [
      'set_clarify_directive',
      { id: 'T1', nodeId: 'N1', directive: 'stop' },
      'POST',
      '/api/tasks/T1/nodes/N1/clarify-directive',
    ],
    [
      'save_clarify_draft',
      { nodeRunId: 'NR1', roundId: 'R1', questionId: 'q1' },
      'PUT',
      '/api/clarify/NR1/draft',
    ],
  ]

  for (const [name, args, method, path] of BOARD) {
    test(`${name} dispatches ${method} ${path}`, async () => {
      const calls = await dispatchOf(name, args)
      expect(calls).toHaveLength(1)
      expect(`${calls[0]?.method} ${calls[0]?.path}`).toBe(`${method} ${path}`)
    })
  }

  test('dispatch_task_questions is the ONLY board tool that claims to resume the run', () => {
    const claims = BOARD.map(([name]) => name).filter((name) =>
      /THIS IS THE STEP THAT RESUMES THE RUN/.test(toolNamed(name).description),
    )
    expect(claims).toEqual(['dispatch_task_questions'])
  })

  test('dispatch_task_questions warns that a 200 can still mean "not resumed"', () => {
    // The route records the send, then kicks the engine; the kick can fail while
    // the response stays 200 with `resume.ok === false`. A model that reports
    // success on the status code alone leaves the task parked.
    const description = toolNamed('dispatch_task_questions').description
    expect(description).toContain('resume')
    expect(description).toMatch(/resume\.ok === false|Check `resume`/)
  })

  test('set_clarify_directive and answer_clarify point at each other', () => {
    // They write the same switch (RFC-123). A caller who does not know that will
    // answer with `directive: "stop"` and then wonder why the node switch moved.
    expect(toolNamed('set_clarify_directive').description).toContain('answer_clarify')
    expect(toolNamed('answer_clarify').description).toContain('set_clarify_directive')
  })

  test('save_clarify_draft states the last-write-wins semantics', () => {
    // There is no revision fence on the draft route; a concurrent editor silently
    // replaces what you parked. Saying so is the whole mitigation.
    const description = toolNamed('save_clarify_draft').description
    expect(description).toMatch(/LAST WRITE WINS/i)
    expect(description.toLowerCase()).toContain('not answers')
  })
})

describe('RFC-329 AC-8 — the workgroup room is reachable', () => {
  const ROOM: ReadonlyArray<[string, Record<string, unknown>, string, string]> = [
    ['get_workgroup_room', { id: 'T1' }, 'GET', '/api/workgroup-tasks/T1/room'],
    [
      'post_workgroup_message',
      { id: 'T1', body: 'hi' },
      'POST',
      '/api/workgroup-tasks/T1/messages',
    ],
    [
      'confirm_workgroup_step',
      { id: 'T1', decision: 'approve' },
      'POST',
      '/api/workgroup-tasks/T1/confirm',
    ],
    [
      'confirm_workgroup_dynamic_workflow',
      { id: 'T1', decision: 'approve' },
      'POST',
      '/api/workgroup-tasks/T1/dw-confirm',
    ],
    [
      'save_workgroup_dynamic_workflow',
      { id: 'T1', name: 'w' },
      'POST',
      '/api/workgroup-tasks/T1/dw-save-as-workflow',
    ],
    [
      'deliver_workgroup_assignment',
      { id: 'T1', assignmentId: 'A1', body: 'done' },
      'POST',
      '/api/workgroup-tasks/T1/assignments/A1/deliver',
    ],
    [
      'cancel_workgroup_assignment',
      { id: 'T1', assignmentId: 'A1' },
      'POST',
      '/api/workgroup-tasks/T1/assignments/A1/cancel',
    ],
  ]

  for (const [name, args, method, path] of ROOM) {
    test(`${name} dispatches ${method} ${path}`, async () => {
      const calls = await dispatchOf(name, args)
      expect(calls).toHaveLength(1)
      expect(`${calls[0]?.method} ${calls[0]?.path}`).toBe(`${method} ${path}`)
    })
  }

  test('reject requires a comment, and both confirm tools say so', () => {
    for (const name of ['confirm_workgroup_step', 'confirm_workgroup_dynamic_workflow']) {
      expect(toolNamed(name).description).toMatch(/reject.{0,40}comment/i)
    }
  })

  test('the three tools that kick the engine say so; the two that do not, do not', () => {
    const advances = ROOM.map(([name]) => name).filter((name) =>
      /ADVANCES THE RUN/.test(toolNamed(name).description),
    )
    expect(advances.sort()).toEqual([
      'confirm_workgroup_dynamic_workflow',
      'confirm_workgroup_step',
      'deliver_workgroup_assignment',
      'post_workgroup_message',
    ])
  })

  test('post_workgroup_message warns that a plain message wakes an idle leader', () => {
    // Posting without an "@member" is not a no-op: it lands on the blackboard and
    // restarts a leader that had gone idle.
    expect(toolNamed('post_workgroup_message').description).toMatch(/blackboard|idle/i)
  })
})

describe('RFC-329 AC-9 — fusion approvals, with their real visibility', () => {
  test('the five tools dispatch where they say', async () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>, string]> = [
      ['list_fusions', {}, 'GET /api/fusions'],
      ['get_fusion', { id: 'F1' }, 'GET /api/fusions/F1'],
      ['approve_fusion', { id: 'F1' }, 'POST /api/fusions/F1/approve'],
      ['reject_fusion', { id: 'F1', feedback: 'no' }, 'POST /api/fusions/F1/reject'],
      ['cancel_fusion', { id: 'F1' }, 'POST /api/fusions/F1/cancel'],
    ]
    for (const [name, args, expected] of cases) {
      const calls = await dispatchOf(name, args)
      expect(`${calls[0]?.method} ${calls[0]?.path}`).toBe(expected)
    }
  })

  test('an unknown status is refused HERE, not silently turned into "no filter"', () => {
    // routes/fusions.ts safeParses `?status` and falls back to undefined on a miss,
    // so a typo returns EVERY fusion while the caller believes it is looking at the
    // pending ones — and the next thing it does is approve one.
    const schema = z.object(toolNamed('list_fusions').inputSchema)
    expect(schema.safeParse({ status: 'awaiting_approval' }).success).toBe(true)
    expect(schema.safeParse({ status: 'awaiting-approval' }).success).toBe(false)
    expect(schema.safeParse({ status: 'pending' }).success).toBe(false)
  })

  test('list_fusions does not pretend a token can see everyone’s fusions', () => {
    // The bypass that widens this list is a system-domain point; no PAT holds it.
    // An empty list therefore means "none of yours".
    const description = toolNamed('list_fusions').description
    expect(description).toMatch(/ALWAYS scoped to your own|owner/i)
    expect(description).toContain('none of yours')
  })

  test('approve_fusion states the irreversible half', () => {
    const description = toolNamed('approve_fusion').description
    expect(description).toMatch(/IRREVERSIBLE/i)
    expect(description).toContain('version')
  })

  test('reject re-runs, cancel does not — and each says which', () => {
    expect(toolNamed('reject_fusion').description).toMatch(/RE-RUNS|re-runs/)
    expect(toolNamed('cancel_fusion').description).toMatch(/does not re-run/i)
  })
})

describe('RFC-329 AC-10 — list_pending_gates covers four gates and fails per lane', () => {
  test('all four lanes are queried', async () => {
    const calls = await dispatchOf('list_pending_gates', {})
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /api/clarify',
      'GET /api/fusions',
      'GET /api/reviews',
      'GET /api/workgroup-tasks/pending',
    ])
    const fusions = calls.find((c) => c.path === '/api/fusions')
    expect(fusions?.query).toEqual({ status: 'awaiting_approval' })
  })

  test('a failing lane reports itself instead of looking empty', async () => {
    // This is the failure that matters: a 500 on one lane used to surface as an
    // empty gate list, and "nothing is waiting on you" is exactly what a model
    // acts on by moving on. Promise.allSettled alone does NOT catch it — the
    // dispatcher resolves 4xx/5xx as fulfilled results.
    const ctx: McpToolContext = {
      actor: {} as McpToolContext['actor'],
      dispatch: async (req) =>
        req.path === '/api/workgroup-tasks/pending'
          ? { status: 500, body: { code: 'boom', message: 'boom' } }
          : { status: 200, body: [] },
      progress: async () => {},
      signal: new AbortController().signal,
    }
    const result = (await toolNamed('list_pending_gates').handler({}, ctx)) as Record<
      string,
      { ok: boolean; error?: string; data?: unknown }
    > & { complete: boolean }

    expect(result.complete).toBe(false)
    expect(result.workgroupTasks).toEqual({ ok: false, error: 'boom' })
    // The other three still answered.
    expect(result.reviews).toEqual({ ok: true, data: [] })
    expect(result.clarify).toEqual({ ok: true, data: [] })
    expect(result.fusions).toEqual({ ok: true, data: [] })
  })

  test('all lanes healthy ⇒ complete: true', async () => {
    const result = (await toolNamed('list_pending_gates').handler(
      {},
      {
        actor: {} as McpToolContext['actor'],
        dispatch: async () => ({ status: 200, body: [] }),
        progress: async () => {},
        signal: new AbortController().signal,
      },
    )) as { complete: boolean }
    expect(result.complete).toBe(true)
  })

  test('the description warns that an empty lane is only trustworthy when ok', () => {
    const description = toolNamed('list_pending_gates').description
    expect(description).toContain('complete')
    expect(description).toMatch(/only trustworthy|ok/i)
  })
})
