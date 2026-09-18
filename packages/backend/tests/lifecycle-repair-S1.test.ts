// LOCKS: RFC-057 — S1 repair options (awaiting_review without pending doc_version).
// 2 options × 3 cases = 6 tests.

import { afterEach, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'
import { mkdirSync } from 'node:fs'
import { eq } from 'drizzle-orm'

import { createRepairEngine } from './helpers/repairEngine'
import { isoWorktreePathFor } from '../src/services/nodeIsolation'
import { runGit } from '../src/util/git'

import { docVersions, nodeRunOutputs } from '../src/db/schema'
import { withTaskReviewMutationLock } from '../src/services/reviewMutationCoordinator'
import { cancelViaEngine } from './helpers/cancelEngine'
import {
  buildHarness,
  insertAlert,
  insertNodeRun,
  readAuditRows,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describeEachProvider('RFC-057 — S1.recreate-doc-version', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_review run + done source with output → mints fresh pending doc_version', async () => {
    h = await buildHarness(provider.db, {
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          { id: 'src', kind: 'agent-single', agentName: 'doc' } as never,
          {
            id: 'rev_1',
            kind: 'review',
            inputSource: { nodeId: 'src', portName: 'docpath' },
          } as never,
        ],
        edges: [],
      },
    })
    // done source run with a port output (inline markdown).
    const srcRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'src',
      status: 'done',
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: srcRunId,
      portName: 'docpath',
      content: '# Demo doc body\n\nInline markdown sourced from src.',
    })
    // awaiting_review review run, no doc_version (S1 violation shape).
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: {
        rule: 'S1',
        repairHint: { kind: 'review', nodeRunId: reviewRunId },
      },
    })

    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: 'u-1',
    })
    expect(res.outcome).toBe('success')
    // A pending doc_version should now exist for the review run.
    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, reviewRunId))
    expect(dvs.some((d) => d.decision === 'pending')).toBe(true)
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.optionId).toBe('S1.recreate-doc-version')
  })

  test('preflight-stale: task no longer awaiting_review', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S1.recreate-doc-version')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S1.unavailable.taskNotAwaitingReview')
  })

  test('cancel first makes queued recreate-doc repair a zero-write stale loser', async () => {
    h = await buildHarness(provider.db, {
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          { id: 'src', kind: 'agent-single', agentName: 'doc' } as never,
          {
            id: 'rev_1',
            kind: 'review',
            inputSource: { nodeId: 'src', portName: 'docpath' },
          } as never,
        ],
        edges: [],
      },
    })
    const srcRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'src',
      status: 'done',
      finishedAt: Date.now(),
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: srcRunId,
      portName: 'docpath',
      content: '# must not be recreated',
    })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: { rule: 'S1', repairHint: { kind: 'review', nodeRunId: reviewRunId } },
    })
    let releaseHolder: () => void = () => {}
    let holderEntered: () => void = () => {}
    const blocked = new Promise<void>((resolveBlocked) => {
      releaseHolder = resolveBlocked
    })
    const entered = new Promise<void>((resolveEntered) => {
      holderEntered = resolveEntered
    })
    const holder = withTaskReviewMutationLock(h.taskId, async () => {
      holderEntered()
      await blocked
    })
    await entered

    const cancel = cancelViaEngine(h.db, h.taskId)
    const repair = h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: 'u-1',
    })
    // 落败 handler 必须**同步**挂上，而且**不能用 `expect(...).rejects`**。
    //
    // 为什么要同步挂：`repair` 会在 `await cancel` 还没返回时就落败（cancel 拿到 mutation
    // slot 在先，repair 紧随其后看见已取消的任务）。把 `expect(repair).rejects` 留到三个
    // await 之后才写就晚了——promise 已经以「无人接手」的姿态 reject，被 Bun 记成 unhandled
    // rejection 并算在本 cell 头上（本 cell 的 postgresql lane 实撞）。
    // 为什么不能用 `expect(...).rejects`：把它提前到这里、`await` 留到后面，Bun 1.3.13 会在
    // 主线程上空转（实测 99% CPU、`--timeout` 都进不来）。纯 `.then(onFulfilled, onRejected)`
    // 收错误、最后再 `expect` 值，判据一字不差，且没有这两个坑。
    const repairOutcome = repair.then(
      () => null,
      (error: unknown) => error,
    )
    releaseHolder()
    await holder
    await cancel
    expect(await repairOutcome).toMatchObject({ code: 'repair-preflight-stale' })
    expect(
      await h.db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, reviewRunId)),
    ).toHaveLength(0)
  })

  test('preflight-stale: workflow has no review nodes', async () => {
    h = await buildHarness(provider.db, {
      taskStatus: 'awaiting_review',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'out_1', kind: 'output', ports: [] } as never],
        edges: [],
      },
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S1.recreate-doc-version')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.S1.unavailable.noReviewNode')
  })
})

