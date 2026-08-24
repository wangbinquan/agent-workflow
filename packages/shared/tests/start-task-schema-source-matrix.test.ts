// RFC-066 时代这里锁的是 `repos[]` 多仓数组的 schema 契约。
//
// **RFC-248 T32 把那条 wire 退役了**：多仓的唯一入口是 `repoGroupId`（布局、
// ref、只读、嵌套全在组定义里），顶层 `repos` 进了 `RETIRED_START_TASK_KEYS`
// 由 `rejectRetiredStartTaskKeys` 在**任何 parse 之前**硬拒 422。
//
// 为什么不是「删字段就完了」：`StartTaskSchema` 是**非 strict** zod，未知键会
// 被静默剥除。老客户端发 `{workflowId, name, repos:[a,b]}` 会「解析成功」，然后
// 落进一个**没有任何来源**的 body——最好的情况是 422，最坏的情况是启动在错误的
// 工作区。所以退役必须是显式硬拒，且这一层测试要证明它。
//
// 本文件现在锁 RFC-248 的**来源矩阵**：scratch / 单仓 / 仓库组 / 冻结快照重放，
// 四选一，两两互斥。原 `start-task-schema-multi-repo-combined.test.ts`（锁
// 「多仓来源不得短路后续 identity / working-branch refinement」）也并入这里的
// 最后一个 describe——它的主题不变，只是来源从 `repos[]` 换成了 `repoGroupId`。

import { describe, expect, test } from 'bun:test'
import { StartTaskSchema, rejectRetiredStartTaskKeys } from '../src/schemas/task'

const BASE = { workflowId: 'wf1', name: 't', inputs: {} }
const firstMessage = (body: unknown): string | undefined => {
  const r = StartTaskSchema.safeParse(body)
  return r.success ? undefined : r.error.issues[0]?.message
}

describe('RFC-248 —— 启动来源四选一', () => {
  test('仓库组：只给 repoGroupId 就通过', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, repoGroupId: 'grp_1' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.repoGroupId).toBe('grp_1')
  })

  test('单仓：repoUrl / cachedRepoId 照旧通过', () => {
    expect(StartTaskSchema.safeParse({ ...BASE, repoUrl: 'git@h:o/r.git' }).success).toBe(true)
    expect(StartTaskSchema.safeParse({ ...BASE, cachedRepoId: 'cr_1' }).success).toBe(true)
  })

  test('scratch：临时空间通过', () => {
    expect(StartTaskSchema.safeParse({ ...BASE, scratch: true }).success).toBe(true)
  })

  test('冻结快照重放（H9 重启）：只给 sourceTaskId 就通过', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, sourceTaskId: 'tsk_1' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sourceTaskId).toBe('tsk_1')
  })

  test('一个来源都不给 → start-task-source-required', () => {
    expect(firstMessage({ ...BASE })).toBe('start-task-source-required')
  })
})

describe('RFC-248 —— 来源两两互斥', () => {
  test('单仓 + 组 → start-task-source-conflict', () => {
    expect(firstMessage({ ...BASE, repoUrl: 'git@h:o/r.git', repoGroupId: 'grp_1' })).toBe(
      'start-task-source-conflict',
    )
    expect(firstMessage({ ...BASE, cachedRepoId: 'cr_1', repoGroupId: 'grp_1' })).toBe(
      'start-task-source-conflict',
    )
  })

  test('组 + 冻结快照 → start-task-source-conflict（无法判断该用哪个布局）', () => {
    expect(firstMessage({ ...BASE, repoGroupId: 'grp_1', sourceTaskId: 'tsk_1' })).toBe(
      'start-task-source-conflict',
    )
  })

  test('单仓 + 冻结快照 → start-task-source-conflict', () => {
    expect(firstMessage({ ...BASE, repoUrl: 'git@h:o/r.git', sourceTaskId: 'tsk_1' })).toBe(
      'start-task-source-conflict',
    )
  })

  test('scratch + 任何来源 → scratch-source-conflict', () => {
    for (const extra of [
      { repoUrl: 'git@h:o/r.git' },
      { cachedRepoId: 'cr_1' },
      { repoGroupId: 'grp_1' },
      { sourceTaskId: 'tsk_1' },
    ]) {
      expect(firstMessage({ ...BASE, scratch: true, ...extra })).toBe('scratch-source-conflict')
    }
  })
})

describe('RFC-248 —— `repos[]` 的硬拒（非 strict zod 的静默剥除防线）', () => {
  test('顶层 repos 被退役键守卫点名', () => {
    expect(rejectRetiredStartTaskKeys({ ...BASE, repos: [{ repoUrl: 'x' }] })).toBe('repos')
  })

  test('键存在即触发——值是 undefined / null / 空数组也算', () => {
    expect(rejectRetiredStartTaskKeys({ repos: undefined })).toBe('repos')
    expect(rejectRetiredStartTaskKeys({ repos: null })).toBe('repos')
    expect(rejectRetiredStartTaskKeys({ repos: [] })).toBe('repos')
  })

  test('绕过守卫直接 parse 时，repos 被剥除且**不会**冒充来源', () => {
    // 这是守卫存在的理由：schema 这一层看不见 repos，于是 body 变成「无来源」
    // 而不是「多仓」。若守卫哪天被摘掉，这条会以 source-required 的形式暴露
    // 出降级，而不是让任务悄悄跑在错误的工作区。
    expect(firstMessage({ ...BASE, repos: [{ repoUrl: 'x' }] })).toBe('start-task-source-required')
  })

  test('组来源 + 杂散 repos → 守卫先命中 repos', () => {
    expect(rejectRetiredStartTaskKeys({ ...BASE, repoGroupId: 'grp_1', repos: [] })).toBe('repos')
  })
})

describe('RFC-248 —— 组来源与其余启动字段共存', () => {
  test('组 + workingBranch + autoCommitPush 一起通过', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      repoGroupId: 'grp_1',
      workingBranch: 'feat/x',
      autoCommitPush: true,
    })
    expect(r.success).toBe(true)
  })

  test('组 + 退役 git 身份 → raw guard 命中服务端所有权错误', () => {
    expect(
      rejectRetiredStartTaskKeys({
        ...BASE,
        repoGroupId: 'grp_1',
        gitUserName: 'forged',
      }),
    ).toBe('gitUserName')
  })

  test('组 + 非法分支名仍由 workingBranch 自己报错', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      repoGroupId: 'grp_1',
      workingBranch: 'bad branch',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const branch = r.error.issues.find((i) => i.message === 'working-branch-invalid')
      expect(branch?.path).toEqual(['workingBranch'])
      expect(r.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(false)
    }
  })

  test('组 + 合法分支 + autoCommitPush → 字段原样落到 data 上', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      repoGroupId: 'grp_1',
      workingBranch: 'feature/x',
      autoCommitPush: true,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.repoGroupId).toBe('grp_1')
      expect('gitUserName' in r.data).toBe(false)
      expect('gitUserEmail' in r.data).toBe(false)
      expect(r.data.workingBranch).toBe('feature/x')
      expect(r.data.autoCommitPush).toBe(true)
    }
  })
})
