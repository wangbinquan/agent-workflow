// RFC-248 AC-19 —— 只读成员被改动过这件事必须**看得见**。
//
// D11 说只读成员不快照、不进 diff、不自动提交推送。但框架**不在文件系统层面
// 阻止写入**——agent 拿到的是一个普通目录，它完全可能往里写。这时如果什么都
// 不说，用户遇到的是本 RFC 里最难排查的一类问题：
//
//   agent 报告「已修复 vendor/sdk 的 bug」→ 工作树里确实改了 → 推上去空空如也。
//
// 所以收尾时要把「丢弃了几处改动」**持久化**到 `task_repos.readonly_dirty_count`
// （迁移 0133），任务详情据此在那个成员旁边显示告警。
//
// 三态语义（UI 要能区分「干净」与「没查过」）：
//   NULL = 从未检查（可写成员 / RFC-248 之前的存量任务）
//   0    = 检查过且干净
//   N>0  = 丢弃了 N 处

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskRepos, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
})

describe('migration 0133 —— task_repos.readonly_dirty_count', () => {
  test('列存在且默认 NULL（存量行不被回填成 0）', () => {
    const cols = db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      sql`PRAGMA table_info(task_repos)`,
    )
    const col = cols.find((c) => c.name === 'readonly_dirty_count')
    expect(col).toBeDefined()
    // 可空：存量行「从未检查」与新行「检查过且干净」必须能区分开。把存量
    // 回填成 0 会谎称「我们查过了，是干净的」。
    expect(col!.notnull).toBe(0)
    expect(col!.dflt_value).toBeNull()
  })

  test('三态都能写入并读回', () => {
    // 外键链：task_repos.task_id → tasks.id → workflows.id，两级都得先落行。
    db.insert(workflows).values({ id: 'wf', name: 'w', definition: '{}' }).run()
    db.insert(tasks)
      .values({
        id: 't1',
        name: 'n',
        workflowId: 'wf',
        workflowSnapshot: '{}',
        repoPath: '/tmp/a',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        branch: 'b',
        inputs: '{}',
        status: 'pending',
        startedAt: Date.now(),
        repoCount: 3,
      })
      .run()
    const base = {
      taskId: 't1',
      repoPath: '/tmp/a',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      worktreePath: '/tmp/wt',
      worktreeDirName: '',
      mountPath: '',
      subdir: '',
      readonly: true,
    }
    db.insert(taskRepos)
      .values([
        { ...base, repoIndex: 0 },
        { ...base, repoIndex: 1, mountPath: 'clean', readonlyDirtyCount: 0 },
        { ...base, repoIndex: 2, mountPath: 'dirty', readonlyDirtyCount: 7 },
      ])
      .run()
    const rows = db.select().from(taskRepos).orderBy(taskRepos.repoIndex).all()
    expect(rows.map((r) => r.readonlyDirtyCount)).toEqual([null, 0, 7])
  })
})

describe('AC-19 —— 语义边界', () => {
  /** 只读脏检查的实现体（实现门 P1 后从提交推送路径搬到了任务终态收尾）。 */
  async function inspectorSource(): Promise<string> {
    const src = await Bun.file(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    ).text()
    const i = src.indexOf('async function inspectReadonlyRepos(')
    expect(i).toBeGreaterThan(0)
    return src.slice(i, src.indexOf('\n}\n', i))
  }

  test('检查挂在**任务终态收尾**，不是搭在自动提交推送里（实现门 P1）', async () => {
    // 搭在 `maybeRunCommitPush` 里的话，只有 `autoCommitPush=true` 且顶层节点
    // 成功的任务才会被检查——默认配置的任务、失败 / 取消的任务全都漏掉，
    // `readonly_dirty_count` 永远是 NULL、详情页永远没有提示。
    const src = await Bun.file(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    ).text()
    const callIdx = src.indexOf('await inspectReadonlyRepos(state, log)')
    expect(callIdx).toBeGreaterThan(0)
    // 调用点在终态分派**之前**（failed / canceled / awaiting_* / done 都在它后面）。
    expect(callIdx).toBeLessThan(src.indexOf("if (result.kind === 'failed'"))
    // 而且不在 maybeRunCommitPush 体内。
    const cpIdx = src.indexOf('async function maybeRunCommitPush(')
    expect(callIdx).toBeLessThan(cpIdx)
  })

  test('**不**使用 lifecycle_alerts 通道', async () => {
    // RFC-108 的自动修复循环会全局扫描 `lifecycle_alerts` 并尝试**修复**每一
    // 条。「只读仓被改动了」不是待修复的不变量违反，是给人看的事实通报——
    // 塞进那张表会被误修。这条锁住实现没有走那条路。
    const body = await inspectorSource()
    expect(body).toContain('readonlyDirtyCount')
    expect(body).not.toContain('lifecycleAlerts')
  })

  test('干净时也写 0 —— 不是只在脏的时候才写', async () => {
    // 只在脏时写会让「干净」与「没查过」永远无法区分，UI 也就没法说
    // 「这个只读成员确认没被动过」。
    const body = await inspectorSource()
    // 写入语句在 `if (changed.length > 0)` 的**外面**：先无条件写计数，
    // 再按需打日志。
    const writeAt = body.indexOf('readonlyDirtyCount: changed.length')
    const guardAt = body.indexOf('if (changed.length > 0)')
    expect(writeAt).toBeGreaterThan(0)
    expect(guardAt).toBeGreaterThan(0)
    expect(writeAt).toBeLessThan(guardAt)
  })
})
