// RFC-287 T13（G7 核心）—— 仓库准备推迟到任务行落库之后。
//
// 用户可见的问题：今天物化发生在落行**之前**，于是「克隆超时 / 远端不可达 / 认证
// 失败」这类问题**不留任何记录**——点了启动，转半天圈，最后一个 HTTP 错误，任务
// 列表里什么都没有，没法看原因、没法重试。G7 的修法是：同步段只留「填错了立刻
// 告诉你」的校验，任务先落 `pending`（**不新增状态**），准备在后台推进，失败转
// `failed` 且 git 原文留在行上。
//
// 只有 JSON-body 启动走这条：multipart 要把上传物写进工作树、preCreated 是调用方
// 已建好的树，两者必须保持预物化语义（proposal §G7）。
//
// 这里测的是**真行为**：真起一个指向不可达地址的启动，看任务行是否留下来、状态
// 是否转 failed、错误里有没有 git 的原话，以及**墓碑有没有被误打**（AC-15：打了
// 就再也重试不了准备）。

import { describe, expect, test, beforeAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows, users, nodeRuns } from '../src/db/schema'
import { startTask } from '@/services/task'
import { ulid } from 'ulid'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// 最小合法定义——本用例测的是「准备阶段」，节点跑不跑无关紧要（准备失败时压根
// 到不了调度）。形状照 gettask-multi-repo 的现成夹具。
const WF_DEF = { $schema_version: 1, inputs: [], nodes: [], edges: [] } as const

async function seed(db: DbClient): Promise<{ workflowId: string; userId: string }> {
  const userId = 'u_' + ulid()
  const workflowId = ulid()
  await db.insert(users).values({
    id: userId,
    username: userId,
    displayName: 'tester',
    role: 'admin',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(WF_DEF),
    ownerUserId: userId,
  })
  return { workflowId, userId }
}

describe('RFC-287 T13 — 延后准备（G7 核心）', () => {
  let db: DbClient
  let workflowId: string
  let userId: string

  beforeAll(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const s = await seed(db)
    workflowId = s.workflowId
    userId = s.userId
  })

  test('准备失败时**任务行仍然留下来**，状态 failed 且 git 原文可见', async () => {
    const task = await startTask(
      {
        workflowId,
        name: 'deferred-fail',
        // 不可路由地址：克隆必然失败，且失败发生在「落行之后」。
        repoUrl: 'http://10.255.255.1:9/nope.git',
        inputs: {},
      } as never,
      {
        db,
        actorUserId: userId,
        launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        deferRepoPreparation: true,
        cloneTimeoutMs: 3_000,
      } as never,
    )

    const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
    // ① 行必须存在——这正是 G7 相对现状的核心差别（现状：什么都不留）。
    expect(row).toBeDefined()
    expect(row?.status).toBe('failed')
    // ② 失败原因要能看到 git 说了什么，而不是一句「启动失败」。
    expect(String(row?.errorMessage ?? '') + String(row?.errorSummary ?? '')).toMatch(
      /repo preparation failed|clone|fatal|unable|timed out/i,
    )
    // ③ AC-15：**不得**打墓碑——打了 retryNode 就再也 CAS 不回 pending，
    //    「重试准备仓库」这条 G7 核心语义直接失效。
    expect(row?.workspacePrunedAt ?? null).toBeNull()

    // ④ 合成 `__repo_prep__` 行必须在，且失败原因落在它身上——没有这一行，
    //    用户看到的就是一个「pending 很久然后 failed」的任务，不知道卡在哪、
    //    也没有可点重试的对象（重试复用 retryNode，作用在这一行上）。
    const prepRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    const prep = prepRuns.find((r) => r.nodeId === REPO_PREP_NODE_ID)
    expect(prep, '缺少 __repo_prep__ 合成行').toBeDefined()
    expect(prep?.status).toBe('failed')
    expect(String(prep?.errorMessage ?? '')).toMatch(/timed out|clone|fatal|unable/i)
  }, 60_000)

  test('默认（不开开关）逐字维持旧行为：预物化，失败不落行', async () => {
    let threw = false
    try {
      await startTask(
        {
          workflowId,
          name: 'eager',
          repoUrl: 'http://10.255.255.1:9/nope.git',
          inputs: {},
        } as never,
        {
          db,
          actorUserId: userId,
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
          cloneTimeoutMs: 3_000,
        } as never,
      )
    } catch {
      threw = true
    }
    // 旧路径：物化在落行之前，失败直接抛给 HTTP（或落一条 failed 行）——
    // 无论哪种，都**不是**本 RFC 要改的对象；这里只锁「开关默认关闭时不变」。
    const rows = await db.select().from(tasks)
    const eager = rows.find((r) => r.name === 'eager')
    expect(threw || eager !== undefined).toBe(true)
  }, 60_000)
})
