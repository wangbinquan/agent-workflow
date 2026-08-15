// RFC-304 PR-0 (T0b) — the `code-round` execution kind's go/no-go.
//
// PR-0 exists to answer ONE question before the rest of RFC-304 is built on it:
// can a code-capability round be an ordinary task? The RFC's whole design rests
// on reusing the task engine (cancel, retry, interrupted-repair, resource
// limits, the detail page) instead of calling `runSystemAgent` and reimplementing
// each of those — design §D5. If a round cannot be a task, the plan's foundation
// is wrong and D5 has to pick a different fallback, so this file is a gate, not
// a regression net: plan.md §PR-0 says "T0b 三条路径全绿才进 PR-1a".
//
// The three paths, and why these three:
//   T0b-1 start    — a round lands as a real row with a real kind and a frozen
//                    snapshot the detail page can draw.
//   T0b-2 cancel   — the generic cancel verb reaches it (nothing about a round
//                    is special enough to need its own cancel).
//   T0b-3 recover  — a daemon restart's auto-resume sweep picks it up. This one
//                    is the least obvious and the most load-bearing: rounds run
//                    for minutes across restarts, and a kind the sweep skips
//                    would wedge forever with no user-visible cause.
//
// Plus the two silent-failure shapes this work uncovered, locked so they cannot
// come back:
//   - outcome projection must read the round's own node (before the explicit
//     branch, a round fell into the WORKGROUP arm and returned `done` with empty
//     outputs blamed on an unparsable workgroup config it never had);
//   - `OutcomeTaskRow` must actually SELECT `code_round_id` — every discriminator
//     field of `taskExecutionKind` is optional, so a caller that forgets one gets
//     a silent misclassification instead of a type error.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DAEMON_RESTART_ERROR_SUMMARY, taskExecutionKind } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { tasks, workflows } from '../src/db/schema'
import {
  CODE_ROUND_HOST_WORKFLOW_ID,
  CODE_ROUND_NODE_ID,
  ensureCodeRoundHostWorkflow,
  startCodeRoundTask,
  synthesizeCodeRoundSnapshot,
} from '../src/services/codeRoundLaunch'
import { cancelTask } from '../src/services/task'
import { projectExecutionOutcome } from '../src/services/execution/outcome'
import { autoResumeInterruptedTasks } from '../src/services/autoResume'
import { startExecution } from '../src/services/execution/executor'
import type { Actor } from '../src/auth/actor'
import type { DbClient as ExecDbClient } from '../src/db/client'
import type { StartTaskDeps } from '../src/services/task'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-304 T0b — code-round is a task (go/no-go)', () => {
  let db: DbClient
  let appHome: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-round-'))
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const launch = async (over: Partial<Parameters<typeof startCodeRoundTask>[0]> = {}) =>
    await startCodeRoundTask(
      {
        roundId: ulid(),
        capability: 'mr-review',
        roundSeq: 1,
        name: 'MR review round 1',
        // Space fields belong to the INPUT, not the deps — they ride
        // LaunchSpaceFields through applySpaceFields.
        scratch: true,
        ...over,
      },
      {
        db,
        appHome,
        // RFC-301: every root launch carries trusted provenance, and the
        // webhook flavor additionally demands trigger/fire ids + canonical
        // context. A round's REAL provenance is whatever drove its work item
        // (usually a webhook, sometimes a person re-running from /code), and
        // the executor derives it from the invoker — wiring that is PR-1a's
        // job. PR-0 states the simplest valid provenance so the three paths
        // under test are about the execution kind, not about attribution.
        launchProvenance: { kind: 'direct-json', initiator: 'api' },
      } as never,
    )

  test('T0b-1 start: a round lands as a task with kind code-round and a drawable snapshot', async () => {
    const task = await launch()

    expect(task.status).toBe('pending')
    // The FK anchor is the builtin host row, exactly like agent/workgroup hosts.
    expect(task.workflowId).toBe(CODE_ROUND_HOST_WORKFLOW_ID)
    // The whole point of the discriminator: this must NOT read as 'workflow'.
    expect(taskExecutionKind(task)).toBe('code-round')
    expect(task.codeRoundId).not.toBeNull()

    const snapshot = task.workflowSnapshot as {
      nodes: Array<{ id: string; kind: string; capability?: string; roundSeq?: number }>
    }
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]?.id).toBe(CODE_ROUND_NODE_ID)
    expect(snapshot.nodes[0]?.kind).toBe('code-round')
    // The two facts the canvas card renders — a snapshot without them draws an
    // em-dash placeholder (the RFC-253 shape).
    expect(snapshot.nodes[0]?.capability).toBe('mr-review')
    expect(snapshot.nodes[0]?.roundSeq).toBe(1)
  })

  test('T0b-1b the host anchor is seeded lazily and idempotently', async () => {
    // Not a migration seed: a migration-seeded row shows up in every fresh DB
    // and breaks empty-fixture expectations (the agentLaunch precedent).
    const before = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, CODE_ROUND_HOST_WORKFLOW_ID))
    expect(before).toHaveLength(0)

    await ensureCodeRoundHostWorkflow(db)
    await ensureCodeRoundHostWorkflow(db)

    const after = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, CODE_ROUND_HOST_WORKFLOW_ID))
    expect(after).toHaveLength(1)
    expect(after[0]?.builtin).toBe(true)
  })

  test('T0b-2 cancel: the generic cancel verb reaches a round', async () => {
    const task = await launch()
    await cancelTask(db, task.id)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row?.status).toBe('canceled')
    // Cancel must not disturb the discriminator — a canceled round is still a
    // round, and the /code view reads this row to decide what to show.
    expect(taskExecutionKind(row!)).toBe('code-round')
  })

  test('T0b-3 recover: a daemon restart auto-resumes an interrupted round', async () => {
    const task = await launch()
    // Exactly what the restart reaper leaves behind.
    await db
      .update(tasks)
      .set({ status: 'interrupted', errorSummary: DAEMON_RESTART_ERROR_SUMMARY })
      .where(eq(tasks.id, task.id))

    const resumed: string[] = []
    const result = await autoResumeInterruptedTasks({
      db,
      breaker: { shouldSkip: () => false, onSuccess: () => {}, onFailure: () => {} } as never,
      resume: async (id: string) => {
        resumed.push(id)
      },
      retryRepoPrep: async () => {},
    } as never)

    // The sweep filters on status + errorSummary and NOT on kind — that is what
    // makes a new execution kind recoverable the day it is added rather than the
    // day someone remembers to add it to a list.
    expect(resumed).toContain(task.id)
    expect(result.skipped).not.toContain(task.id)
  })

  test('outcome reads the round node — not the workgroup arm', async () => {
    // The regression this locks: with the workgroup arm as the bare `else`, a
    // done round returned `outputs: {}` + 'workgroup-config-unparsable'. Both
    // halves matter — empty outputs AND a warning naming a subsystem the task
    // has nothing to do with, which is what makes it unsearchable in a log.
    const outcome = projectExecutionOutcome({
      task: {
        id: 't1',
        status: 'done',
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        workflowSnapshot: synthesizeCodeRoundSnapshot({
          capability: 'mr-review',
          roundSeq: 1,
          title: 'r',
        }),
        codeRoundId: 'round_1',
      },
      runs: [
        {
          id: 'nr1',
          nodeId: CODE_ROUND_NODE_ID,
          iteration: 0,
          parentNodeRunId: null,
          status: 'done',
        },
      ],
      outputs: [
        {
          nodeRunId: 'nr1',
          portName: 'round_summary',
          content: '{"capability":"mr-review"}',
          kind: null,
        },
      ],
      workgroup: null,
    })

    expect(outcome.outputs.round_summary?.content).toBe('{"capability":"mr-review"}')
    expect(outcome.warnings).toEqual([])
  })

  test('a round row that forgot to select code_round_id is the silent-failure shape', () => {
    // Documents WHY OutcomeTaskRow carries the field and why callers must select
    // it: omitting it is not a type error, it is a wrong answer. If this ever
    // starts failing because the omission became loud, delete the test — but do
    // not "fix" it by making the assertion match a still-silent outcome.
    const withoutDiscriminator = projectExecutionOutcome({
      task: {
        id: 't1',
        status: 'done',
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        workflowSnapshot: synthesizeCodeRoundSnapshot({
          capability: 'mr-review',
          roundSeq: 1,
          title: 'r',
        }),
        // codeRoundId deliberately omitted
      },
      runs: [
        {
          id: 'nr1',
          nodeId: CODE_ROUND_NODE_ID,
          iteration: 0,
          parentNodeRunId: null,
          status: 'done',
        },
      ],
      outputs: [{ nodeRunId: 'nr1', portName: 'round_summary', content: 'x', kind: null }],
      workgroup: null,
    })
    // Misread as a plain workflow task ⇒ looks for `output` nodes, finds none.
    expect(withoutDiscriminator.outputs).toEqual({})
    expect(withoutDiscriminator.status).toBe('done')
  })
})

