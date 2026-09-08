// RFC-359 W12 — the composed realtime runtime replays real persisted task
// events. Both provider factories are called; the database and event queries
// are real. Unused composition inputs throw if accessed beyond construction.

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { TaskWsMessage } from '@agent-workflow/shared'

import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '@/db/schema'
import type { DirectAuthorityAdmission } from '@/modules/identity-access/public/participants'
import {
  composePostgresqlRealtimeRuntime,
  composeSqliteRealtimeRuntime,
} from '@/modules/runtime-management/composition'
import type {
  RealtimeCompositionPolicy,
  RealtimeRuntime,
} from '@/modules/runtime-management/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

function unusedCapability<T extends object>(name: string, constants: Partial<T> = {}): T {
  return new Proxy(constants, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key)
      throw new Error(`replay fixture used ${name}.${String(key)}`)
    },
  }) as T
}

function unused(): never {
  throw new Error('replay fixture used an unrelated channel operation')
}

function runtimeFor(harness: ProviderHarness): RealtimeRuntime {
  const auth = unusedCapability<AuthRuntime>('auth', { allowLegacyDaemonTestAccess: false })
  const directAuthority = unusedCapability<DirectAuthorityAdmission>('directAuthority')
  const policy: RealtimeCompositionPolicy = {
    resourceVisibility: { canViewResource: unused },
    memoryVisibility: { canViewMemory: unused },
    repoImportOwnerUserId: unused,
    redactTaskEventPayload: (payload) => payload,
  }
  return harness.capabilities.isolation === 'exclusive'
    ? composeSqliteRealtimeRuntime({ db: harness.db as DbClient, auth, directAuthority, policy })
    : composePostgresqlRealtimeRuntime({
        db: harness.db as PostgresqlDatabaseClient,
        auth,
        directAuthority,
        policy,
      })
}

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const taskId = ulid()
  const workflowId = ulid()
  const definition = JSON.stringify({
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  })
  await db.insert(workflows).values({
    id: workflowId,
    name: 'realtime composition',
    definition,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'realtime composition',
    workflowId,
    workflowSnapshot: definition,
    repoPath: '/repo',
    worktreePath: '/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  return taskId
}

async function seedRun(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: `node-${id}`,
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: 1,
  })
  return id
}

describeEachProvider('RFC-359 W12 — realtime runtime composition', (harness) => {
  test('replay decodes real payloads across runs in event-id order and resumes after the cursor', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const otherTaskId = await seedTask(db)
    const runA = await seedRun(db, taskId)
    const runB = await seedRun(db, taskId)
    const otherRun = await seedRun(db, otherTaskId)
    const runtime = runtimeFor(harness)
    // Timestamps are deliberately out of order: the replay cursor is event id.
    const rows = await db
      .insert(nodeRunEvents)
      .values([
        { nodeRunId: runA, ts: 40, kind: 'text', payload: '{"text":"first"}' },
        { nodeRunId: runB, ts: 10, kind: 'text', payload: '["second",2]' },
        { nodeRunId: otherRun, ts: 30, kind: 'text', payload: '{"text":"other"}' },
        { nodeRunId: runA, ts: 20, kind: 'stderr', payload: 'plain diagnostic' },
      ])
      .returning({ id: nodeRunEvents.id, payload: nodeRunEvents.payload })
    const ids = new Map(rows.map((row) => [row.payload, row.id]))
    const expected: TaskWsMessage[] = [
      {
        id: ids.get('{"text":"first"}')!,
        type: 'node.event',
        nodeRunId: runA,
        ts: 40,
        kind: 'text',
        payload: { text: 'first' },
      },
      {
        id: ids.get('["second",2]')!,
        type: 'node.event',
        nodeRunId: runB,
        ts: 10,
        kind: 'text',
        payload: ['second', 2],
      },
      {
        id: ids.get('plain diagnostic')!,
        type: 'node.event',
        nodeRunId: runA,
        ts: 20,
        kind: 'stderr',
        payload: 'plain diagnostic',
      },
    ]
    expect(await runtime.channels.replayTaskEvents('session', taskId, 0)).toEqual(expected)
    expect(
      await runtime.channels.replayTaskEvents('session', taskId, ids.get('{"text":"first"}')!),
    ).toEqual(expected.slice(1))
    expect(
      await runtime.channels.replayTaskEvents('session', taskId, ids.get('plain diagnostic')!),
    ).toEqual([])
    expect(await runtime.channels.replayTaskEvents('session', otherTaskId, 0)).toEqual([
      {
        id: ids.get('{"text":"other"}')!,
        type: 'node.event',
        nodeRunId: otherRun,
        ts: 30,
        kind: 'text',
        payload: { text: 'other' },
      },
    ] satisfies TaskWsMessage[])
    expect(await runtime.channels.replayTaskEvents('session', 'missing-task', 0)).toEqual([])
  })

  test('a composed runtime observes later inserts without mutating an earlier replay result', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId)
    const runtime = runtimeFor(harness)
    const [first] = await db
      .insert(nodeRunEvents)
      .values({
        nodeRunId: runId,
        ts: 1,
        kind: 'text',
        payload: '{"text":"before"}',
      })
      .returning({ id: nodeRunEvents.id })
    if (first === undefined) throw new Error('first persisted event missing')
    const snapshot = await runtime.channels.replayTaskEvents('session', taskId, 0)
    expect(snapshot).toEqual([
      {
        id: first.id,
        type: 'node.event',
        nodeRunId: runId,
        ts: 1,
        kind: 'text',
        payload: { text: 'before' },
      },
    ] satisfies TaskWsMessage[])
    const [later] = await db
      .insert(nodeRunEvents)
      .values({
        nodeRunId: runId,
        ts: 2,
        kind: 'text',
        payload: 'null',
      })
      .returning({ id: nodeRunEvents.id })
    if (later === undefined) throw new Error('later persisted event missing')
    expect(await runtime.channels.replayTaskEvents('session', taskId, first.id)).toEqual([
      { id: later.id, type: 'node.event', nodeRunId: runId, ts: 2, kind: 'text', payload: null },
    ] satisfies TaskWsMessage[])
    expect(snapshot).toHaveLength(1)
    expect(
      (await runtime.channels.replayTaskEvents('session', taskId, 0)).map((event) => event.id),
    ).toEqual([first.id, later.id])
  })
})
