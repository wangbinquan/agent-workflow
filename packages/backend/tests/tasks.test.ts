// HTTP coverage for /api/tasks (P-1-14).
// Uses a real `git init` fixture so startTask's worktree creation works.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { logicalRuns, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { writeEvent } from '../src/services/writeEvents'
import { runGit } from '../src/util/git'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  repoPath: string
  appHome: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-tasks-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'aw-tasks-repo-'))
  // Tests reuse Paths.root for worktrees / runs; route handlers read it lazily.
  const prevHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(appHome, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    repoPath,
    appHome,
    cleanup: () => {
      rmSync(appHome, { recursive: true, force: true })
      rmSync(repoPath, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    },
  }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function seedWorkflow(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const EMPTY_DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
}

describe('task HTTP routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('POST creates task with status=pending (scheduler still running in background)', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as { id: string; status: string; branch: string }
    expect(typeof task.id).toBe('string')
    expect(['pending', 'running', 'done']).toContain(task.status)
    expect(task.branch).toBe(`agent-workflow/${task.id}`)
  })

  test('POST with unknown workflow id -> 404', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: '01HFAKE',
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-not-found')
  })

  // Regression: proposal.md §静态校验 mandates "校验失败...阻止启动 task".
  // A workflow whose definition fails the 5-rule static validator must not
  // create a task row, must not touch the worktree, and must surface the
  // validator's issue list to the caller so the UI can show what to fix.
  test('POST with workflow that fails static validation -> 422 workflow-invalid; no task row created', async () => {
    // Edge points at a non-existent target node — that's a deterministic
    // edge-target-node-missing error from the validator.
    const badDef: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'in1', kind: 'input', inputKey: 'x' } as WorkflowDefinition['nodes'][number]],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'x' },
          target: { nodeId: 'ghost', portName: 'y' },
        },
      ],
    }
    const wfId = await seedWorkflow(h.db, badDef)
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      code: string
      details?: { issues?: Array<{ code: string }> }
    }
    expect(body.code).toBe('workflow-invalid')
    expect(body.details?.issues?.some((i) => i.code === 'edge-target-node-missing')).toBe(true)

    // No task row was created — validation gate must run before any side effects.
    const list = (await (await req(h.app, '/api/tasks')).json()) as Array<unknown>
    expect(list.length).toBe(0)
  })

  test('POST with non-git repo path creates a task with status=failed', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const notRepo = mkdtempSync(join(tmpdir(), 'aw-notrepo-'))
    try {
      const res = await req(h.app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: wfId,
          name: 'fixture-task',
          repoPath: notRepo,
          baseBranch: 'main',
          inputs: {},
        }),
      })
      expect(res.status).toBe(201)
      const task = (await res.json()) as { status: string; errorSummary: string | null }
      expect(task.status).toBe('failed')
      expect(task.errorSummary).toContain('worktree creation failed')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  test('GET /:id roundtrips; GET / lists; status filter narrows', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    // Create three tasks; vary status by direct insert (POST always starts as
    // pending/running so we can't observe filtering on POST alone).
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id: ulid(),
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt-a',
      baseBranch: 'main',
      branch: 'agent-workflow/A',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now() - 3000,
      finishedAt: Date.now() - 1000,
    })
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id: ulid(),
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt-b',
      baseBranch: 'main',
      branch: 'agent-workflow/B',
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now() - 2000,
      finishedAt: Date.now(),
    })

    const list = (await (await req(h.app, '/api/tasks')).json()) as Array<{ status: string }>
    expect(list.length).toBeGreaterThanOrEqual(2)

    const done = (await (await req(h.app, '/api/tasks?status=done')).json()) as Array<{
      status: string
    }>
    expect(done.every((t) => t.status === 'done')).toBe(true)
    expect(done.length).toBeGreaterThanOrEqual(1)
  })

  test('GET /api/tasks/:id unknown returns 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('task-not-found')
  })

  // Locks in the joined workflowName surfaces in both list + detail responses.
  // Without the join, the tasks page can only render the opaque ULID — users
  // can't tell at a glance which workflow a task came from.
  test('GET / and /:id include the joined workflow name', async () => {
    const wfId = ulid()
    const wfName = 'design-pipeline'
    await h.db.insert(workflows).values({
      id: wfId,
      name: wfName,
      definition: JSON.stringify(EMPTY_DEF),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const taskId = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id: taskId,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt-named',
      baseBranch: 'main',
      branch: 'agent-workflow/named',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })

    const list = (await (await req(h.app, '/api/tasks')).json()) as Array<{
      id: string
      workflowId: string
      workflowName: string | null
    }>
    const row = list.find((r) => r.id === taskId)
    expect(row).toBeDefined()
    expect(row?.workflowName).toBe(wfName)

    const detail = (await (await req(h.app, `/api/tasks/${taskId}`)).json()) as {
      workflowName: string | null
    }
    expect(detail.workflowName).toBe(wfName)
  })

  test('POST invalid body returns 422', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: '',
        name: 'fixture-task',
        repoPath: '',
        baseBranch: '',
        inputs: {},
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('task-invalid')
  })

  test('POST /:id/cancel on a completed task -> 409 task-not-cancelable', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-not-cancelable')
  })

  test('POST /:id/cancel on an unknown task -> 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('POST /:id/cancel on a stuck-running task (no active controller) flips to canceled', async () => {
    // Simulate a row left in 'running' state without an in-process controller
    // (e.g. after daemon restart). The cancel endpoint should still mark it
    // canceled rather than block forever.
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now() - 1000,
    })
    const res = await req(h.app, `/api/tasks/${id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    const task = (await res.json()) as { status: string; errorSummary: string }
    expect(task.status).toBe('canceled')
    expect(task.errorSummary).toContain('canceled')
  })

  test('all /api/tasks/* require token', async () => {
    expect((await h.app.request('/api/tasks')).status).toBe(401)
  })

  test('GET /:id/node-runs returns empty for a freshly-started task', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id } = (await post.json()) as { id: string }
    const res = await req(h.app, `/api/tasks/${id}/node-runs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: unknown[]; outputs: unknown[] }
    expect(Array.isArray(body.runs)).toBe(true)
    expect(Array.isArray(body.outputs)).toBe(true)
    // Empty workflow → scheduler may have inserted 0 runs by the time we
    // check; either way the shape is valid.
    expect(body.outputs.length).toBe(0)
  })

  test('GET /:id/node-runs on unknown task -> 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE/node-runs')
    expect(res.status).toBe(404)
  })

  test('GET /:id/diff returns the worktree diff vs baseCommit', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id, worktreePath } = (await post.json()) as {
      id: string
      worktreePath: string
    }

    // Modify a tracked file in the worktree to produce a real diff.
    writeFileSync(join(worktreePath, 'README.md'), '# changed\n')

    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      diff: string
      baseCommit: string | null
      truncated: boolean
    }
    expect(body.baseCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(body.truncated).toBe(false)
    expect(body.diff).toContain('README.md')
    expect(body.diff).toContain('# changed')
  })

  test('GET /:id/diff includes untracked files', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        name: 'fixture-task',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id, worktreePath } = (await post.json()) as { id: string; worktreePath: string }
    writeFileSync(join(worktreePath, 'NEWFILE.md'), 'fresh\n')

    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { diff: string }
    expect(body.diff).toContain('NEWFILE.md')
    expect(body.diff).toContain('fresh')
  })

  test('GET /:id/diff on a task without baseCommit -> 409', async () => {
    // Simulate the early-error path where startTask couldn't even create the
    // worktree (repo missing, base ref invalid, etc.).
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-no-base-commit')
  })

  test('GET /:id/diff when worktree dir is missing -> 410', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/aw-nope-' + id,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: 'deadbeef'.repeat(5),
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(410)
    expect(((await res.json()) as { code: string }).code).toBe('task-worktree-missing')
  })

  // RFC-061 cleanup: the events endpoint now reads from the events
  // projection table; the legacy node_runs / node_run_events tables
  // are no longer populated by the actor. We seed via writeEvent and
  // expect the synthesised numeric ids to honour ?since semantics.
  test('GET /:id/node-runs/:nodeRunId/events paginates with ?since', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const taskId = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',
      id: taskId,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const baseScope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 } as const
    const lrCreated = await writeEvent(h.db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...baseScope,
    })
    const lrId = lrCreated.id
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      ...baseScope,
      attemptId,
    })
    for (let i = 0; i < 5; i++) {
      await writeEvent(h.db, {
        taskId,
        kind: 'attempt-subagent-output',
        payload: { sessionId: 'sub', content: `chunk-${i}` },
        actor: 'system',
        ...baseScope,
        attemptId,
      })
    }

    const r1 = await req(h.app, `/api/tasks/${taskId}/node-runs/${lrId}/events`)
    expect(r1.status).toBe(200)
    const body1 = (await r1.json()) as { events: Array<{ id: number }>; cursor: number | null }
    // attempt-started → 'step_start' + 5 × attempt-subagent-output → 'text' = 6
    expect(body1.events.length).toBe(6)
    expect(body1.cursor).toBe(body1.events[5]?.id ?? null)

    const mid = body1.events[3]?.id ?? 0
    const r2 = await req(h.app, `/api/tasks/${taskId}/node-runs/${lrId}/events?since=${mid}`)
    const body2 = (await r2.json()) as { events: Array<{ id: number }> }
    expect(body2.events.length).toBe(2)
    expect(body2.events[0]?.id).toBe(body1.events[4]?.id)
  })

  test('GET node-runs events refuses a node_run that belongs to a different task -> 404', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const idA = ulid()
    const idB = ulid()
    await h.db.insert(tasks).values([
      {
        id: idA,
        name: 'fixture-task',
        workflowId: wfId,
        workflowSnapshot: '{}',
        repoPath: h.repoPath,
        worktreePath: '/tmp/a',
        baseBranch: 'main',
        branch: `agent-workflow/${idA}`,
        status: 'running',
        inputs: '{}',
        startedAt: Date.now(),
      },
      {
        id: idB,
        name: 'fixture-task',
        workflowId: wfId,
        workflowSnapshot: '{}',
        repoPath: h.repoPath,
        worktreePath: '/tmp/b',
        baseBranch: 'main',
        branch: `agent-workflow/${idB}`,
        status: 'running',
        inputs: '{}',
        startedAt: Date.now(),
      },
    ])
    const lrCreated = await writeEvent(h.db, {
      taskId: idA,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n1',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    const lrA = lrCreated.id
    const res = await req(h.app, `/api/tasks/${idB}/node-runs/${lrA}/events`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('node-run-not-found')
  })

  test('POST /:id/resume on a non-failed task → 409', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/resume`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-not-resumable')
  })

  test('POST /:id/nodes/:nrId/retry while task is running → 409', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const nrId = ulid()
    await h.db.insert(nodeRuns).values({
      id: nrId,
      taskId: id,
      nodeId: 'n1',
      status: 'failed',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/nodes/${nrId}/retry`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-still-running')
  })

  test('POST /:id/nodes/:nrId/retry on a failed task flips status → pending + bumps iter', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',
      id,
      workflowId: wfId,
      workflowSnapshot: JSON.stringify({
        $schema_version: 1,
        inputs: [],
        nodes: [{ id: 'n1', kind: 'agent-single' }],
        edges: [],
      }),
      repoPath: h.repoPath,
      worktreePath: '', // empty so retry skips rollback
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      errorSummary: 'boom',
    })
    // RFC-061 follow-up: seed via writeEvent so retryNode finds a real
    // logical_run row. Mint logical-run-created at iter=0, then mark it
    // failed via attempt-finished-crash.
    const scope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 } as const
    const lrEvt = await writeEvent(h.db, {
      taskId: id,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...scope,
    })
    const lrId = lrEvt.id
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId: id,
      kind: 'attempt-started',
      payload: { preSnapshot: 'snap-pre' },
      actor: 'system',
      ...scope,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId: id,
      kind: 'attempt-finished-crash',
      payload: { exitCode: 1, errorMessage: 'boom' },
      actor: 'system',
      ...scope,
      attemptId,
    })
    // Force the logical_run into 'failed' status (the actor would do this
    // via retry-pending-* SignalKind; for the test we mark it directly to
    // exercise the retryNode path on a terminal failed lr).
    await h.db
      .update(logicalRuns)
      .set({ status: 'failed' })
      .where(eq(logicalRuns.id, lrId))

    const res = await req(h.app, `/api/tasks/${id}/nodes/${lrId}/retry?cascade=false`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; errorSummary: string | null }
    expect(body.status).toBe('pending')
    expect(body.errorSummary).toBeNull()
    // A new logical_run at iter=1 should now exist for n1.
    const after = await h.db
      .select()
      .from(logicalRuns)
      .where(and(eq(logicalRuns.taskId, id), eq(logicalRuns.nodeId, 'n1')))
    expect(after.length).toBe(2)
    expect(after.some((r) => r.iter === 1)).toBe(true)
  })

  // RFC-061 follow-up: cascade matrix replacement for the deleted
  // retry-cascade-kind-matrix + retry-node-no-review-cascade tests.
  // Verifies retryNode honours NODE_KIND_BEHAVIORS[kind].retryCascade —
  // downstream agent gets iter-bumped, downstream review/clarify do not.
  test('POST retry?cascade=true bumps downstream agents but skips downstream review/clarify', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      name: 'fixture-task',
      id,
      workflowId: wfId,
      workflowSnapshot: JSON.stringify({
        $schema_version: 2,
        inputs: [],
        nodes: [
          { id: 'A', kind: 'agent-single' },
          { id: 'B', kind: 'agent-single' },
          { id: 'R', kind: 'review' },
          { id: 'C', kind: 'clarify' },
        ],
        edges: [
          { id: 'e1', source: { nodeId: 'A', portName: 'out' }, target: { nodeId: 'B', portName: 'in' } },
          { id: 'e2', source: { nodeId: 'A', portName: 'out' }, target: { nodeId: 'R', portName: 'doc' } },
          { id: 'e3', source: { nodeId: 'A', portName: 'out' }, target: { nodeId: 'C', portName: 'in' } },
        ],
      }),
      repoPath: h.repoPath,
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      errorSummary: 'boom',
    })
    // Seed logical_runs at iter=0 for all four nodes.
    const seedLr = async (nodeId: string): Promise<string> => {
      const ev = await writeEvent(h.db, {
        taskId: id,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId,
        loopIter: 0,
        shardKey: '',
        iter: 0,
      })
      return ev.id
    }
    const aLrId = await seedLr('A')
    await seedLr('B')
    await seedLr('R')
    await seedLr('C')
    // Force A into 'failed' so retry validates.
    await h.db.update(logicalRuns).set({ status: 'failed' }).where(eq(logicalRuns.id, aLrId))

    const res = await req(h.app, `/api/tasks/${id}/nodes/${aLrId}/retry`, { method: 'POST' })
    expect(res.status).toBe(200)

    // A and B (agent kinds) should have a fresh iter=1 row; R and C should not.
    const after = await h.db.select().from(logicalRuns).where(eq(logicalRuns.taskId, id))
    const byNode = new Map<string, number[]>()
    for (const r of after) {
      const list = byNode.get(r.nodeId) ?? []
      list.push(r.iter)
      byNode.set(r.nodeId, list)
    }
    expect(byNode.get('A')?.sort()).toEqual([0, 1])
    expect(byNode.get('B')?.sort()).toEqual([0, 1])
    expect(byNode.get('R')).toEqual([0])
    expect(byNode.get('C')).toEqual([0])
  })
})