describe('RFC-304 T0b — the executor dispatches the fourth kind', () => {
  // Guard paths throw before touching db/actor/deps, same shape as the RFC-243
  // facade guards these mirror.
  const stubDb = null as unknown as ExecDbClient
  const stubActor = { user: { id: 'u1' } } as unknown as Actor
  const stubDeps = {} as unknown as StartTaskDeps

  test('ref/payload mismatch → execution-ref-mismatch, same as the workflow kind', async () => {
    // `refId` IS the round id for this kind, so a disagreement is a caller bug
    // — surfaced, not reconciled by silently preferring one side.
    await expect(
      startExecution(
        stubDb,
        stubActor,
        {
          kind: 'code-round',
          refId: 'round-a',
          invoker: { type: 'user', launchKind: 'direct-json' },
          payload: {
            roundId: 'round-b',
            capability: 'mr-review',
            roundSeq: 1,
            name: 'r',
            scratch: true,
          },
        },
        stubDeps,
      ),
    ).rejects.toMatchObject({ code: 'execution-ref-mismatch' })
  })

  test('a node invoker cannot launch a round', async () => {
    // Rounds are minted by a work item's state machine, never by a call node
    // inside another task — the call-node path is workflow-only by contract.
    await expect(
      startExecution(
        stubDb,
        stubActor,
        {
          kind: 'code-round',
          refId: 'round-a',
          invoker: {
            type: 'node',
            parentTaskId: 't1',
            parentNodeRunId: 'r1',
            invocationDepth: 1,
          },
          payload: {
            roundId: 'round-a',
            capability: 'mr-review',
            roundSeq: 1,
            name: 'r',
            scratch: true,
          },
        },
        stubDeps,
      ),
    ).rejects.toMatchObject({ code: 'execution-invoker-unsupported' })
  })
})

