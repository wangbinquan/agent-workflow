// RFC-370 hosted acceptance (2026-10-18) — the isolation cleanup receipt stays
// with the SQLite daemon's contexts.
//
// WHY THIS FILE EXISTS (regression intent): making the public ambient lookup
// provider-neutral (bb48c1f8b) also handed `discardNodeIso` the PostgreSQL
// daemon's contexts. Its cleanup receipt then took the canonical `workspace:`
// fence before the hosted discard waited for the task's write window — the
// reverse order of every merge-back — and the CrewStation M2 control run
// deadlocked: a merge-back held the window waiting for the fence while the
// discard held the fence waiting for the window. Until the discard owns its
// write window the receipt is recorded for SQLite daemon contexts only.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionEffects, tasks, workflows } from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext as createSqliteDaemonContext } from '@/modules/task-execution/composition/sqliteTaskExecutionContext'
import {
  createTaskExecutionContext as createProviderContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { discardNodeIso } from '@/modules/task-execution/infrastructure/isolationCleanup'
import { describeEachProvider } from './helpers/eachProvider'

const ROOT = mkdtempSync(join(tmpdir(), 'aw-rfc370-iso-cleanup-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function launch(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

async function seedClaimedTask(db: ProviderNeutralDatabase) {
  const taskId = `t370iso_${ulid()}`
  const snapshot = '{"$schema_version":6,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc370-iso-cleanup',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'writer',
    status: 'failed',
    retryIndex: 0,
    iteration: 0,
  })
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: launch(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const containerPath = join(ROOT, taskId, runId)
  mkdirSync(containerPath, { recursive: true })
  return {
    taskId,
    intentId,
    token: claimed.token,
    persistence,
    handle: { taskId, nodeRunId: runId, dbNodeRunId: runId, containerPath, repos: [] },
  }
}

async function cleanupEffects(db: ProviderNeutralDatabase, taskId: string) {
  return await db
    .select({ state: taskExecutionEffects.state })
    .from(taskExecutionEffects)
    .where(
      and(
        eq(taskExecutionEffects.taskId, taskId),
        eq(taskExecutionEffects.kind, 'workspace-cleanup'),
      ),
    )
}

describeEachProvider(
  'RFC-370 the isolation cleanup receipt follows the daemon context',
  (harness) => {
    test('a PostgreSQL daemon context discards without taking the cleanup fence', async () => {
      const seeded = await seedClaimedTask(harness.db)
      const context = createProviderContext({
        intentId: seeded.intentId,
        token: seeded.token,
        persistence: seeded.persistence,
      })
      await runWithTaskExecutionContext(context, () => discardNodeIso(seeded.handle))
      expect(await cleanupEffects(harness.db, seeded.taskId)).toEqual([])
    })

    test('the SQLite daemon context still records the cleanup receipt', async () => {
      const seeded = await seedClaimedTask(harness.db)
      const context = createSqliteDaemonContext({
        intentId: seeded.intentId,
        token: seeded.token,
        db: harness.db,
      })
      await runWithTaskExecutionContext(context, () => discardNodeIso(seeded.handle))
      expect(await cleanupEffects(harness.db, seeded.taskId)).toEqual([{ state: 'succeeded' }])
    })
  },
)
