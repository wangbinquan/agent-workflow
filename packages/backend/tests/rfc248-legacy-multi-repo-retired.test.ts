// RFC-248 T26/T32 —— RFC-066 的 wire `repos[]` 多仓路径**已退役**。
//
// 这个文件取代 `start-task-multi-repo-materialize.test.ts`（已删）。那份文件的
// 七条用例锁的全是旧路径的行为：`worktrees/multi/{taskId}` 父目录、basename
// 平铺、`-2` 后缀去重、`tasks.*` 镜像 repos[0]、单元素 `repos[]` 与单仓等价。
// 那条分支连同 `resolveMultiRepoDirName` 一并删除（101 行），因为：
//
//   - 顶层 `repos` 进了 `RETIRED_START_TASK_KEYS`，任何带它的 body 在 zod
//     解析**之前**就被硬拒（非 strict zod 会静默剥除，不硬拒就会在错误的工作区
//     里成功启动并返回 200——设计门一轮 G1）；
//   - 多仓一律经 `repoGroupId` 走 `materializeGroupSpace`，它支持挂根、任意
//     嵌套、sparse 子目录、只读成员与同仓多份，是旧分支的**严格超集**；
//   - 旧分支的等价覆盖已由 `rfc248-materialize-group.test.ts` 承接（那份文件
//     的「五个 worktree」用例一次覆盖了原 B7/B8/B10/B12 四条的语义，并额外覆盖
//     了旧路径根本做不到的嵌套 / sparse / 只读 / 同仓两份）。
//
// 本文件只锁「退役这件事本身」——它是防复活的守卫。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  RETIRED_START_TASK_KEYS,
  StartTaskSchema,
  rejectRetiredStartTaskKeys,
} from '@agent-workflow/shared'

const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')

describe('RFC-248 —— wire `repos[]` 退役', () => {
  test('顶层 repos 在 schema 解析**之前**被硬拒', () => {
    // 这是最关键的一条。zod 非 strict 会把未知键静默剥除，于是一个带
    // `repos: [...]` 的旧客户端请求会「成功」——但跑在完全不是它要的工作区里。
    expect(rejectRetiredStartTaskKeys({ workflowId: 'w', name: 'n', repos: [] })).toBe('repos')
    expect(
      rejectRetiredStartTaskKeys({ workflowId: 'w', name: 'n', repos: [{ repoUrl: 'x' }] }),
    ).toBe('repos')
  })

  test('repos 在退役键清单里', () => {
    expect([...RETIRED_START_TASK_KEYS]).toContain('repos')
  })

  test('StartTaskSchema 不再产出 repos 字段（即便传了也被剥除）', () => {
    const parsed = StartTaskSchema.safeParse({
      workflowId: 'w',
      name: 'n',
      inputs: {},
      repoUrl: 'https://h/o/a.git',
      repos: [{ repoUrl: 'https://h/o/b.git' }],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect('repos' in parsed.data).toBe(false)
  })

  test('三态互斥：单仓 + 仓库组同时给 → start-task-source-conflict', () => {
    const parsed = StartTaskSchema.safeParse({
      workflowId: 'w',
      name: 'n',
      inputs: {},
      repoUrl: 'https://h/o/a.git',
      repoGroupId: 'g1',
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(true)
    }
  })

  test('三态互斥：一个都不给 → start-task-source-required', () => {
    const parsed = StartTaskSchema.safeParse({ workflowId: 'w', name: 'n', inputs: {} })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message === 'start-task-source-required')).toBe(true)
    }
  })

  test('仓库组单独给 → 通过', () => {
    const parsed = StartTaskSchema.safeParse({
      workflowId: 'w',
      name: 'n',
      inputs: {},
      repoGroupId: 'g1',
    })
    expect(parsed.success).toBe(true)
  })

  test('源码层：旧多仓分支与 resolveMultiRepoDirName 不得复活', () => {
    // `worktrees/multi/` 命名空间与 basename `-2` 后缀是旧分支的两个指纹。
    // 锚「定义 / 调用」而不是裸提名——上面那段解释为什么删掉它的注释里就有
    // 这个词，裸子串会把说明文字本身当成复活。
    expect(TASK_SRC.includes('function resolveMultiRepoDirName')).toBe(false)
    expect(TASK_SRC.includes('resolveMultiRepoDirName(')).toBe(false)
    expect(TASK_SRC.includes("'worktrees', 'multi'")).toBe(false)
    // 正向锚：组路径确实在。
    expect(TASK_SRC.includes("'worktrees', 'group'")).toBe(true)
    expect(TASK_SRC.includes('materializeGroupSpace')).toBe(true)
  })
})
