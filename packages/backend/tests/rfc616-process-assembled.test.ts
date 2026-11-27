// RFC-616 §14 (design/RFC-616-process-metrics/design.md) — process metrics
// through the application as the daemon composes it, on both providers.
//
// The other RFC-616 tests cover each layer on its own: the pure engine, the use
// cases over in-memory sources, every fact implementation against a real
// database. This one protects what none of them can see:
//   - bootstrap binds the owners' real fact implementations and mounts the
//     routes (a missing binding or a wrong one fails here, not in a fake);
//   - one task shows the same tokens and cost on the process pages as on the
//     task page of run observation — the two read the same call ledger;
//   - an ordinary member, through the real session path, gets the statistics
//     of their own tasks only and no per-person detail;
//   - an operation a person performs on a real observed route leaves a row in the
//     operations ledger and shows up in the numbers (a sink attached to the wrong
//     application, or a write window read backwards, passes every other test).
import { expect, test } from 'bun:test'
import {
  WORKFLOW_SCHEMA_VERSION,
  type ObservationTaskDetail,
  type ProcessSubjectList,
  type ProcessUnitDetail,
  type ProcessUnitPage,
  type ProcessWorkflowSummary,
} from '@agent-workflow/shared'
import { composeRunObservationCalls } from '@/modules/run-observability/composition/runObservation'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { registerProviderHttpApplicationLifetime } from './helpers/providerHttpApplication'
import { createUser } from './helpers/userFixture'

const openTestApplication = registerProviderHttpApplicationLifetime()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Ten days ago, on the hour: the window below ended three days before the test runs. */
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 10 * DAY
const WINDOW = `from=${T0}&to=${T0 + 7 * DAY}`
const DAEMON_TOKEN = 'rfc616-assembled-daemon-token'
const BASE = '/api/observability/process'

const DEFINITION = JSON.stringify({
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [
    { id: 'design', kind: 'agent-single', agentId: 'agent-design' },
    { id: 'code', kind: 'agent-single', agentId: 'agent-code' },
  ],
  edges: [],
})

/** The total a task page shows: reasoning is part of output and is not added twice. */
const tokensOf = (usage: ObservationTaskDetail['usage']) =>
  usage.input + usage.cacheRead + usage.cacheWrite + usage.output

