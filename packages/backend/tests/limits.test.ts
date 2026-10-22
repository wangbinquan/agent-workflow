// P-4-04: per-task duration + token limit enforcement.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { enforceLimits } from '../src/services/limits'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

interface Harness {
  db: PersistenceDb
  appHome: string
  cleanup: () => void
}

function buildHarness(db: PersistenceDb): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-limits-'))
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedTask(
  db: PersistenceDb,
  overrides: Partial<PersistenceTables['tasks']['$inferInsert']>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  const { workflows, tasks } = tablesOf(db)
  await insertOne(db, workflows, {
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await insertOne(db, tasks, {
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    // RFC-328：SQLite 的 `rfc328_tasks_lineage_after_insert` 触发器按设计没有 PG 对应物，
    // 直接写 `tasks` 的夹具必须自己把这两列填上，两个引擎才从同一个起点出发。
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([{ kind: 'task-root', taskId }]),
    ...overrides,
  })
  return taskId
}

// RFC-359 AC-6（plan §5ep）：`enforceLimits` 的裸 db 入口经
// `composeLegacySqliteResourceLimitOperations` 取 `cancelTask`，两处都已放宽到中立句柄，本文件转双引擎。
describeEachProvider('enforceLimits（双引擎）', (harness: ProviderHarness) => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness(harness.db)
  })
  afterEach(() => h.cleanup())

  test('no-op when no running tasks', async () => {
    const r = await enforceLimits(h.db)
    expect(r).toEqual({ scanned: 0, canceled: [] })
  })

  test('cancels task whose duration exceeds maxDurationMs', async () => {
    // RFC-207 §3.8 — the cap is measured against ACCUMULATED running time, so the
    // seed must open a running stretch (`runningSince`) rather than only backdate
    // `startedAt`; wall clock since creation no longer decides this.
    const startedAt = Date.now() - 10_000
    const taskId = await seedTask(h.db, {
      maxDurationMs: 5_000,
      startedAt,
      runningSince: startedAt,
    })
    const r = await enforceLimits(h.db, Date.now())
    expect(r.canceled).toEqual([taskId])
    const { tasks } = tablesOf(h.db)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')
    expect(t?.errorSummary).toBe('task-time-limit-exceeded')
  })

  test('leaves a task alone when within its duration cap', async () => {
    const startedAt = Date.now() - 1_000
    const taskId = await seedTask(h.db, { maxDurationMs: 60_000, startedAt })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([])
    const { tasks } = tablesOf(h.db)
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('running')
  })

  test('cancels task when total tokens exceed maxTotalTokens', async () => {
    const taskId = await seedTask(h.db, { maxTotalTokens: 100 })
    const { nodeRuns, tasks } = tablesOf(h.db)
    // Two node_runs with 60 and 80 tokens → total 140 > 100.
    await insertOne(h.db, nodeRuns, {
      id: ulid(),
      taskId,
      nodeId: 'a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 60,
    })
    await insertOne(h.db, nodeRuns, {
      id: ulid(),
      taskId,
      nodeId: 'b',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 80,
    })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([taskId])
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.errorSummary).toBe('task-token-limit-exceeded')
    expect(t?.errorMessage).toContain('140')
  })

  test('maxTotalTokens=0 disables the token cap', async () => {
    const taskId = await seedTask(h.db, { maxTotalTokens: 0 })
    const { nodeRuns } = tablesOf(h.db)
    await insertOne(h.db, nodeRuns, {
      id: ulid(),
      taskId,
      nodeId: 'a',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      tokTotal: 999_999,
    })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([])
  })
})
