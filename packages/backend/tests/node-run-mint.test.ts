// RFC-098 WP-10 T-a — mintNodeRun factory contract.
//
// Pins:
//   1. Field resolution order: overrides ≻ inheritFrom ≻ defaults, with
//      inheritFrom limited to THE single inheritance list
//      (reviewIteration / shardKey / parentNodeRunId / preSnapshot).
//   2. startedAt/finishedAt defaults: startedAt=now unless overridden
//      (explicit null preserved — legacy rerun-mint shape); finishedAt=now
//      only for status 'done'.
//   3. Born-running invariant (RFC-098 对抗检视修订 #10): status==='running'
//      requires a non-null resolved parentNodeRunId — a parentless running
//      row would enter deriveFrontier's in-flight set and freeze the
//      frontier. Violation throws BEFORE any row is written.
//   4. (T-b) `cause` persists to node_runs.rerun_cause.
//   5. schedulerMintCause merge rule (对抗检视修订 #11) branch-by-branch —
//      see also rfc098-rerun-cause-gates.test.ts for the gate truth table.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { mintNodeRun, schedulerMintCause } from '../src/services/nodeRunMint'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TASK_ID = 'task-mint'

let db: DbClient

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
  await db.run(sql`
    INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
      base_branch, branch, status, inputs, started_at, schema_version)
    VALUES (${TASK_ID}, 'mint', 'wf', '{}', '/tmp/r', '/tmp/w', 'main', 'b', 'running', '{}', 1, 1)
  `)
})

async function readRow(id: string) {
  const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]
  expect(row).toBeDefined()
  return row!
}

describe('mintNodeRun — defaults', () => {
  test('minimal pending mint: column defaults match the old half-factory', async () => {
    const before = Date.now()
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'initial',
    })
    const row = await readRow(id)
    expect(row.status).toBe('pending')
    expect(row.retryIndex).toBe(0)
    expect(row.iteration).toBe(0)
    expect(row.reviewIteration).toBe(0)
    expect(row.shardKey).toBeNull()
    expect(row.parentNodeRunId).toBeNull()
    expect(row.preSnapshot).toBeNull()
    expect(row.shardValueHash).toBeNull()
    expect(row.consumedUpstreamRunsJson).toBeNull()
    expect(row.errorMessage).toBeNull()
    expect(row.startedAt).toBeGreaterThanOrEqual(before)
    expect(row.finishedAt).toBeNull()
    // T-b: the factory is THE single rerun_cause write point (migration 0044).
    expect(row.rerunCause).toBe('initial')
  })

  test('every mint persists its cause to node_runs.rerun_cause (T-b)', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'cross-clarify-questioner-rerun',
    })
    expect((await readRow(id)).rerunCause).toBe('cross-clarify-questioner-rerun')
  })

  test("status 'done' defaults finishedAt to now; explicit override wins", async () => {
    const doneId = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'done',
      cause: 'io-virtual',
    })
    expect((await readRow(doneId)).finishedAt).not.toBeNull()

    const pinned = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'failed',
      cause: 'retry-node',
      overrides: { finishedAt: 1234, errorMessage: 'queued for retry' },
    })
    const row = await readRow(pinned)
    expect(row.finishedAt).toBe(1234)
    expect(row.errorMessage).toBe('queued for retry')
  })

  test('startedAt: explicit null is preserved (legacy rerun-mint shape)', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'clarify-answer',
      overrides: { startedAt: null },
    })
    expect((await readRow(id)).startedAt).toBeNull()
  })
})

describe('mintNodeRun — inheritance (single list) and override precedence', () => {
  const inheritFrom = {
    reviewIteration: 3,
    shardKey: 'src/a.ts',
    parentNodeRunId: 'parent-1',
    preSnapshot: 'stash-sha',
  }

  test('inheritFrom carries exactly reviewIteration/shardKey/parentNodeRunId/preSnapshot', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'cross-clarify-answer',
      retryIndex: 5,
      iteration: 2,
      inheritFrom,
    })
    const row = await readRow(id)
    expect(row.reviewIteration).toBe(3)
    expect(row.shardKey).toBe('src/a.ts')
    expect(row.parentNodeRunId).toBe('parent-1')
    expect(row.preSnapshot).toBe('stash-sha')
    expect(row.retryIndex).toBe(5)
    expect(row.iteration).toBe(2)
  })

  test('overrides beat inheritFrom, including explicit null (review-rerun shape)', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'review-iterate',
      inheritFrom,
      overrides: { parentNodeRunId: null, shardKey: null, reviewIteration: 0 },
    })
    const row = await readRow(id)
    expect(row.parentNodeRunId).toBeNull()
    expect(row.shardKey).toBeNull()
    expect(row.reviewIteration).toBe(0)
    // not overridden → still inherited
    expect(row.preSnapshot).toBe('stash-sha')
  })

  test('overrides work without inheritFrom (shard-child shape)', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'inner',
      status: 'pending',
      cause: 'fanout-shard',
      iteration: 1,
      overrides: { parentNodeRunId: 'wrapper-run', shardKey: 'k0', shardValueHash: 'h1' },
    })
    const row = await readRow(id)
    expect(row.parentNodeRunId).toBe('wrapper-run')
    expect(row.shardKey).toBe('k0')
    expect(row.shardValueHash).toBe('h1')
  })
})

