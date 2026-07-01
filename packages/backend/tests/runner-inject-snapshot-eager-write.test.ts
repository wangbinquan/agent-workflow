// RFC-047 — locks the runner's EAGER write path for
// `node_runs.injected_memories_json`:
//   - Normal agent run with approved memories present → column populated AND
//     a `node.status: running` broadcast fires *after* inject, *before* the
//     final run-end UPDATE.
//   - Null snapshot (no approved memories) → column written as NULL eagerly,
//     broadcast still fires (so the Session-tab card still moves out of its
//     "pre-RFC-046 not captured" placeholder state).
//   - Envelope-followup retry → column is eagerly populated by copying the
//     attempt-0 sibling JSON (no fresh inject; same value as the final
//     UPDATE).
//   - Early-write SQL throws → run does NOT fail; final run-end UPDATE still
//     persists the snapshot (≡ legacy RFC-046 behavior).
//
// "Eagerness" is verified at the WS layer rather than by racing the SQL
// statement: the broadcaster receives the `node.status: running` event before
// the runner returns. The grep guard test
// `runner-inject-snapshot-eager-write-source.test.ts` separately locks that
// the UPDATE statement physically precedes the final UPDATE in source order.

import type { Agent, TaskWsMessage } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
const ulid = monotonicFactory() // RFC-074 PR-C: monotonic ids for synchronous test seeding (pure-id freshness)
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { TASK_CHANNEL, resetBroadcastersForTests, taskBroadcaster } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: '',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc047-runner-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  overrides: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    ...overrides,
  })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
}

