// RFC-359 W6 —— node_run 的 lineage 槽路径：两个引擎必须落出同一行。
//
// # 这条测试锁的是什么回归
//
// 迁移 0210 给 `node_runs` 建了一个 `AFTER INSERT` 触发器
// （`rfc328_node_runs_lineage_after_insert`），在 `continuation_slot_key` /
// `lineage_slot_path_json` 为 NULL 时补齐它们。它**只存在于 SQLite**——PostgreSQL 的 DDL 由
// `db/schema.ts` 投影而来，一行触发器都没有。
//
// W8 把这条记成「当前生产路径够不着的能力不对等」。**那个判断是错的**，2026-09-07 实测推翻：
// 铸行工厂对 `lineageSlotPathJson` 的默认值是 `overrides ?? inherited ?? null`，而全 `src`
// 没有任何调用点传 `overrides.lineageSlotPathJson`，所以任务的**首个** node_run 一定走到 null：
//
//   [sqlite]      n1  lineage=[{root…},{stableNodeKey:"n1",…}]   n2  lineage=[{root…},{"n2"…}]
//   [postgresql]  n1  lineage=null                               n2  lineage=null
//
// 下游按 `run?.lineageSlotPathJson ?? intent.slotPathJson ?? task.lineageSlotPathJson ?? '[]'`
// 回落，于是 PostgreSQL 上**同一任务的不同节点回落到同一条任务级路径**，effect 的
// `slot_path_digest` 在节点之间撞车；SQLite 上它们各不相同。这不是「少一列元数据」。
//
// 处置（`design/RFC-359…/plan.md §5d` 两条出路里的第②条，但**次序被修正**）：账本原文写的是
// 「把触发器从 SQLite 删掉、改为架构守卫兜底」。直接那么做会把 SQLite **拉平到 PG 的坏值**，
// 因为工厂本来就不写这一列。正确次序是先让工厂显式写（`nodeRunLineageColumns`，
// 两个引擎共用一份推导），触发器这才**真的**冗余，然后才删（迁移 0224）+ 立守卫
// （`tests/architecture/rfc359-w6-node-run-insert-lineage-completeness.test.ts`）。
//
// # 判据
//
//  ①【两个引擎同一行】同一次铸造，两侧的 `continuation_slot_key` 与 `lineage_slot_path_json`
//    逐字节相同——用 `describeEachProvider` 把结果收进一张按引擎归档的表再对照。
//  ②【值本身对】路径 = 任务的路径 + 本行一帧，帧键与被退役的触发器逐字同形
//    （`"<iteration>|<shardKey 或空串>"`），且不同节点各不相同。
//  ③【触发器真的没了】SQLite 的 `sqlite_master` 里不再有那个触发器（否则「工厂写了」与
//    「触发器补了」在 SQLite 上同形，①就证明不了任何事）。
//  ④【继承优先】显式传进来的路径不被覆写。

