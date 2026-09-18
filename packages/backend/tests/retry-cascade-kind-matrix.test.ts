// RFC-053 PR-A T1d — retry-cascade kind matrix.
//
// For every NodeKind, verify `retry`'s cascade behavior when that kind is
// DOWNSTREAM of the user-clicked target:
//   - agent-single / wrappers / calls / script / code-host-call → mint placeholder
//     (RFC-060 PR-E: agent-multi removed)
//   - review / clarify / output / input                       → SKIP
//
// The user-clicked target (`runRow.nodeId`) is minted regardless of kind,
// with ONE carve-out (RFC-098 B3, audit ⑥-11): a WRAPPER's own
// canceled/interrupted row is a revival signal — minting a failed placeholder
// over it would shadow the resumable row and restart the wrapper from
// iteration 0 instead of continuing (rfc095-wrapper-canceled-revival locks
// the end-to-end continue semantics; the TARGET tests below pin the mint
// matrix including the carve-out).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { cancelViaEngine } from './helpers/cancelEngine'
import { describeEachProvider } from './helpers/eachProvider'
import { POSTGRESQL_SERIALIZATION_ATTEMPTS } from '@/platform/persistence/postgresqlSerializationRetry'
import { runGit } from '../src/util/git'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import { minimalNodeOfKind } from './helpers/nodeKindFixtures'
import { createRetryEngine } from './helpers/retryEngine'

const DOWNSTREAM_KINDS_MINT = [
  'agent-single',
  'wrapper-git',
  'wrapper-loop',
  'wrapper-fanout',
  'call-workflow',
  'call-workgroup',
  'script',
  'code-host-call',
] as const satisfies readonly NodeKind[]

const DOWNSTREAM_KINDS_SKIP = [
  'review',
  'clarify',
  'clarify-cross-agent',
  'output',
  'input',
] as const satisfies readonly NodeKind[]

interface Harness {
  db: ProviderNeutralDatabase
  appHome: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(db: ProviderNeutralDatabase): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1d-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])
  return {
    db,
    appHome,
    repoPath,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

async function seedTaskWithEdge(
  h: Harness,
  downstreamNodeId: string,
  downstreamKind: NodeKind,
): Promise<{ taskId: string; agentRunId: string }> {
  // Build a minimal 2-node definition: agent_a → downstream.
  // Downstream node config minimally satisfies the kind:
  // RFC-359 AC-1（第 9 刀第 1 步）：节点形状抽到共享夹具，与双引擎级联对拍共用一份。
  const downstreamNode = minimalNodeOfKind(downstreamNodeId, downstreamKind, 'agent_a')

  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'agent_a', kind: 'agent-single', agentName: 'doc', promptTemplate: '' },
      downstreamNode,
    ] as never,
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'agent_a', portName: 'out' },
        target: { nodeId: downstreamNodeId, portName: 'in' },
      },
    ],
  }
  const workflowId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'failed',
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    errorSummary: 'boom',
  })
  const agentRunId = ulid()
  await h.db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: 'agent_a',
    status: 'failed',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 200,
    finishedAt: Date.now() - 100,
  })
  // Seed a previous row on the downstream node so existing.retryIndex
  // computation has a baseline (otherwise placeholders start at 0 — also
  // valid, but seeding makes intent explicit).
  await h.db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: downstreamNodeId,
    status:
      downstreamKind === 'review'
        ? 'awaiting_review'
        : downstreamKind === 'clarify'
          ? 'done'
          : downstreamKind === 'output'
            ? 'done'
            : downstreamKind === 'input'
              ? 'done'
              : 'done',
    retryIndex: 0,
    reviewIteration: 0,
    iteration: 0,
    startedAt: Date.now() - 90,
    finishedAt: downstreamKind === 'review' ? null : Date.now() - 80,
  })
  return { taskId, agentRunId }
}