async function seed(db: PersistenceDb) {
  const member = async (username: string) => {
    const user = await createUser(db, {
      username,
      displayName: `dn-${username}`,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  const alice = await member('alice616')
  const bob = await member('bob616')
  await workflowFixture(db, { id: 'wf-asm', name: 'assembled flow', definition: DEFINITION })
  const task = (
    id: string,
    ownerUserId: string,
    spec: { status: 'done' | 'failed'; startedAt: number; finishedAt: number; runningMs: number },
  ) =>
    taskFixture(db, {
      id,
      name: `task ${id}`,
      workflowId: 'wf-asm',
      workflowSnapshot: DEFINITION,
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      inputs: '{}',
      ownerUserId,
      ...spec,
    })
  await task('t-a', alice.id, {
    status: 'done',
    startedAt: T0 + HOUR,
    finishedAt: T0 + 3 * HOUR,
    runningMs: 40 * MINUTE,
  })
  await task('t-b', bob.id, {
    status: 'failed',
    startedAt: T0 + 5 * HOUR,
    finishedAt: T0 + 6 * HOUR,
    runningMs: 10 * MINUTE,
  })
  await nodeRunFixture(db, {
    id: 'ra-design',
    taskId: 't-a',
    nodeId: 'design',
    status: 'done',
    startedAt: T0 + HOUR,
    finishedAt: T0 + HOUR + 20 * MINUTE,
  })
  await nodeRunFixture(db, {
    id: 'ra-code',
    taskId: 't-a',
    nodeId: 'code',
    status: 'done',
    startedAt: T0 + 2 * HOUR,
    finishedAt: T0 + 2 * HOUR + 20 * MINUTE,
  })
  await nodeRunFixture(db, {
    id: 'rb-design',
    taskId: 't-b',
    nodeId: 'design',
    status: 'failed',
    failureCode: 'timeout',
    startedAt: T0 + 5 * HOUR,
    finishedAt: T0 + 5 * HOUR + 10 * MINUTE,
  })

  // Calls go through the recorder every runtime caller uses, not through raw rows.
  const calls = composeRunObservationCalls(db)
  const record = async (
    id: string,
    at: number,
    target: { taskId: string; nodeRunId: string | null; systemKind?: string },
    usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ) => {
    await calls.accept({
      id,
      purpose: target.nodeRunId === null ? 'system' : 'task',
      taskId: target.taskId,
      nodeRunId: target.nodeRunId,
      systemKind: target.systemKind ?? null,
      agentId: null,
      agentName: 'assembled-agent',
      runtimeId: null,
      runtimeName: null,
      protocol: 'opencode',
      startedAt: at,
    })
    await calls.finish(id, {
      status: 'done',
      endedAt: at + MINUTE,
      usage: {
        state: 'complete',
        models: [
          {
            model: 'assembled-model',
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
            reasoning: 0,
          },
        ],
      },
    })
  }
  // t-a: 1,540 on design, 600 on code, 76 of platform work. t-b: 100 on design.
  await record(
    'c-a-design',
    T0 + HOUR,
    { taskId: 't-a', nodeRunId: 'ra-design' },
    {
      input: 1_000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 40,
    },
  )
  await record(
    'c-a-code',
    T0 + 2 * HOUR,
    { taskId: 't-a', nodeRunId: 'ra-code' },
    {
      input: 500,
      output: 100,
    },
  )
  await record(
    'c-a-memory',
    T0 + 3 * HOUR,
    { taskId: 't-a', nodeRunId: null, systemKind: 'memory-distiller' },
    { input: 70, output: 6 },
  )
  await record(
    'c-b-design',
    T0 + 5 * HOUR,
    { taskId: 't-b', nodeRunId: 'rb-design' },
    {
      input: 90,
      output: 10,
    },
  )
  return { alice, bob }
}

describeEachProvider('RFC-616 process metrics through the composed application', (harness) => {
  async function open() {
    const application = await openTestApplication(harness.applicationBinding, {
      token: DAEMON_TOKEN,
      dbVersion: 1,
    })
    const people = await seed(harness.db)
    const get = async <T>(path: string, token = DAEMON_TOKEN): Promise<T> => {
      const response = await application.app.request(path, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect([path, response.status]).toEqual([path, 200])
      return (await response.json()) as T
    }
    return { application, get, ...people }
  }

  test('one task shows the same tokens and cost on the process pages as on its run-observation page', async () => {
    const { get } = await open()
    const pageA = await get<ObservationTaskDetail>('/api/observability/tasks/t-a')
    const pageB = await get<ObservationTaskDetail>('/api/observability/tasks/t-b')
    expect([tokensOf(pageA.usage), tokensOf(pageB.usage)]).toEqual([2_216, 100])

    const units = await get<ProcessUnitPage>(`${BASE}/subjects/workflow/wf-asm/units?${WINDOW}`)
    // Newest first.
    expect(units.items.map((row) => [row.unitId, row.status, row.tokens, row.costNano])).toEqual([
      ['t-b', 'failed', tokensOf(pageB.usage), pageB.usage.costNano],
      ['t-a', 'succeeded', tokensOf(pageA.usage), pageA.usage.costNano],
    ])
    expect(units.nextCursor).toBeNull()

    const detail = await get<ProcessUnitDetail>(`${BASE}/units/workflow/t-a`)
    expect(detail.unit).toMatchObject({
      unitId: 't-a',
      taskId: 't-a',
      tokens: tokensOf(pageA.usage),
      costNano: pageA.usage.costNano,
      leadMs: 2 * HOUR,
      autoMs: 40 * MINUTE,
      otherMs: 80 * MINUTE,
      waits: [],
    })
    // Every token of the task sits on some stage: the two nodes and the platform work.
    expect(
      Object.fromEntries(
        detail.stages.filter((stage) => stage.tokens > 0).map((stage) => [stage.key, stage.tokens]),
      ),
    ).toEqual({ design: 1_540, code: 600, 'system:other': 76 })
  })

  test('the listing and the summary of the workflow are computed from the bound fact sources', async () => {
    const { get } = await open()
    const list = await get<ProcessSubjectList>(`${BASE}/subjects?kind=workflow&${WINDOW}`)
    expect(list).toMatchObject({ kind: 'workflow', scope: 'all', partial: false })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      subjectId: 'wf-asm',
      // The current name comes from the workflow catalogue.
      name: 'assembled flow',
      units: 2,
      successRate: 1 / 2,
      leadP50: 2 * HOUR,
      tokensPerUnit: (2_216 + 100) / 2,
    })

    const summary = await get<ProcessWorkflowSummary>(
      `${BASE}/subjects/workflow/wf-asm?${WINDOW}&tzOffset=0`,
    )
    expect(summary).toMatchObject({
      kind: 'workflow',
      subjectId: 'wf-asm',
      subjectName: 'assembled flow',
      scope: 'all',
      counts: { total: 2, succeeded: 1, failed: 1, canceled: 0, active: 0 },
      // The succeeded task: two hours from start to end, forty minutes of them running.
      time: {
        sampleUnits: 1,
        leadMs: 2 * HOUR,
        autoMs: 40 * MINUTE,
        waits: [],
        otherMs: 80 * MINUTE,
      },
    })
    expect(summary.metrics.tokensPerUnit?.value).toBe((2_216 + 100) / 2)
    expect(summary.metrics.successRate?.value).toBe(1 / 2)
    // The frozen definition of the newest task draws the stage list; platform work follows it.
    expect(summary.definition?.nodes.map((node) => node.id)).toEqual(['design', 'code'])
    const stage = (key: string) => summary.stages.find((row) => row.key === key)
    expect(stage('design')).toMatchObject({
      kind: 'agent-single',
      units: 2,
      tokensPerUnit: (1_540 + 100) / 2,
      failureRate: 1 / 2,
      topFailureCode: 'timeout',
    })
    // A stage is averaged over the units that reached it: only the first task ran `code`.
    expect(stage('code')).toMatchObject({ units: 1, tokensPerUnit: 600, failureRate: 0 })
    expect(stage('system:other')).toMatchObject({ kind: 'system', tokensPerUnit: 76 })
    expect(summary.stability.failureCodes).toEqual([{ code: 'timeout', runs: 1 }])
    // No one reviewed or answered anything, so there is nothing to show per person.
    expect(summary.review).toBeNull()
    expect(summary.clarify).toBeNull()
  })

  test('a member, through a real session, gets the statistics of their own tasks only', async () => {
    const { application, get, alice, bob } = await open()
    const list = await get<ProcessSubjectList>(
      `${BASE}/subjects?kind=workflow&${WINDOW}`,
      alice.token,
    )
    expect(list.scope).toBe('own')
    expect(list.items.map((row) => [row.subjectId, row.units, row.tokensPerUnit])).toEqual([
      ['wf-asm', 1, 2_216],
    ])
    const units = await get<ProcessUnitPage>(
      `${BASE}/subjects/workflow/wf-asm/units?${WINDOW}`,
      bob.token,
    )
    expect(units.items.map((row) => row.unitId)).toEqual(['t-b'])
    // Another member's task is not found, exactly like a task that does not exist.
    const foreign = await application.app.request(`${BASE}/units/workflow/t-a`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    })
    expect(foreign.status).toBe(404)
    const missing = await application.app.request(`${BASE}/units/workflow/t-none`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    })
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
  })

  test("a person's operation on an observed route is recorded and counted; a refused one and the daemon's own are not", async () => {
    const { application, get, alice, bob } = await open()
    const running = (id: string, startedAt: number) =>
      taskFixture(harness.db, {
        id,
        name: `task ${id}`,
        workflowId: 'wf-asm',
        workflowSnapshot: DEFINITION,
        repoPath: '/tmp/never-read',
        worktreePath: '/tmp/never-read',
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        inputs: '{}',
        ownerUserId: alice.id,
        status: 'running',
        startedAt,
      })
    await running('t-c', T0 + 8 * HOUR)
    await running('t-d', T0 + 9 * HOUR)
    const cancel = (taskId: string, token: string) =>
      application.app.request(`/api/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    const recorded = async () => {
      const { observationOperations } = tablesOf(harness.db)
      return (await harness.db.select().from(observationOperations)).map((row) => ({
        action: row.action,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        actorUserId: row.actorUserId,
        transport: row.transport,
      }))
    }

    // Bob is not a member of Alice's task: the cancel is refused, and a refused operation
    // is not something a person did.
    const refused = await cancel('t-c', bob.token)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(await recorded()).toEqual([])

    const before = Date.now()
    expect((await cancel('t-c', alice.token)).status).toBe(200)
    const rows = await recorded()
    expect(rows).toEqual([
      {
        action: 'task.cancel',
        subjectKind: 'task',
        subjectId: 't-c',
        actorUserId: alice.id,
        transport: 'http',
      },
    ])
    const { observationOperations } = tablesOf(harness.db)
    const [stored] = await harness.db.select().from(observationOperations)
    expect(Number(stored!.firstAt)).toBeGreaterThanOrEqual(before)
    expect(Number(stored!.lastAt)).toBe(Number(stored!.firstAt))

    // The daemon's own token is not a person: its cancel succeeds and leaves no row.
    expect((await cancel('t-d', DAEMON_TOKEN)).status).toBe(200)
    expect(await recorded()).toEqual(rows)

    // The recorded cancel is one human intervention of t-c; t-d has none.
    const summary = await get<ProcessWorkflowSummary>(
      `${BASE}/subjects/workflow/wf-asm?${WINDOW}&tzOffset=0`,
    )
    expect(summary.counts).toMatchObject({ total: 4, canceled: 2 })
    // Four ended tasks, one recorded operation among them.
    expect(summary.interventions.operationsPerUnit).toBe(1 / 4)
    expect(summary.metrics.interventionsPerUnit?.value).toBe(1 / 4)
  })

  test('asking for a text-theme analysis of a subject with nothing written answers "empty" and queues nothing', async () => {
    const { application } = await open()
    const response = await application.app.request(`${BASE}/subjects/workflow/wf-asm/insight`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: T0, to: T0 + 7 * DAY }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ id: '', status: 'empty' })
    const view = await application.app.request(
      `${BASE}/subjects/workflow/wf-asm/insight?${WINDOW}`,
      { headers: { Authorization: `Bearer ${DAEMON_TOKEN}` } },
    )
    expect(await view.json()).toMatchObject({
      schedule: 'manual',
      result: null,
      active: null,
      failure: null,
    })
  })
})