describeEachProvider('RFC-057 — S1.demote-task', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_review task → interrupted + resume', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const res = await h.engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S1.demote-task',
      actorUserId: null,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task not awaiting_review', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    const opt = list.options.find((o) => o.id === 'S1.demote-task')
    expect(opt?.available).toBe(false)
  })

  test('option metadata distribution: low + medium', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'S1', detail: { rule: 'S1' } })
    const list = await h.engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    expect(list.options.find((o) => o.id === 'S1.recreate-doc-version')?.risk).toBe('low')
    expect(list.options.find((o) => o.id === 'S1.demote-task')?.risk).toBe('medium')
  })
})

// RFC-193 §4.6 case 8d 的**行为面**——`rfc193-wrapper-review` 只锁源码文本。
//
// 为什么这条测试存在（RFC-359 第 8 刀实撞）：修复原来有两份实现，只有退役的那一份
// 按 wrapper 血缘推导 `scopeRoot`；**留下的那一份直接传 `task.worktreePath`**。
// 于是在「评审节点包在 git / loop wrapper 里」的任务上，PostgreSQL 部署的 S1 修复会把
// 评审派发到任务根，而不是那一层 wrapper 的 iso 工作树——派发落在错的目录上，
// 而两侧各自的测试都不会因此变红（源码锁只盯退役那一份的文件）。
describeEachProvider('RFC-193 case 8d —— S1 的评审派发落在 wrapper 的 iso 工作树上', (provider) => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  const WRAPPED_WORKFLOW = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      // wrapper 的子节点字段是 `nodeIds`（`shared/src/workflowScope.ts` 的 `readNodeIds`）。
      { id: 'git_1', kind: 'wrapper-git', nodeIds: ['rev_1'] },
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      },
    ],
    edges: [],
  } as unknown as Parameters<typeof buildHarness>[1]['workflow']

  test('wrapper 的 iso 目录是活工作树时，scopeRoot 取它而不是任务根', async () => {
    h = await buildHarness(provider.db, {
      taskStatus: 'awaiting_review',
      workflow: WRAPPED_WORKFLOW,
    })
    const wrapperRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'git_1',
      status: 'running',
    })
    // wrapper 的 iso 容器：真 `git init` 才过得了 `isGitWorkTree` 那道兜底判据
    //（判据从「目录存在」收紧成「是活的工作树」正是 RFC-356 T15 的教训）。
    const isoRoot = isoWorktreePathFor(h.tmpDir, h.taskId, wrapperRunId, '')
    mkdirSync(isoRoot, { recursive: true })
    await runGit(isoRoot, ['init'])

    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const sourceRunId = await insertNodeRun(h.db, h.taskId, { nodeId: 'doc', status: 'done' })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: sourceRunId,
      portName: 'docpath',
      content: '# wrapper doc body',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: { rule: 'S1', reviewNodeRunId: reviewRunId, reviewNodeId: 'rev_1' },
    })

    const dispatched: string[] = []
    const engine = createRepairEngine(h.db, {
      appHome: h.tmpDir,
      collaborationRuntime: {
        dispatchReviewNode: async (input: { scopeRoot: string }) => {
          dispatched.push(input.scopeRoot)
          return { kind: 'dispatched' as const, message: '', summary: '' }
        },
      } as never,
    })
    const listed = await engine.listRepairOptionsForAlert({
      taskId: h.taskId,
      alertId,
      actorUserId: null,
    })
    expect(
      listed.options.find((option) => option.id === 'S1.recreate-doc-version')?.available,
      '前置：这条修复在本形态下应当可用，否则下面断言的是空跑',
    ).toBe(true)

    await engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: null,
    })

    expect(
      dispatched,
      '评审派发的 scopeRoot 落在任务根上——wrapper 内的 review 会在错的目录里跑',
    ).toEqual([isoRoot])
  })

  test('没有 wrapper 时仍退回任务根（推导不能反过来伤到普通形态）', async () => {
    h = await buildHarness(provider.db, { taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const sourceRunId = await insertNodeRun(h.db, h.taskId, { nodeId: 'doc', status: 'done' })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: sourceRunId,
      portName: 'docpath',
      content: '# wrapper doc body',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'S1',
      detail: { rule: 'S1', reviewNodeRunId: reviewRunId, reviewNodeId: 'rev_1' },
    })
    const dispatched: string[] = []
    const engine = createRepairEngine(h.db, {
      appHome: h.tmpDir,
      collaborationRuntime: {
        dispatchReviewNode: async (input: { scopeRoot: string }) => {
          dispatched.push(input.scopeRoot)
          return { kind: 'dispatched' as const, message: '', summary: '' }
        },
      } as never,
    })
    await engine.applyRepairOption({
      taskId: h.taskId,
      alertId,
      optionId: 'S1.recreate-doc-version',
      actorUserId: null,
    })
    expect(dispatched).toEqual([h.tmpDir])
  })
})