import { afterAll, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { nodeRuns, tasks, workflows } from '@/db/schema'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

const TASK_PATH = JSON.stringify([
  { frozenOccurrenceKey: '0|', stableNodeKey: 'root', workflowRevision: 7 },
])

/** 两条 lane 共用的结果表：`引擎 → 节点 → 落库的两列`。 */
const MINTED = new Map<string, Record<string, { slot: string | null; lineage: string | null }>>()

describeEachProvider('RFC-359 W6 —— node_run lineage 的双引擎一致', (harness) => {
  const seedTask = async (): Promise<void> => {
    await harness.db.insert(workflows).values({ id: 'wf-lin', name: 'lineage', definition: '{}' })
    await harness.db.insert(tasks).values({
      id: 'tk-lin',
      name: 'lineage',
      workflowId: 'wf-lin',
      workflowSnapshot: '{}',
      workflowVersion: 7,
      repoPath: '/repo',
      repoUrl: 'git@example.com:acme/r.git',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/lineage',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      runningMs: 0,
      ownerUserId: null,
      invocationDepth: 0,
      launchOrigin: 'manual',
      branchStartedAt: 1,
      rootTaskId: 'tk-lin',
      executionLineageId: 'lin-w6',
      lineageSlotPathJson: TASK_PATH,
    })
  }

  const mint = async (inputs: readonly NodeRunMintInput[]): Promise<void> => {
    await databaseSessionFor(harness.db).transaction(async (tx) => {
      const participant = createNodeRunMintParticipantInTx(tx)
      for (const input of inputs) await participant.mint(input)
    })
  }

  test('① / ② 首个 node_run 的 lineage 由工厂写出，两个引擎逐字节相同', async () => {
    await seedTask()
    await mint([
      { taskId: 'tk-lin', nodeId: 'n1', status: 'pending', cause: 'initial' },
      { taskId: 'tk-lin', nodeId: 'n2', status: 'pending', cause: 'initial', iteration: 2 },
      {
        taskId: 'tk-lin',
        nodeId: 'n3',
        status: 'pending',
        cause: 'initial',
        overrides: { shardKey: 's7' },
      },
    ] as NodeRunMintInput[])

    const rows = await harness.db
      .select({
        node: nodeRuns.nodeId,
        slot: nodeRuns.continuationSlotKey,
        lineage: nodeRuns.lineageSlotPathJson,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, 'tk-lin'))
    const byNode = Object.fromEntries(
      rows.map((row) => [row.node, { slot: row.slot, lineage: row.lineage }]),
    )
    MINTED.set(harness.capabilities.provider, byNode)

    // ② 值本身：任务路径 + 本行一帧，帧键与被退役的触发器逐字同形。
    const frame = (node: string, occurrence: string): string =>
      JSON.stringify([
        { frozenOccurrenceKey: '0|', stableNodeKey: 'root', workflowRevision: 7 },
        { frozenOccurrenceKey: occurrence, stableNodeKey: node, workflowRevision: 7 },
      ])
    expect(byNode['n1']?.lineage).toBe(frame('n1', '0|'))
    expect(byNode['n2']?.lineage).toBe(frame('n2', '2|'))
    expect(byNode['n3']?.lineage).toBe(frame('n3', '0|s7'))
    // 不同节点必须各不相同——PG 上回落到任务级路径时它们会全部撞在一起。
    expect(new Set(rows.map((row) => row.lineage)).size).toBe(3)
    expect(new Set(rows.map((row) => row.slot)).size).toBe(3)
  })

  test('④ 显式传进来的 lineage 不被覆写', async () => {
    await seedTask()
    const explicit = JSON.stringify([
      { frozenOccurrenceKey: '9|', stableNodeKey: 'explicit', workflowRevision: null },
    ])
    await mint([
      {
        taskId: 'tk-lin',
        nodeId: 'n9',
        status: 'pending',
        cause: 'initial',
        overrides: { lineageSlotPathJson: explicit },
      },
    ] as NodeRunMintInput[])
    const [row] = await harness.db
      .select({ lineage: nodeRuns.lineageSlotPathJson })
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, 'n9'))
    expect(row?.lineage).toBe(explicit)
  })

  test('③ SQLite 上那个补齐触发器确实已经删掉了（否则①证明不了任何事）', async () => {
    if (harness.capabilities.provider !== 'sqlite') {
      // PostgreSQL 侧本来就没有触发器（DDL 从 db/schema.ts 投影，不重放迁移 SQL）。
      const rows = await harness.db.all<{ n: unknown }>(
        sql`select count(*) as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
            join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'agent_workflow' and not t.tgisinternal`,
      )
      expect(harness.capabilities.numericFromRawRow(rows[0]?.n, 'n')).toBe(0)
      return
    }
    const rows = await harness.db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'trigger' and tbl_name = 'node_runs'`,
    )
    expect(rows.map((row) => row.name)).toEqual([])
  })
})

afterAll(() => {
  // 两条 lane 都跑过之后才有得比。单引擎跑（AW_TEST_PROVIDERS=sqlite）时跳过，不假装对拍过。
  const sqlite = MINTED.get('sqlite')
  const postgresql = MINTED.get('postgresql')
  if (sqlite === undefined || postgresql === undefined) return
  expect(
    postgresql,
    '同一次铸造在两个引擎上落出的 continuation_slot_key / lineage_slot_path_json 必须逐字节相同',
  ).toEqual(sqlite)
})