describe('RFC-304 T0b — route guards treat a round like the other host kinds', () => {
  // These two guards are easy to get wrong in OPPOSITE directions, so both are
  // asserted: the builtin lock must NOT swallow a round (its FK anchor is a
  // builtin row, so the naive path 403s every resume/retry and leaves a stuck
  // round with no recovery endpoint), while sync-workflow MUST refuse it (a
  // synthesized snapshot has no authored workflow to sync from).
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let appHome: string
  let adminToken: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-http-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: 'a'.repeat(64),
      configPath: join(appHome, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'alice',
      displayName: 'alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    adminToken = (await createSession({ db, userId: admin.id })).token
    await ensureCodeRoundHostWorkflow(db)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${adminToken}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return await app.request(path, { ...init, headers })
  }

  const seedRoundTask = async (): Promise<string> => {
    const id = ulid()
    await db.insert(tasks).values({
      id,
      name: 'round fixture',
      workflowId: CODE_ROUND_HOST_WORKFLOW_ID,
      workflowSnapshot: synthesizeCodeRoundSnapshot({
        capability: 'mr-review',
        roundSeq: 1,
        title: 'round fixture',
      }),
      codeRoundId: ulid(),
      repoPath: appHome,
      worktreePath: appHome,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    } as never)
    return id
  }

  test('the builtin lock does NOT swallow a round: resume is reachable', async () => {
    const id = await seedRoundTask()
    const res = await req(`/api/tasks/${id}/resume`, { method: 'POST' })
    const body = (await res.json()) as { code?: string }
    // It may still fail for other reasons (no live worktree in this fixture);
    // anything BUT builtin-readonly proves the carve-out — same assertion shape
    // the agent-host case uses.
    expect(body.code).not.toBe('builtin-readonly')
  })

  test('sync-workflow refuses a round with task-host-sync-unsupported', async () => {
    const id = await seedRoundTask()
    const res = await req(`/api/tasks/${id}/sync-workflow`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('task-host-sync-unsupported')
  })
})