describe('RFC-047 runner eager-writes injected_memories_json before opencode spawn', () => {
  let h: Harness
  let received: TaskWsMessage[]
  let unsub: (() => void) | null = null

  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
    received = []
    unsub = taskBroadcaster.subscribe(TASK_CHANNEL(h.taskId), (m) => received.push(m))
  })
  afterEach(() => {
    unsub?.()
    unsub = null
    h.cleanup()
  })

  test('E1: normal path — eager broadcast fires once and column ends populated', async () => {
    await h.db
      .insert(memories)
      .values({
        id: 'mem_g1',
        scopeType: 'global',
        scopeId: null,
        title: 'G',
        bodyMd: 'general',
        tags: JSON.stringify(['g']),
        status: 'approved',
        sourceKind: 'review',
        version: 1,
        approvedAt: 1_700_000_000_000,
        createdAt: Date.now(),
      })
      .run()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    // The eager broadcast is a `node.status: running` event tagged with our
    // nodeRunId. Since RFC-036 (`397d525 fix(ws): RFC-036 接 resolveActor`)
    // also wired a throttled `node.status: running` re-ping inside
    // stdoutPump, the count may now be > 1 — we just lock that the eager
    // broadcast at least fires.
    const runningEvents = received.filter(
      (m) => m.type === 'node.status' && m.nodeRunId === nodeRunId && m.status === 'running',
    )
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    // Final column also persisted.
    const rows = await h.db.select({ json: nodeRuns.injectedMemoriesJson }).from(nodeRuns)
    const target = rows.find(() => true) // single row in this harness
    expect(target?.json).not.toBeNull()
    const parsed = JSON.parse(target!.json!)
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe('mem_g1')
  })

  test('E2: null snapshot (no approved memories) — broadcast still fires, column stays NULL', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )
    const runningEvents = received.filter(
      (m) => m.type === 'node.status' && m.nodeRunId === nodeRunId && m.status === 'running',
    )
    // RFC-036's throttled re-ping inside stdoutPump may fire alongside the
    // eager broadcast; assert "at least once" instead of "exactly once".
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    const rows = await h.db.select({ json: nodeRuns.injectedMemoriesJson }).from(nodeRuns)
    expect(rows[0]?.json).toBeNull()
  })

  test('E3: envelope-followup — eager write copies attempt-0 snapshot', async () => {
    const attempt0Json = JSON.stringify([
      {
        id: 'attempt0_mem',
        version: 7,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'A',
        bodyMd: 'b',
        tags: [],
        sourceKind: 'manual',
        approvedAt: null,
      },
    ])
    // Attempt 0 ran inject (snapshot persisted) then FAILED an envelope check —
    // the only state that triggers an envelope-followup. RFC-074 PR-C: the
    // generation anchor walks by id and treats this `failed` predecessor as
    // same-generation, so the followup copies THIS attempt's snapshot.
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-x',
      retryIndex: 0,
      status: 'failed',
      injectedMemoriesJson: attempt0Json,
      opencodeSessionId: 'sess_resume',
    })
    const followupId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'agent-x',
      retryIndex: 1,
      status: 'pending',
    })
    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId: followupId,
          nodeId: 'agent-x',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
          envelopeFollowup: true,
          resumeSessionId: 'sess_resume',
          envelopeFollowupReason: 'envelope-missing',
        }),
    )
    const runningEvents = received.filter(
      (m) => m.type === 'node.status' && m.nodeRunId === followupId && m.status === 'running',
    )
    // See E1's note — RFC-036 throttled re-ping may fire too.
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    const rows = await h.db
      .select({ id: nodeRuns.id, json: nodeRuns.injectedMemoriesJson })
      .from(nodeRuns)
    const followup = rows.find((r) => r.id === followupId)
    expect(followup?.json).not.toBeNull()
    const parsed = JSON.parse(followup!.json!)
    expect(parsed[0].id).toBe('attempt0_mem')
    expect(parsed[0].version).toBe(7)
  })

  test('E4: eager-write SQL throws — run survives, final UPDATE persists snapshot', async () => {
    await h.db
      .insert(memories)
      .values({
        id: 'mem_g_e4',
        scopeType: 'global',
        scopeId: null,
        title: 'G',
        bodyMd: 'body',
        tags: JSON.stringify([]),
        status: 'approved',
        sourceKind: 'review',
        version: 1,
        approvedAt: 1_700_000_000_000,
        createdAt: Date.now(),
      })
      .run()
    const nodeRunId = await insertNodeRun(h.db, h.taskId)

    // Wrap db.update so the FIRST call that targets ONLY `injectedMemoriesJson`
    // throws — that is precisely the eager-write site. Subsequent updates
    // (e.g. the final run-end UPDATE with status/finishedAt/etc.) pass through
    // to the underlying drizzle client.
    const realUpdate = h.db.update.bind(h.db)
    let eagerWriteIntercepted = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(h.db as any).update = (table: any) => {
      const builder = realUpdate(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const realSet = (builder as any).set.bind(builder)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(builder as any).set = (payload: any) => {
        const keys = Object.keys(payload ?? {})
        if (!eagerWriteIntercepted && keys.length === 1 && keys[0] === 'injectedMemoriesJson') {
          eagerWriteIntercepted = true
          // Return an object whose .where() throws so the runner's try/catch
          // sees the failure exactly where the eager UPDATE would happen.
          return {
            where: () => {
              throw new Error('e4-eager-write-forced-failure')
            },
          }
        }
        return realSet(payload)
      }
      return builder
    }

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )

    expect(eagerWriteIntercepted).toBe(true)
    // RFC-098 B3 (audit S-28): the `node.status: running` ping is no longer
    // coupled to the eager UPDATE's try block — it moved BELOW the
    // mark-running CAS (DB-first rule, lifecycle.ts), so it fires exactly
    // because the row really is running, regardless of the eager-write
    // failure. Expected events: the post-CAS ping (always), plus at most
    // RFC-036's throttled re-ping from the stdoutPump text event. Paired
    // with `eagerWriteIntercepted === true` above (the eager block really
    // threw), this locks the new decoupling: an eager-write failure must
    // NOT suppress the post-CAS status broadcast.
    const runningEvents = received.filter(
      (m) => m.type === 'node.status' && m.nodeRunId === nodeRunId && m.status === 'running',
    )
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    expect(runningEvents.length).toBeLessThanOrEqual(2)
    // Final UPDATE still landed — column visible to the UI at end-of-run
    // (i.e. legacy RFC-046 behavior).
    const rows = await h.db.select({ json: nodeRuns.injectedMemoriesJson }).from(nodeRuns)
    expect(rows[0]?.json).not.toBeNull()
    const parsed = JSON.parse(rows[0]!.json!)
    expect(parsed[0].id).toBe('mem_g_e4')
  })
})
