// RFC-359 W5 —— `parseDeleteCleanupPlan` 必须认得 **v1** 清理计划（PostgreSQL 独有的生产故障）。
//
// 为什么这条测试存在（bug 机制）：
//   `infrastructure/taskDeleteRecovery.ts` 的校验块里曾有一条**无条件**的
//   `!Array.isArray(parsed.directories) || !parsed.directories.every(...)` → `return null`，
//   紧接着的构造却是 `parsed.v === 2 ? parsed.directories : members.flatMap(...)`
//   ——v1 分支明确假设「v1 计划不带 directories，改从 members 推导」。两者自相矛盾：
//   任何 `v:1` 计划都在校验处就被判死，v1 分支是**不可达死代码**。
//
// 为什么只在 PostgreSQL 上炸：两侧写入方的计划形状不同。
//   - SQLite   `services/taskDelete.ts` 写 `{ v: 2, …, directories: [...] }`         → 恒通过；
//   - PostgreSQL `infrastructure/postgresqlTaskRouteOperations.ts` 写
//     `JSON.stringify({ v: 1, taskId, taskIds, worktrees })` —— **无 directories** → 恒 null。
//
// 用户可见后果（顺 `recoverInterruptedTaskDeletes` 代码确认过）：PG 上删任务中途崩溃后，
// 启动恢复（`cli/postgresqlDaemonApplication.ts` 调用）拿到 `plan === null`，直接把认领转成
// `recovery-required` 并 `continue`——于是
//   ① 根任务行与整棵级联树永不删除（`finalizeDeleteRowsTx` 根本不会跑）；
//   ② 成员任务一直挂在 claimed 成员表里，`released_at` 永远为空；
//   ③ worktree / runs / logs / scratch 永不回收（`cleanupDeletedTaskResources` 够不着）；
//   ④ 用户重删会被认领冲突 `task-terminal-maintenance-conflict` 挡住。
// 合起来就是**永久不可恢复**：每次 daemon 启动都重复走一遍 recovery-required，无人能推进。
//
// 修复：`directories` 的校验只对 `v === 2` 生效（v1 本来就不带它，改从 members 推导）。
// 本文件锁死三件事：v1 能被解析且 directories 按 members 推导；v2 行为一格不变；
// 真正的坏输入仍然返回 null（别把校验放宽成什么都收）。任何 refactor 把下面任一条弄红，
// 都意味着 PG 的删除崩溃恢复又回到了「永久卡死」那个形态。
//
// 测试形态说明：`parseDeleteCleanupPlan` 是不碰数据库的**纯函数**（输入是计划 JSON 串 +
// 成员快照数组），所以这里**不套** `describeEachProvider` —— 双引擎 harness 只会为一个纯函数
// 额外拉起一个真 PG 连接，既慢又把纯函数测试绑上外部依赖。provider 差异体现在「计划形状」上，
// 而两种形状在下面都被显式覆盖了。

import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseDeleteCleanupPlan } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import type { MaintenanceMemberSnapshot } from '@/modules/task-execution/domain/terminalMaintenance'
import { Paths } from '@/util/paths'

function member(taskId: string): MaintenanceMemberSnapshot {
  return {
    taskId,
    taskRevision: 1,
    ownerRevision: null,
    topologyRevision: 1,
    ledgerDigest: 'digest',
  }
}

/** 与 `services/taskDelete.ts` 的 v2 写入方逐字同形：每个成员三个根。 */
function expectedDirs(taskIds: readonly string[]): string[] {
  return taskIds.flatMap((id) => [
    join(Paths.runsDir, id),
    join(Paths.logsDir, id),
    join(Paths.root, 'scratch', id),
  ])
}

const WORKTREE = { repoPath: '/tmp/repo', worktreePath: '/tmp/wt' }

// ---------------------------------------------------------------------------
// v1（PostgreSQL 写出的形状）
// ---------------------------------------------------------------------------

test('v1 计划（PG 形状：无 directories）能被解析，directories 按 members 推导出三个根', () => {
  // `postgresqlTaskRouteOperations.ts` 的原样载荷：{ v, taskId, taskIds, worktrees }。
  const json = JSON.stringify({
    v: 1,
    taskId: 'task_root',
    taskIds: ['task_root', 'task_child'],
    worktrees: [{ taskId: 'task_root', ...WORKTREE }],
  })
  const plan = parseDeleteCleanupPlan(json, [member('task_root'), member('task_child')])

  expect(plan).not.toBeNull()
  expect(plan?.taskId).toBe('task_root')
  // 解析结果统一归一到 v2 的内部形状。
  expect(plan?.v).toBe(2)
  // 计划本身没有 parentTaskId 字段 → null（v1 不带它）。
  expect(plan?.parentTaskId).toBeNull()
  expect(plan?.directories).toEqual(expectedDirs(['task_root', 'task_child']))
})

