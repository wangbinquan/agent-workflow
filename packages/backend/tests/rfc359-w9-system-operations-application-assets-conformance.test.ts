// RFC-359 W9 —— System Operations「应用侧资产」读面的双引擎对拍。
//
// 这一族此前的形态
// ================
// 便携备份 / 还原里有三处**纯查询 + 资产搬运**，两个 provider 各写了一份：
//
//   ①「库里现在有几个 running 任务」——`/health` 的唯一一条 DB 读
//      · SQLite     `platform/persistence/sqlite/systemHealthReadModel.ts`
//      · PostgreSQL `modules/system-operations/infrastructure/postgresqlHealthReadModel.ts`
//   ②「备份要导出哪些 workflow / 抓哪些 worktree」
//      · SQLite     `platform/persistence/sqlite/systemProviderBackup.ts` 里内联的 `application`
//        （转调 `systemWorktreeBackup.ts` 与 `services/workflow.ts` 的 `listWorkflows`）
//      · PostgreSQL `postgresqlProviderBackupApplicationAssets.ts` —— **手写 SQL**，
//        手写列别名（`"worktree_path" AS "worktreePath"`）、手写 `$1,$2…` 占位符表、
//        手写 `requiredString` 行校验
//   ③「还原时按 task id 取 worktree 行」
//      · SQLite     `systemWorktreeBackup.ts#reconstructWorktrees`（drizzle）
//      · PostgreSQL `postgresqlProviderRestoreApplicationAssets.ts#postgresqlWorktreeRows`（手写 SQL）
//
// 三处都**没有任何机制固有差异**：同一张表、同一组列、同一个筛选条件。手写 SQL 那一侧
// 的列名与 `db/schema.ts` 之间只有「人记得改」这一条约束——列一改名，SQLite 侧跟着走，
// PostgreSQL 侧要到用户真的去点「备份」时才炸。
//
// 对拍照出的**真分叉**（合一时取 SQLite 侧的契约，理由见各条）
// ============================================================
//   · **损坏的 workflow definition**：SQLite 侧走 `listWorkflows` → `rowToWorkflow`，抛
//     `ValidationError('workflow-definition-corrupt')`（HTTP 422 带 code + details.workflowId）；
//     PostgreSQL 侧直接 `JSON.parse` + `WorkflowDefinitionSchema.parse`，抛的是裸
//     SyntaxError / ZodError —— 到路由层就是 **500 `internal-error`**。同一个用户、
//     同一份坏数据、同一个「导出备份」按钮，两个引擎一个告诉你是哪个 workflow 坏了、
//     另一个只给一句「服务器内部错误」。合一后两边都是 422。见 ③ 用例。
//   · **被跳过的 worktree 无声无息**：SQLite 侧 `captureWorktrees` 之后打一条
//     `{captured, skipped}` 汇总日志；PostgreSQL 侧把 `captureWorktreeRows` 的返回值
//     整个丢掉，于是「有 3 个 worktree 因为超过 64MB 上限没进备份」在 PG 上连日志都没有。
//     合一后共用同一条汇总日志。
//
// 判据一律落在**端口契约**那一层（`HealthDatabaseReadModel`、
// `PortableBackupApplicationAssets`、`WorktreeReconstructResult`），不断言任何一侧的
// SQL 文本——被合掉的那两份手写 SQL fixture 测试（`rfc349-postgresql-provider-backup-assets`）
// 断的正是 SQL 文本，那种断言在真引擎上一行都没跑过。
//
// 双引擎陷阱盯点：
//   · PG 的 `count(*)` 聚合回**字符串**。变异实测：把 `count()` 换回合一前 SQLite 侧那种
//     手写 `sql\`count(*)\`` 并去掉 `Number(...)` 归一，**只有 `[postgresql]` 红**，
//     `Received: "0"`。合一后的写法两道都在（`count()` 自带 `mapWith(Number)` + 外层归一）。
//   · 漏 `await` 分三档，别混为一谈（本文件实测过第一档）：
//       ① `.all()` / `.get()` 后漏 `await` —— **只有 PG 红**。SQLite 同步驱动的 `.all()`
//          当场执行并交回数组，PG 交回 Promise。变异实测本文件 ④⑤ 两条只在
//          `[postgresql]` 上红。
//       ② 既不 `.all()`/`.run()` 也不 `await` 的**裸构建器** —— drizzle 的
//          `QueryPromise` 是惰性的，语句在**两个引擎上都一条不发**，双引擎全红。
//       ③ `.run()` 后漏 `await` —— 只有 PG 静默失真：SQLite 当场给出 `changes`，
//          PG 交回未 await 的 Promise、`changes` 恒 `undefined`，基于受影响行数的 CAS
//          判据会**无声通过**。本文件覆盖的三条查询**全是只读、零写点**，因此第三档在
//          这个作业面上不存在——不是没测，是构造不出来。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import {
  captureWorktrees,
  createPortableBackupApplicationAssets,
  reconstructWorktrees,
} from '@/platform/persistence/portableApplicationAssets'
import { createHealthDatabaseReadModel } from '@/modules/system-operations/infrastructure/healthReadModel'
import { extractTarGz } from '@/util/archive'
import { DomainError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `rfc359-w9-${prefix}-`))
  roots.push(root)
  return root
}

function cleanupRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

const EMPTY_DEFINITION = { $schema_version: 1, inputs: [], nodes: [], edges: [] }

async function seedWorkflow(
  db: ProviderNeutralDatabase,
  input: { readonly id: string; readonly name?: string; readonly definition?: string },
): Promise<void> {
  await db.insert(workflows).values({
    id: input.id,
    name: input.name ?? `workflow-${input.id}`,
    description: 'seeded by the W9 conformance harness',
    definition: input.definition ?? JSON.stringify(EMPTY_DEFINITION),
  })
}

async function seedTask(
  db: ProviderNeutralDatabase,
  input: {
    readonly id: string
    readonly status: string
    readonly worktreePath: string
    readonly repoPath: string
    readonly baseCommit?: string | null
  },
): Promise<void> {
  await db.insert(tasks).values({
    id: input.id,
    name: input.id,
    workflowId: 'workflow-w9',
    workflowSnapshot: JSON.stringify(EMPTY_DEFINITION),
    workflowVersion: 1,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${input.id}`,
    baseCommit: input.baseCommit ?? null,
    status: input.status as 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: input.id,
  })
}

/** 一个可归档的假 worktree：一个跟踪文件 + 一个必须被排除的 `.git`。 */
function makeWorktree(root: string, name: string, content: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'tracked.txt'), content)
  mkdirSync(join(path, '.git'), { recursive: true })
  writeFileSync(join(path, '.git', 'excluded'), 'must never be archived')
  return path
}

describeEachProvider('RFC-359 W9 System Operations application-asset reads', (harness) => {
  test('① countRunningTasks 只数 running，且两个引擎都交回 number（PG 的 count 回字符串）', async () => {
    const db = harness.db
    const root = tempRoot('health')
    const health = createHealthDatabaseReadModel(db)

    expect(await health.countRunningTasks()).toBe(0)

    await seedTask(db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      status: 'running',
      worktreePath: join(root, 'wt-1'),
      repoPath: root,
    })
    await seedTask(db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      status: 'running',
      worktreePath: join(root, 'wt-2'),
      repoPath: root,
    })
    await seedTask(db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
      status: 'done',
      worktreePath: join(root, 'wt-3'),
      repoPath: root,
    })

    const running = await health.countRunningTasks()
    expect(running).toBe(2)
    // PG 的 bigint 聚合经驱动交回的是字符串；`/health` 的 view 里这是个 number。
    expect(typeof running).toBe('number')
    cleanupRoots()
  })

  test('② exportWorkflows 导出规范 YAML：一 workflow 一文件、definition 迁到最新版', async () => {
    const db = harness.db
    const root = tempRoot('workflows')
    const destination = join(root, 'workflows')
    mkdirSync(destination, { recursive: true })

    await seedWorkflow(db, { id: '01ARZ3NDEKTSV4RRFFQ69G5FB1', name: 'Portable workflow' })
    await seedWorkflow(db, { id: '01ARZ3NDEKTSV4RRFFQ69G5FB2', name: 'Second workflow' })

    const assets = createPortableBackupApplicationAssets({ db })
    expect(await assets.exportWorkflows(destination)).toBe(2)

    const yaml = parseYaml(
      readFileSync(join(destination, '01ARZ3NDEKTSV4RRFFQ69G5FB1.yaml'), 'utf-8'),
    ) as Record<string, unknown>
    expect(yaml).toMatchObject({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
      name: 'Portable workflow',
      description: 'seeded by the W9 conformance harness',
      // 存的是 $schema_version 1，导出的必须是迁移到最新版之后的定义。
      definition: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
    })
    expect(existsSync(join(destination, '01ARZ3NDEKTSV4RRFFQ69G5FB2.yaml'))).toBe(true)
    cleanupRoots()
  })

  test('③ 损坏的 definition 在两个引擎上都是 422 workflow-definition-corrupt（PG 曾是裸 500）', async () => {
    const db = harness.db
    const root = tempRoot('corrupt')
    const destination = join(root, 'workflows')
    mkdirSync(destination, { recursive: true })

    await seedWorkflow(db, { id: '01ARZ3NDEKTSV4RRFFQ69G5FC1', definition: '{not-json' })
    await seedWorkflow(db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FC2',
      definition: JSON.stringify({ $schema_version: 1, nodes: 'not-an-array' }),
    })

    const assets = createPortableBackupApplicationAssets({ db })
    let thrown: unknown
    try {
      await assets.exportWorkflows(destination)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DomainError)
    const domain = thrown as DomainError
    expect(domain.code).toBe('workflow-definition-corrupt')
    expect(domain.status).toBe(422)
    expect(domain.details).toMatchObject({ workflowId: expect.any(String) })
    // 失败即失败:坏的那份绝不落一个半截 YAML。
    expect(existsSync(join(destination, '01ARZ3NDEKTSV4RRFFQ69G5FC1.yaml'))).toBe(false)
    cleanupRoots()
  })

  test('④ captureWorktrees 只抓 live 状态的行、排除 .git、超上限记为 skipped', async () => {
    const db = harness.db
    const root = tempRoot('capture')
    const staging = join(root, 'staging')
    const liveId = '01ARZ3NDEKTSV4RRFFQ69G5FD1'
    const doneId = '01ARZ3NDEKTSV4RRFFQ69G5FD2'
    const livePath = makeWorktree(root, 'live', 'live worktree payload\n')
    const donePath = makeWorktree(root, 'done', 'terminal worktree payload\n')

    await seedTask(db, {
      id: liveId,
      status: 'running',
      worktreePath: livePath,
      repoPath: root,
      baseCommit: 'a'.repeat(40),
    })
    await seedTask(db, { id: doneId, status: 'done', worktreePath: donePath, repoPath: root })

    const result = await captureWorktrees(db, staging)
    expect(result.captured).toEqual([liveId])
    expect(result.skipped).toEqual([])
    expect(existsSync(join(staging, 'worktrees', `${doneId}.tar.gz`))).toBe(false)

    const meta = JSON.parse(
      readFileSync(join(staging, 'worktrees', `${liveId}.json`), 'utf-8'),
    ) as Record<string, unknown>
    expect(meta).toMatchObject({
      taskId: liveId,
      worktreePath: livePath,
      branch: `agent-workflow/${liveId}`,
      repoPath: root,
      baseCommit: 'a'.repeat(40),
    })

    const extracted = join(root, 'extracted')
    mkdirSync(extracted, { recursive: true })
    await extractTarGz(join(staging, 'worktrees', `${liveId}.tar.gz`), extracted)
    expect(readFileSync(join(extracted, 'tracked.txt'), 'utf-8')).toBe('live worktree payload\n')
    expect(existsSync(join(extracted, '.git'))).toBe(false)

    // 上限是逐行判据，两个引擎必须给同一个 skipped 理由。
    const capped = await captureWorktrees(db, join(root, 'capped'), { maxBytes: 1 })
    expect(capped.captured).toEqual([])
    expect(capped.skipped).toHaveLength(1)
    expect(capped.skipped[0]?.taskId).toBe(liveId)
    expect(capped.skipped[0]?.reason).toContain('over cap')
    cleanupRoots()
  })

  test('⑤ reconstructWorktrees 的 findById 在两个引擎上给同一批 skip 理由', async () => {
    const db = harness.db
    const root = tempRoot('reconstruct')
    const staging = join(root, 'staging')
    const liveId = '01ARZ3NDEKTSV4RRFFQ69G5FE1'
    const terminalId = '01ARZ3NDEKTSV4RRFFQ69G5FE2'
    const goneId = '01ARZ3NDEKTSV4RRFFQ69G5FE3'
    const livePath = makeWorktree(root, 'live', 'live payload\n')
    const terminalPath = makeWorktree(root, 'terminal', 'terminal payload\n')
    const gonePath = makeWorktree(root, 'gone', 'gone payload\n')

    await seedTask(db, { id: liveId, status: 'running', worktreePath: livePath, repoPath: root })
    await seedTask(db, {
      id: terminalId,
      status: 'running',
      worktreePath: terminalPath,
      repoPath: root,
    })
    await seedTask(db, { id: goneId, status: 'running', worktreePath: gonePath, repoPath: root })

    // 先按 live 状态抓三份，再把其中两个的行改成「终态 / 不存在」。
    const captured = await captureWorktrees(db, staging)
    expect(captured.captured.sort()).toEqual([liveId, terminalId, goneId].sort())

    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, terminalId)).run()
    await db.delete(tasks).where(eq(tasks.id, goneId)).run()

    const result = await reconstructWorktrees(db, staging)
    // 三个 worktree 目录都还在盘上,所以 live 那个是「已存在,不覆盖」;
    // 另外两个必须分别按 DB 行的状态 / 存在性被挡掉——这正是 findById 的判据。
    expect(result.reconstructed).toEqual([])
    const reasons = new Map(result.skipped.map((entry) => [entry.taskId, entry.reason]))
    expect(reasons.get(liveId)).toBe('worktree already present (not overwritten)')
    expect(reasons.get(terminalId)).toBe('terminal (done)')
    expect(reasons.get(goneId)).toBe('task no longer in DB')
    cleanupRoots()
  })
})
