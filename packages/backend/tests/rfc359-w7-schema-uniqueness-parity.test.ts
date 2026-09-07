// RFC-359 W7 —— 唯一性保护的**双引擎行为**验收。
//
// 为什么存在这条文件
// ------------------
// `tests/architecture/rfc359-w5-t19g-schema-contract-reconciliation.test.ts` 是**对账**：
// 它比「迁移 DDL 里有什么」与「drizzle 声明里有什么」，能证明差异消失了，却证明不了
// **保护真的在两个引擎上生效**——对账绿而保护失效的路径是存在的（声明写了、投影却把它
// 渲染成了 PostgreSQL 咬不动的形状；表达式唯一走了只会渲染列名的 `ADD CONSTRAINT … UNIQUE`
// 那条路径；部分索引的谓词在某个引擎上被求值成恒真）。所以每条 W7 收敛的唯一性
// 都在这里再挨一次**行为**验收：塞进两行按该保护应当冲突的数据，**两个引擎都必须拒绝**。
//
// W7 之前这些保护只在 SQLite 迁移 SQL 里存在。PostgreSQL 的 DDL 来自 drizzle 声明
// （`db/schema.ts` → `buildLogicalSchemaContract()` → `postgresqlSchema.ts`），迁移 SQL 一行
// 都不重放，所以「只写在迁移里」= **PG 上根本没有这条保护**：同名仓库组能建两个、
// 同一目录换个大小写能在一个组里挂两次、内建工作流能重名、同一次 webhook fire 能预留
// 两条 guard。下面每个用例锁的就是那个具体后果。
//
// 三条 `LOWER(…)` 必须走**索引**而不是约束：`postgresqlSchema.ts` 的 unique **约束**路径
// （`ALTER TABLE … ADD CONSTRAINT … UNIQUE (…)`）只渲染列名（`quote(column)`），表达式唯一
// 在那条路径上表达不出来；只有 `indexStatements` 的 `renderIndexColumn` 会把非标识符的列
// 交给 `localExpression`，渲染成 `CREATE UNIQUE INDEX … (lower("name"))`。
//
// 每个用例都配一条**反向对照**（大小写以外真的不同的值必须插得进去），否则「两行都插不进」
// 也能来自一条过宽的约束，绿得没有意义。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  intentSessions,
  intentTurnEvents,
  intentTurns,
  repoGroupNodes,
  repoGroups,
  taskSpaceNodes,
  tasks,
  webhookMrLaunchGuards,
  workflows,
} from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

/**
 * 跑一次写入并把结果收敛成「拒了 / 没拒」。两个引擎的报错文本不同
 * （SQLite `UNIQUE constraint failed…` vs PostgreSQL `duplicate key value violates…`），
 * 所以断言只看**是否被拒**，不比文本。
 */
async function rejected(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write()
    return false
  } catch {
    return true
  }
}