describe('mintNodeRun — born-running invariant (RFC-098 对抗检视修订 #10)', () => {
  test("status 'running' with a parent (commit&push container shape) mints fine", async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: '__commit_push__:agent-1',
      status: 'running',
      cause: 'commit-push',
      overrides: { parentNodeRunId: 'trigger-run' },
    })
    const row = await readRow(id)
    expect(row.status).toBe('running')
    expect(row.parentNodeRunId).toBe('trigger-run')
  })

  test("status 'running' WITHOUT a parent throws and writes nothing", async () => {
    await expect(
      mintNodeRun(db, {
        taskId: TASK_ID,
        nodeId: 'n1',
        status: 'running',
        cause: 'commit-push',
      }),
    ).rejects.toThrow(/frontier invisibility/)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, TASK_ID))
    expect(rows.length).toBe(0)
  })

  test("status 'running' with overrides.parentNodeRunId explicitly null throws (resolution-order aware)", async () => {
    await expect(
      mintNodeRun(db, {
        taskId: TASK_ID,
        nodeId: 'n1',
        status: 'running',
        cause: 'commit-push',
        inheritFrom: {
          reviewIteration: 0,
          shardKey: null,
          parentNodeRunId: 'would-be-parent',
          preSnapshot: null,
        },
        overrides: { parentNodeRunId: null },
      }),
    ).rejects.toThrow(/frontier invisibility/)
  })
})

describe('schedulerMintCause — 对抗检视修订 #11 merge rule (pinned)', () => {
  test('no existing row → initial', () => {
    expect(schedulerMintCause(undefined)).toBe('initial')
  })
  test('done (stale) → stale-redispatch', () => {
    expect(schedulerMintCause({ status: 'done' })).toBe('stale-redispatch')
  })
  test('terminal-failure family → revival', () => {
    expect(schedulerMintCause({ status: 'failed' })).toBe('revival')
    expect(schedulerMintCause({ status: 'interrupted' })).toBe('revival')
    expect(schedulerMintCause({ status: 'canceled' })).toBe('revival')
    expect(schedulerMintCause({ status: 'exhausted' })).toBe('revival')
  })
  test('stale parked awaiting_* → stale-redispatch (re-dispatch over a parked row)', () => {
    expect(schedulerMintCause({ status: 'awaiting_review' })).toBe('stale-redispatch')
    expect(schedulerMintCause({ status: 'awaiting_human' })).toBe('stale-redispatch')
  })
})

// ── RFC-284 T21 —— nextRetryIndex：七处手写「下一个 retry_index」口径的唯一实现 ──
import { nextRetryIndex } from '../src/modules/task-execution/application/nextRetryIndex'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

describe('RFC-284 T21 — nextRetryIndex 口径矩阵', () => {
  const rows = [
    { retryIndex: 0, parentNodeRunId: null, iteration: 0 },
    { retryIndex: 2, parentNodeRunId: null, iteration: 0 },
    { retryIndex: 5, parentNodeRunId: 'child-parent', iteration: 0 }, // child 行
    { retryIndex: 3, parentNodeRunId: null, iteration: 1 }, // 别的迭代
  ]

  test('空集 → 0（reduce(-1)+1 与 length-guard 两种历史写法的共同值）', () => {
    expect(nextRetryIndex([])).toBe(0)
    expect(nextRetryIndex([], { topLevelOnly: true, iteration: 7 })).toBe(0)
  })

  test('默认口径 = 全行集（task.ts retry-cascade：刻意含 child rows）', () => {
    expect(nextRetryIndex(rows)).toBe(6) // child 的 5 参与
  })

  test('topLevelOnly + iteration（taskQuestionDispatch 口径）', () => {
    expect(nextRetryIndex(rows, { topLevelOnly: true, iteration: 0 })).toBe(3) // child 5 被滤掉
    expect(nextRetryIndex(rows, { topLevelOnly: true, iteration: 1 })).toBe(4)
    expect(nextRetryIndex(rows, { topLevelOnly: true, iteration: 9 })).toBe(0)
  })

  test('单行集（review.ts latest+1 特例）', () => {
    expect(nextRetryIndex([{ retryIndex: 7 }])).toBe(8)
  })

  test('parentNodeRunId 缺省字段的行按顶层计（scheduler 行集不带该列时不误滤）', () => {
    expect(nextRetryIndex([{ retryIndex: 4 }], { topLevelOnly: true })).toBe(5)
  })

  test('结构锁：五文件全部经 nextRetryIndex，手写 max-over-retryIndex 归零', () => {
    const files = [
      'services/task.ts',
      'modules/collaboration/infrastructure/legacySqliteReview.ts',
      'modules/collaboration/infrastructure/legacySqliteTaskQuestionDispatch.ts',
      'modules/task-execution/composition/nodeMechanics.ts',
    ]
    for (const f of files) {
      const src = readFileSync(resolvePath(import.meta.dir, '..', 'src', f), 'utf8')
      // RFC-287 T8：nodeMechanics.ts 的取行前奏收编进 resolveSchedulerRunRow（与
      // nextRetryIndex 同住 nodeRunMint），因此它**不再直接调**——改为经收编函数
      // 到达。锁的不变量（铸点一律经单一实现、手写 max-over-retryIndex 归零）没
      // 变，反而更强：nodeMechanics.ts 现在连 retryIndex 都不自己算。
      expect(src).toMatch(/nextRetryIndex\(|resolveSchedulerRunRow\(/)
      // 铸点惯用式归零：max-扫描 与 length-guard 三元。展示/遥测语义的
      // `processRetryIndex: x.retryIndex + 1`（0 基转 1 基）不在锁面。
      expect(/Math\.max\([^)]*retryIndex/.test(src)).toBe(false)
      expect(/length === 0 \? 0 :.*retryIndex/.test(src)).toBe(false)
      expect(/retryIndex: \w+\.retryIndex \+ 1/.test(src)).toBe(false)
    }
    expect(
      readFileSync(
        resolvePath(
          import.meta.dir,
          '..',
          'src',
          'modules/task-execution/application/nextRetryIndex.ts',
        ),
        'utf8',
      ),
    ).toContain('export function nextRetryIndex')
  })
})