async function seedLiveChildForCallRow(
  h: Harness,
  parentTaskId: string,
  callRunId: string,
): Promise<string> {
  const parent = (await h.db.select().from(tasks).where(eq(tasks.id, parentTaskId)))[0]!
  const childId = ulid()
  await h.db.insert(tasks).values({
    id: childId,
    name: `child-${childId.slice(-6).toLowerCase()}`,
    workflowId: parent.workflowId,
    workflowSnapshot: parent.workflowSnapshot,
    repoPath: parent.repoPath,
    worktreePath: parent.worktreePath,
    baseBranch: parent.baseBranch,
    branch: `agent-workflow/${childId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now() - 50,
    parentTaskId,
    parentNodeRunId: callRunId,
    invocationDepth: 1,
  })
  await h.db.update(nodeRuns).set({ childTaskId: childId }).where(eq(nodeRuns.id, callRunId))
  return childId
}

/** Keep one task moving between cancelable states before every task-cancel CAS. */
/**
 * 让子任务在每一次 task-cancel CAS 之前换一次可取消状态，于是那笔 CAS 永远赢不了。
 *
 * RFC-359：注入点跟着实现走。它先是从「外面包 db 代理拦 `db.transaction`」挪进被测代码内部
 * （`retryNode.childCancelBeforeStatusCas`）——统一事务原语不走 drizzle 的 `db.transaction`，
 * 旧注入器**一次都不触发**，用例照样绿却一个并发场景都没验（`docs/dev-gotchas.md` 有完整复盘）；
 * 第 9 刀合并两份 `retry` 之后，级联取消本身成了依赖（`cancelChildTaskForCascade`），
 * 注入点就是 `retryVia` 往那条依赖里穿的 `cancelTask.beforeStatusCas` → `setTaskStatus.beforeCas`
 * （生产都不传）。
 *
 * 目标状态是**读当前值再翻**，不是固定轮换：搅动与 CAS 之间不再隔着事务边界，
 * 固定轮换会与 CAS 的期望值对上号，几轮之后反而让 CAS 赢了。
 */
function starveTaskCancelCas(
  db: ProviderNeutralDatabase,
  taskId: string,
  onAttempt: () => void,
): () => Promise<void> {
  return async () => {
    const current = (
      await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
    )[0]?.status
    if (current !== 'awaiting_review' && current !== 'awaiting_human') return
    onAttempt()
    const next = current === 'awaiting_review' ? 'awaiting_human' : 'awaiting_review'
    await db.update(tasks).set({ status: next }).where(eq(tasks.id, taskId))
  }
}

/**
 * RFC-359 AC-1（第 9 刀）—— 本文件的 `retry` 入口：共用实现 + 生产同形的级联取消。
 *
 * 级联取消在共用实现里是一个**依赖**（`cancelChildTaskForCascade`），生产由 `server.ts`
 * 绑成 `cancelViaEngine(db, childTaskId, { cascadeFromParent: true })`——这里绑的是同一句，
 * 只是多穿一个 `beforeStatusCas` 给下面两条并发判据用。注入点仍然跟着实现走：
 * 合并前它是被测代码内部的 `retryNode.childCancelBeforeStatusCas`，合并后它就是这条依赖本身。
 */
function retryVia(
  harness: Harness,
  input: { taskId: string; nodeRunId: string; cascade: boolean },
  childCancelBeforeStatusCas?: () => void | Promise<void>,
): Promise<unknown> {
  return createRetryEngine(harness.db, {
    appHome: harness.appHome,
    cancelChildTaskForCascade: async (childTaskId) => {
      await cancelViaEngine(harness.db, childTaskId, {
        cascadeFromParent: true,
        ...(childCancelBeforeStatusCas === undefined
          ? {}
          : { beforeStatusCas: childCancelBeforeStatusCas }),
      })
    },
  }).retry(input)
}

// RFC-359 AC-1（第 11 刀下半）**转双引擎**——上一版注释预告的那个前提已经到了。
//
// 它当年之所以是单引擎：下面两条并发判据要往级联取消里注入失败，而那个缝
// （`beforeStatusCas`）只长在 SQLite 根绑的 `cancelTask` 上，PostgreSQL 根绑的是
// `postgresqlChildTaskLifecycleParticipant.cancel`，是**另一份实现**——把 `cancelTask`
// 喂给 PG 库能跑，但那不是 PG 部署里真正会执行的那份，双引擎跑出来的绿是假的。
// 原注释写着：「真正的处置是把 `ChildTaskLifecycleParticipant` 这一对也合一，
// 那时注入点会和 `retry` 一样落在依赖面上，这一份自然能转双引擎。」合一已经做完
// （`cancelTaskProjection` 是**唯一**一份，两个根都绑它），于是照着办。
describeEachProvider('RFC-053 PR-A T1d — retry cascade kind matrix', (provider) => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness(provider.db)
  })
  afterEach(() => h.cleanup())

  for (const kind of DOWNSTREAM_KINDS_MINT) {
    test(`MINT — downstream kind '${kind}' gets placeholder row at retryIndex+1`, async () => {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, kind)

      await retryVia(h, { taskId: taskId, nodeRunId: agentRunId, cascade: true })

      const placeholders = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.errorMessage === 'queued for retry')
      const onDownstream = placeholders.find((r) => r.nodeId === downId)
      expect(onDownstream).toBeDefined()
      expect(onDownstream!.retryIndex).toBe(1)
      expect(onDownstream!.status).toBe('failed')
    })
  }

  for (const kind of DOWNSTREAM_KINDS_SKIP) {
    test(`SKIP — downstream kind '${kind}' is NOT minted (RFC-052)`, async () => {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, kind)

      await retryVia(h, { taskId: taskId, nodeRunId: agentRunId, cascade: true })

      const placeholders = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.errorMessage === 'queued for retry')
      expect(placeholders.find((r) => r.nodeId === downId)).toBeUndefined()
    })
  }

  test('CALL target — CAS winner cancels its live child before minting the next generation', async () => {
    const downId = 'down_call_workflow'
    const { taskId } = await seedTaskWithEdge(h, downId, 'call-workflow')
    const callRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === downId,
    )!
    // rfc053-allow-direct-status-write -- realistic failed-parent/live-call test seeding
    await h.db
      .update(nodeRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(nodeRuns.id, callRow.id))
    const childId = await seedLiveChildForCallRow(h, taskId, callRow.id)

    await retryVia(h, { taskId: taskId, nodeRunId: callRow.id, cascade: false })

    const child = (await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]!
    expect(child.status).toBe('canceled')
    expect(child.errorMessage).toBe('canceled-by-parent-cascade')
    const callRows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === downId,
    )
    expect(callRows.some((r) => r.retryIndex === 1 && r.errorMessage === 'queued for retry')).toBe(
      true,
    )
  })

  test('upstream cascade — cancels the downstream CALL row live child before minting', async () => {
    const downId = 'down_call_workgroup'
    const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, 'call-workgroup')
    const callRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === downId,
    )!
    // rfc053-allow-direct-status-write -- realistic failed-parent/live-call test seeding
    await h.db
      .update(nodeRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(nodeRuns.id, callRow.id))
    const childId = await seedLiveChildForCallRow(h, taskId, callRow.id)

    await retryVia(h, { taskId: taskId, nodeRunId: agentRunId, cascade: true })

    const child = (await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]!
    expect(child.status).toBe('canceled')
    expect(child.errorMessage).toBe('canceled-by-parent-cascade')
    const callRows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === downId,
    )
    expect(callRows.some((r) => r.retryIndex === 1 && r.errorMessage === 'queued for retry')).toBe(
      true,
    )
  })

  test('unexpected child cancellation error fails closed without rollback/mint or pending task', async () => {
    const downId = 'down_call_workflow'
    const { taskId } = await seedTaskWithEdge(h, downId, 'call-workflow')
    const callRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === downId,
    )!
    // rfc053-allow-direct-status-write -- realistic failed-parent/live-call test seeding
    await h.db
      .update(nodeRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(nodeRuns.id, callRow.id))
    const childId = await seedLiveChildForCallRow(h, taskId, callRow.id)

    // RFC-359：注入点在级联取消这条**依赖**上（`retryVia` 往 `cancelTask` 穿 `beforeStatusCas`，
    // 生产不传），不再包 db 代理拦 `db.transaction`——统一事务原语不走它，旧注入器一次都不触发，
    // 用例照样绿却什么都没验（`docs/dev-gotchas.md` 有完整复盘）。
    // 判据不变：子任务取消这一笔写失败时，retry 必须 fail-closed 成 `retry-child-cancel-failed`，
    // 且不回滚、不 mint、不留 pending 任务。
    let childCancelAttempts = 0
    const childCancelBeforeStatusCas = (): void => {
      childCancelAttempts += 1
      if (childCancelAttempts === 1) {
        throw new Error('injected child cancel write failure')
      }
    }

    await expect(
      retryVia(
        h,
        { taskId: taskId, nodeRunId: callRow.id, cascade: false },
        childCancelBeforeStatusCas,
      ),
    ).rejects.toMatchObject({ code: 'retry-child-cancel-failed' })

    const parent = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const child = (await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]!
    expect(parent.status).toBe('failed')
    expect(parent.errorSummary).toBe('retry-child-cancel-failed')
    expect(child.status).toBe('awaiting_human')
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (r) => r.errorMessage === 'queued for retry',
      ),
    ).toHaveLength(0)
    // 同上：这条也跑注入的取消钩子，同一次 CI 里跟着从 37ms 涨到 497ms。它只跑一笔，离 5s
    // 还远，但放大来源相同，一并给预算，免得下一次排位更靠前时又变成掷硬币。
  }, 60_000)

  // 这条判据要把生产的取消预算**打满**：`services/task.ts` 的 `attempts++ >= 8` 意味着 9 次
  // 完整的取消写事务。本机 0.14s，但它在 CI 上的耗时**强烈依赖同分片里它排在第几个**——
  // 2026-09-11 实测：同一提交、同一文件序（第 60 位）两次分别 5166ms 与 3797ms，而前一提交
  // 排在第 87 位时是 58ms；同文件其余用例两次都稳定在 40–70ms，只有这条（唯一跑满 9 笔事务的）
  // 被放大。bun 的分片内文件序在两次 run 之间会变，于是这条用例在 5s 缺省预算下等于掷硬币。
  // 给它一个显式预算，让「跑满 9 笔」这件事本身不再是红的来源；真正承重的判据仍是下面的
  // `cancelCasAttempts === 8`（少了是真回归，多了是钩子被无关路径触发）。
  // 放大倍率的根因未归因，已记进 `docs/audit-backlog.md`。
  test('child cancel CAS starvation fails retry closed without rollback or mint', async () => {
    const downId = 'down_call_workflow'
    const { taskId } = await seedTaskWithEdge(h, downId, 'call-workflow')
    const callRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.nodeId === downId,
    )!
    // rfc053-allow-direct-status-write -- realistic failed-parent/live-call test seeding
    await h.db
      .update(nodeRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(nodeRuns.id, callRow.id))
    const childId = await seedLiveChildForCallRow(h, taskId, callRow.id)
    let cancelCasAttempts = 0
    const childCancelBeforeStatusCas = starveTaskCancelCas(h.db, childId, () => {
      cancelCasAttempts += 1
    })

    await expect(
      retryVia(
        h,
        { taskId: taskId, nodeRunId: callRow.id, cascade: false },
        childCancelBeforeStatusCas,
      ),
    ).rejects.toMatchObject({ code: 'retry-child-cancel-failed' })

    // Four earlier ownership / intent transactions (retry status CAS, intent claim,
    // RFC-359：注入点从「包 db 代理拦 `db.transaction`」挪到了级联取消这条依赖上
    // （`retryVia` → `cancelTask.beforeStatusCas` → `setTaskStatus.beforeCas`）。
    // 这个计数因此**从含噪变成精确**：
    // 代理时代它顺带数进了几笔与子任务取消无关的事务（retry 的归属 CAS、intent 认领、
    // 取消前的状态写、releaseAfterStop……），数字一路从 13 → 12 → 11 地随「哪些事务走统一原语」往下掉；
    // 现在钩子只在**子任务那笔取消 CAS 之前**触发，于是它就等于子任务的取消尝试次数本身。
    //
    // **承重的正是这个数**（不再是附带观测量）：8 = 共用取消实现里 `attempts++ >= 8` 的预算被
    // 耗尽。少于 8 说明子任务的取消尝试变少了——那是真回归。
    //
    // RFC-359 AC-1（第 11 刀下半）转双引擎后**上界按引擎分叉**，原因是真实的、结构性的：
    //   · SQLite 是 `exclusive` 写者，事务不会被重放 ⇒ 钩子调用数**就等于**取消尝试数 = 8；
    //   · PostgreSQL 是多写并发：搅动那笔写落在**另一条连接**上，于是 SERIALIZABLE 事务会被
    //     40001 打回，而 `databaseSessionFor(db).serializable` 把**整笔事务**当重试单元重放
    //     （预算 `POSTGRESQL_SERIALIZATION_ATTEMPTS`），重放会再走一次 `beforeStatusCas`。
    //     本机真库实测稳定 **10**（8 次取消尝试 + 2 次序列化重放），但那是「冲突点 × 重试预算」
    //     的乘积，不是判据要锁的东西，所以不钉死这个数。
    //
    // 上界原本是为了抓「钩子被无关路径触发」。那件事现在**由构造保证**：钩子只作为子任务那笔
    // 取消的 `beforeStatusCas` 传进去，且只在子任务处于 awaiting_* 时才计数——别的路径碰不到它。
    // 于是上界只需兜住序列化重放本身。
    expect(cancelCasAttempts).toBeGreaterThanOrEqual(8)
    expect(cancelCasAttempts).toBeLessThanOrEqual(
      provider.capabilities.isolation === 'exclusive' ? 8 : 8 + POSTGRESQL_SERIALIZATION_ATTEMPTS,
    )
    const parent = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const child = (await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]!
    expect(parent.status).toBe('failed')
    expect(parent.errorSummary).toBe('retry-child-cancel-failed')
    expect(child.status).not.toBe('canceled')
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (r) => r.errorMessage === 'queued for retry',
      ),
    ).toHaveLength(0)
  }, 60_000)

  test('TARGET — even non-process target gets minted (current behavior, may change in PR-C)', async () => {
    // The user-clicked target is unconditionally added to `targets` in
    // `retry` (current behavior). If the user picks a review row directly,
    // a placeholder is minted for it. This is awkward semantically (you
    // can't "retry" a human decision) but is the current state.
    const downId = 'rev_x'
    const { taskId } = await seedTaskWithEdge(h, downId, 'review')

    // Find the seeded review row and "retry" it.
    const reviewRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, downId)))[0]!

    await retryVia(h, { taskId: taskId, nodeRunId: reviewRow.id, cascade: false })

    const all = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const reviewRows = all.filter((r) => r.nodeId === downId)
    expect(reviewRows.length).toBe(2) // original + placeholder retry=1
    const placeholder = reviewRows.find((r) => r.retryIndex === 1)
    expect(placeholder).toBeDefined()
    expect(placeholder!.errorMessage).toBe('queued for retry')
  })

  // RFC-098 B3 (audit ⑥-11) — the wrapper-revival carve-out on the TARGET row.
  for (const status of ['canceled', 'interrupted'] as const) {
    test(`TARGET — wrapper '${status}' row gets NO placeholder (revival signal, ⑥-11)`, async () => {
      const downId = 'down_wrapper_loop'
      const { taskId } = await seedTaskWithEdge(h, downId, 'wrapper-loop')
      // Re-stamp the seeded wrapper row into the revival status and target it.
      const wrapRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, downId)))[0]!
      // rfc053-allow-direct-status-write -- test seeding, not a production transition
      await h.db.update(nodeRuns).set({ status }).where(eq(nodeRuns.id, wrapRow.id))

      await retryVia(h, { taskId: taskId, nodeRunId: wrapRow.id, cascade: true })

      const all = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      const wrapRows = all.filter((r) => r.nodeId === downId)
      // No placeholder: the canceled/interrupted row stays the node's latest
      // (isDispatchable revival + findResumableWrapperRun same-row resume).
      expect(wrapRows.length).toBe(1)
      expect(wrapRows[0]!.id).toBe(wrapRow.id)
      expect(all.filter((r) => r.errorMessage === 'queued for retry')).toHaveLength(0)
    })
  }

  test('TARGET — wrapper done/failed rows still get the placeholder (terminal for findResumableWrapperRun)', async () => {
    for (const status of ['done', 'failed'] as const) {
      const downId = 'down_wrapper_loop'
      const { taskId } = await seedTaskWithEdge(h, downId, 'wrapper-loop')
      const wrapRow = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.nodeId === downId)[0]!
      // rfc053-allow-direct-status-write -- test seeding, not a production transition
      await h.db.update(nodeRuns).set({ status }).where(eq(nodeRuns.id, wrapRow.id))

      await retryVia(h, { taskId: taskId, nodeRunId: wrapRow.id, cascade: false })

      const wrapRows = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.nodeId === downId)
      expect(wrapRows.length).toBe(2) // original + placeholder
      const placeholder = wrapRows.find((r) => r.retryIndex === 1)
      expect(placeholder?.errorMessage).toBe('queued for retry')
    }
  })
})