async function seedWorkflow(db: ProviderNeutralDatabase, id: string): Promise<void> {
  await db.insert(workflows).values({
    id,
    name: `wf-${id}`,
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
}

async function seedTask(db: ProviderNeutralDatabase, id: string): Promise<void> {
  await seedWorkflow(db, `wf_for_${id}`)
  await db.insert(tasks).values({
    id,
    name: 'w7-parity',
    workflowId: `wf_for_${id}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-w7',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'pending' as const,
    inputs: '{}',
    startedAt: 1,
  })
}

function repoGroupRow(id: string, name: string) {
  return { id, name, description: '', version: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 }
}

function launchGuardRow(id: string, fireId: string) {
  return {
    id,
    endpointId: 'ep_w7',
    streamKey: `stream-${id}`,
    binding: 'binding-w7',
    launchRevision: 1,
    deliveryId: `delivery-${id}`,
    fireId,
    triggerNameSnapshot: 'w7',
    status: 'reserved' as const,
    createdAt: 1,
    updatedAt: 1,
  }
}

describeEachProvider('RFC-359 W7 —— W5 账本收敛掉的唯一性在两个引擎上都真的生效', (harness) => {
  test('repo_groups：组名大小写不敏感唯一——PG 上此前能建出同名仓库组', async () => {
    await harness.db.insert(repoGroups).values(repoGroupRow('rg_alpha', 'Alpha'))

    expect(
      await rejected(() =>
        harness.db.insert(repoGroups).values(repoGroupRow('rg_alpha_2', 'alpha')),
      ),
      '`idx_repo_groups_name_ci` 是 UNIQUE(lower(name))：只差大小写的组名必须被拒',
    ).toBe(true)
    expect(await harness.db.select({ id: repoGroups.id }).from(repoGroups)).toHaveLength(1)

    // 反向对照：真的不同的名字照常插得进去（约束没有宽到把一切都拒了）。
    await harness.db.insert(repoGroups).values(repoGroupRow('rg_beta', 'Beta'))
    expect(await harness.db.select({ id: repoGroups.id }).from(repoGroups)).toHaveLength(2)
  })

  test('repo_group_nodes：组内路径大小写不敏感唯一（主键是精确路径，抓不到这一类）', async () => {
    await harness.db.insert(repoGroups).values(repoGroupRow('rg_nodes', 'nodes'))
    await harness.db.insert(repoGroupNodes).values({ groupId: 'rg_nodes', path: 'Src' })

    expect(
      await rejected(() =>
        harness.db.insert(repoGroupNodes).values({ groupId: 'rg_nodes', path: 'src' }),
      ),
      '`idx_rgn_path_ci` 是 UNIQUE(group_id, lower(path))；PK(group_id, path) 认为 Src ≠ src，' +
        '所以这一类只有 CI 索引拦得住',
    ).toBe(true)
    expect(
      await harness.db.select({ path: repoGroupNodes.path }).from(repoGroupNodes),
    ).toHaveLength(1)

    // 反向对照：同组里另一个真实路径、以及另一个组里的同名路径都必须插得进去。
    await harness.db.insert(repoGroupNodes).values({ groupId: 'rg_nodes', path: 'docs' })
    await harness.db.insert(repoGroups).values(repoGroupRow('rg_nodes_2', 'nodes-2'))
    await harness.db.insert(repoGroupNodes).values({ groupId: 'rg_nodes_2', path: 'Src' })
    expect(
      await harness.db.select({ path: repoGroupNodes.path }).from(repoGroupNodes),
    ).toHaveLength(3)
  })

  test('task_space_nodes：任务空间目录大小写不敏感唯一', async () => {
    await seedTask(harness.db, 't_space')
    await harness.db.insert(taskSpaceNodes).values({ taskId: 't_space', nodePath: 'Repo/App' })

    expect(
      await rejected(() =>
        harness.db.insert(taskSpaceNodes).values({ taskId: 't_space', nodePath: 'repo/app' }),
      ),
      '`idx_task_space_nodes_path_ci` 是 UNIQUE(task_id, lower(node_path))',
    ).toBe(true)
    expect(
      await harness.db.select({ nodePath: taskSpaceNodes.nodePath }).from(taskSpaceNodes),
    ).toHaveLength(1)

    await harness.db.insert(taskSpaceNodes).values({ taskId: 't_space', nodePath: 'Repo/Lib' })
    expect(
      await harness.db.select({ nodePath: taskSpaceNodes.nodePath }).from(taskSpaceNodes),
    ).toHaveLength(2)
  })

  test('webhook_mr_launch_guards：一次 fire 只能预留一条 guard（迁移里的列级 UNIQUE）', async () => {
    await harness.db.insert(webhookMrLaunchGuards).values(launchGuardRow('g_1', 'fire_1'))

    expect(
      await rejected(() =>
        harness.db.insert(webhookMrLaunchGuards).values(launchGuardRow('g_2', 'fire_1')),
      ),
      '`fire_id text NOT NULL UNIQUE`：同一次 fire 重入必须撞唯一键，去重分支才走得到',
    ).toBe(true)
    expect(
      await harness.db.select({ id: webhookMrLaunchGuards.id }).from(webhookMrLaunchGuards),
    ).toHaveLength(1)

    await harness.db.insert(webhookMrLaunchGuards).values(launchGuardRow('g_3', 'fire_2'))
    expect(
      await harness.db.select({ id: webhookMrLaunchGuards.id }).from(webhookMrLaunchGuards),
    ).toHaveLength(2)
  })

  test('workflows：内建工作流重名闸是**部分**唯一索引——只管 builtin 行', async () => {
    await harness.db.insert(workflows).values({
      id: 'wf_builtin_1',
      name: 'code-review',
      description: '',
      definition: '{}',
      version: 1,
      builtin: true,
      schemaVersion: 4,
    })

    expect(
      await rejected(() =>
        harness.db.insert(workflows).values({
          id: 'wf_builtin_2',
          name: 'code-review',
          description: '',
          definition: '{}',
          version: 1,
          builtin: true,
          schemaVersion: 4,
        }),
      ),
      '`idx_workflows_builtin_name` = UNIQUE(name) WHERE builtin：第二条同名内建必须被拒',
    ).toBe(true)

    // 反向对照 ①：谓词之外的行不受管——用户自建的同名工作流照常允许（重名由导入对话框处理）。
    await harness.db.insert(workflows).values({
      id: 'wf_user',
      name: 'code-review',
      description: '',
      definition: '{}',
      version: 1,
      builtin: false,
      schemaVersion: 4,
    })
    // 反向对照 ②：另一个名字的内建工作流照常允许。
    await harness.db.insert(workflows).values({
      id: 'wf_builtin_other',
      name: 'code-audit',
      description: '',
      definition: '{}',
      version: 1,
      builtin: true,
      schemaVersion: 4,
    })
    expect(await harness.db.select({ id: workflows.id }).from(workflows)).toHaveLength(3)
  })

  test('intent_turn_events：部分唯一索引与全量唯一索引在两个引擎上等价（W5 账本判定的判据）', async () => {
    // 这两条唯一性 W7 **刻意没有抹平形态**：迁移写的是 `WHERE external_event_id IS NOT NULL`，
    // drizzle 写的是全量唯一索引。判定它们等价的依据是「两个引擎都把含 NULL 的行视作互不相同」
    // （PostgreSQL 的 NULLS DISTINCT 默认）。判据不能只写在注释里——这里把它跑出来。
    await harness.db.insert(intentSessions).values({
      id: 'is_w7',
      ownerUserId: 'u_w7',
      createdAt: 1,
      updatedAt: 1,
    })
    await harness.db.insert(intentTurns).values({
      id: 'it_w7',
      sessionId: 'is_w7',
      seq: 1,
      role: 'agent',
      kind: 'message',
      createdAt: 1,
    })
    const event = (eventSeq: number, externalEventId: string | null) => ({
      turnId: 'it_w7',
      eventSeq,
      ts: 1,
      kind: 'text',
      payload: '{}',
      source: 'stream' as const,
      externalEventId,
    })

    // NULL 侧：同 (turn_id, source)、external_event_id 都为 NULL 的两行——两个引擎都必须放行。
    // 这正是谓词排除掉的那批行，也正是「部分 ≡ 全量」成立的原因。
    await harness.db.insert(intentTurnEvents).values(event(1, null))
    await harness.db.insert(intentTurnEvents).values(event(2, null))

    // 非 NULL 侧：同一个外部事件 id 重入必须被拒（去重真的生效）。
    await harness.db.insert(intentTurnEvents).values(event(3, 'ext-1'))
    expect(
      await rejected(() => harness.db.insert(intentTurnEvents).values(event(4, 'ext-1'))),
      'uniq_intent_turn_events_external 必须拦住同 (turn_id, source, external_event_id) 的重入',
    ).toBe(true)

    expect(
      await harness.db
        .select({ eventSeq: intentTurnEvents.eventSeq })
        .from(intentTurnEvents)
        .where(eq(intentTurnEvents.turnId, 'it_w7')),
    ).toHaveLength(3)
  })
})