test('v1 的 worktrees 原样保留（PG 的条目多带一个 taskId 字段也不影响）', () => {
  const json = JSON.stringify({
    v: 1,
    taskId: 'task_root',
    taskIds: ['task_root'],
    worktrees: [
      { taskId: 'task_root', repoPath: '/a/repo', worktreePath: '/a/wt' },
      { taskId: 'task_child', repoPath: '/b/repo', worktreePath: '/b/wt' },
    ],
  })
  const plan = parseDeleteCleanupPlan(json, [member('task_root')])

  expect(plan?.worktrees).toEqual([
    { taskId: 'task_root', repoPath: '/a/repo', worktreePath: '/a/wt' },
    { taskId: 'task_child', repoPath: '/b/repo', worktreePath: '/b/wt' },
  ] as never)
})

test('v1 + 零成员 → 解析成功且 directories 为空（不是 null）', () => {
  const json = JSON.stringify({ v: 1, taskId: 'task_root', taskIds: [], worktrees: [] })
  const plan = parseDeleteCleanupPlan(json, [])

  expect(plan).not.toBeNull()
  expect(plan?.directories).toEqual([])
})

test('v1 不消费 directories 字段：即便带了个畸形的也照样按 members 推导', () => {
  // 这是修复的**精确边界**：directories 的校验只对 v2 生效，v1 根本不读这个字段。
  const json = JSON.stringify({
    v: 1,
    taskId: 'task_root',
    taskIds: ['task_root'],
    worktrees: [],
    directories: 42,
  })
  const plan = parseDeleteCleanupPlan(json, [member('task_root')])

  expect(plan?.directories).toEqual(expectedDirs(['task_root']))
})

// ---------------------------------------------------------------------------
// v2（SQLite 写出的形状）—— 回归防护：一格都不许变
// ---------------------------------------------------------------------------

test('v2 计划：directories 用计划里写死的那份，完全忽略 members', () => {
  const json = JSON.stringify({
    v: 2,
    taskId: 'task_root',
    parentTaskId: 'task_parent',
    worktrees: [WORKTREE],
    directories: ['/planned/one', '/planned/two'],
  })
  // 故意给一组与计划无关的 members：v2 必须完全不看它们。
  const plan = parseDeleteCleanupPlan(json, [member('task_unrelated')])

  expect(plan).toEqual({
    v: 2,
    taskId: 'task_root',
    parentTaskId: 'task_parent',
    worktrees: [WORKTREE],
    directories: ['/planned/one', '/planned/two'],
  } as never)
})

test('v2 计划：空 directories 保持为空，不回退到 members 推导', () => {
  const json = JSON.stringify({
    v: 2,
    taskId: 'task_root',
    parentTaskId: null,
    worktrees: [],
    directories: [],
  })
  const plan = parseDeleteCleanupPlan(json, [member('task_root')])

  expect(plan?.directories).toEqual([])
})

test('v2 计划：parentTaskId 非串时归一为 null', () => {
  const json = JSON.stringify({
    v: 2,
    taskId: 'task_root',
    parentTaskId: 7,
    worktrees: [],
    directories: [],
  })

  expect(parseDeleteCleanupPlan(json, [])?.parentTaskId).toBeNull()
})

// ---------------------------------------------------------------------------
// 坏输入仍然是 null —— 修复不得把校验放宽成什么都收
// ---------------------------------------------------------------------------

const REJECTED: ReadonlyArray<readonly [string, unknown]> = [
  ['v:3（未知版本）', { v: 3, taskId: 't', worktrees: [], directories: [] }],
  ['v 缺失', { taskId: 't', worktrees: [], directories: [] }],
  ['v 非数字', { v: '1', taskId: 't', worktrees: [] }],
  ['taskId 非串', { v: 1, taskId: 7, worktrees: [] }],
  ['taskId 缺失', { v: 1, worktrees: [] }],
  ['worktrees 非数组', { v: 1, taskId: 't', worktrees: 'nope' }],
  ['worktrees 缺失', { v: 1, taskId: 't' }],
  ['worktrees 元素为 null', { v: 1, taskId: 't', worktrees: [null] }],
  ['worktrees 元素缺 repoPath', { v: 1, taskId: 't', worktrees: [{ worktreePath: '/wt' }] }],
  [
    'worktrees 元素 worktreePath 非串',
    { v: 1, taskId: 't', worktrees: [{ repoPath: '/repo', worktreePath: 3 }] },
  ],
  ['v:2 但 directories 缺失', { v: 2, taskId: 't', worktrees: [] }],
  ['v:2 但 directories 非数组', { v: 2, taskId: 't', worktrees: [], directories: 'nope' }],
  ['v:2 但 directories 含非串元素', { v: 2, taskId: 't', worktrees: [], directories: ['/ok', 5] }],
]

for (const [label, payload] of REJECTED) {
  test(`坏计划仍返回 null：${label}`, () => {
    expect(parseDeleteCleanupPlan(JSON.stringify(payload), [member('task_root')])).toBeNull()
  })
}

test('非 JSON 串返回 null', () => {
  expect(parseDeleteCleanupPlan('not json at all', [member('task_root')])).toBeNull()
})
