// RFC-053 PR-A T1d — retry-cascade kind matrix.
//
// For every NodeKind, verify retryNode's cascade behavior when that kind is
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { retryNode } from '../src/services/task'
import { runGit } from '../src/util/git'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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
  db: DbClient
  appHome: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
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
  const db = createInMemoryDb(MIGRATIONS)
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
  const downstreamNode = ((): Record<string, unknown> => {
    switch (downstreamKind) {
      case 'agent-single':
        return { id: downstreamNodeId, kind: 'agent-single', agentName: 'x', promptTemplate: '' }
      // RFC-060 PR-E: 'agent-multi' was removed; fan-out is wrapper-fanout now.
      case 'wrapper-git':
        return { id: downstreamNodeId, kind: 'wrapper-git', nodeIds: [] }
      case 'wrapper-loop':
        return {
          id: downstreamNodeId,
          kind: 'wrapper-loop',
          nodeIds: [],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty', portRef: { nodeId: 'x', portName: 'y' } },
        }
      case 'review':
        return {
          id: downstreamNodeId,
          kind: 'review',
          inputSource: { nodeId: 'agent_a', portName: 'out' },
        }
      case 'clarify':
        return { id: downstreamNodeId, kind: 'clarify' }
      case 'clarify-cross-agent':
        // RFC-056 — cross-clarify shares the non-process retry-cascade
        // behaviour with RFC-023 clarify (skip placeholder mint). Wiring the
        // 1-in / 2-out node here just exercises the dispatch path; the
        // upstream agent's retry never spawns a placeholder on it.
        return { id: downstreamNodeId, kind: 'clarify-cross-agent' }
      case 'wrapper-fanout':
        // RFC-060 — fanout wrapper shares the wrapper-* retry-cascade row
        // (mint placeholder on upstream retry). The minimal viable shape
        // here is enough to drive the matrix; PR-D's scheduler tests cover
        // the actual fan-out dispatch.
        return {
          id: downstreamNodeId,
          kind: 'wrapper-fanout',
          nodeIds: [],
          inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
        }
      case 'output':
        return { id: downstreamNodeId, kind: 'output' }
      case 'input':
        return { id: downstreamNodeId, kind: 'input', inputKey: 'topic' }
      case 'call-workflow':
        // RFC-243 — a call node is process-bearing (an independent child
        // task); upstream retries mint it a placeholder like any wrapper.
        return { id: downstreamNodeId, kind: 'call-workflow', workflowName: 'child-wf' }
      case 'call-workgroup':
        return {
          id: downstreamNodeId,
          kind: 'call-workgroup',
          workgroupName: 'child-wg',
          goalTemplate: 'do {{out}}',
        }
      case 'script':
        // RFC-253 — a script node runs a real subprocess, so it shares the
        // process-bearing retry-cascade row: an upstream retry mints it a
        // placeholder exactly like an agent or a wrapper.
        return { id: downstreamNodeId, kind: 'script', language: 'bash', script: 'echo hi' }
      case 'code-host-call':
        // RFC-269 — a code-host call has REAL external side effects (a comment
        // gets posted), so it is process-bearing and cascades like the rest:
        // an upstream retry must mint it a placeholder, otherwise the retried
        // chain would silently skip the step that reports its result.
        return {
          id: downstreamNodeId,
          kind: 'code-host-call',
          provider: 'gitlab',
          action: 'comment.create',
          params: { mr: '1', body: '{{out}}' },
        }
      case 'code-round':
        // RFC-304 — `code-round` is synthesized by startCodeRoundTask, never
        // authored into a user definition (the validator rejects it), so it can
        // never BE a downstream node in this matrix. It still shares the
        // process-kind retry-cascade row ('mint-placeholder'), which is asserted
        // directly against NODE_KIND_BEHAVIORS in node-kind-behavior-table.test.
        // Throwing here keeps the switch exhaustive without pretending this
        // graph shape is constructible.
        throw new Error('code-round is synthesized-only and cannot be a downstream node')
      default: {
        const _exhaustive: never = downstreamKind
        throw new Error(`unexpected kind ${_exhaustive as string}`)
      }
    }
  })()

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
 * RFC-359：注入点做进被测代码内部（`retryNode` 的 `childCancelBeforeStatusCas` → `cancelTask` 的
 * `beforeStatusCas` → `setTaskStatus` 的 `beforeCas`，生产都不传），不再从外面包 db 代理拦
 * `db.transaction`——统一事务原语不走它，旧注入器**一次都不触发**，用例照样绿却一个并发场景都没验
 * （`docs/dev-gotchas.md` 有完整复盘）。
 *
 * 目标状态是**读当前值再翻**，不是固定轮换：搅动与 CAS 之间不再隔着事务边界，
 * 固定轮换会与 CAS 的期望值对上号，几轮之后反而让 CAS 赢了。
 */
function starveTaskCancelCas(db: DbClient, taskId: string, onAttempt: () => void): () => void {
  return () => {
    const current = db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()?.status
    if (current !== 'awaiting_review' && current !== 'awaiting_human') return
    onAttempt()
    const next = current === 'awaiting_review' ? 'awaiting_human' : 'awaiting_review'
    db.update(tasks).set({ status: next }).where(eq(tasks.id, taskId)).run()
  }
}

describe('RFC-053 PR-A T1d — retry cascade kind matrix', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  for (const kind of DOWNSTREAM_KINDS_MINT) {
    test(`MINT — downstream kind '${kind}' gets placeholder row at retryIndex+1`, async () => {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const { taskId, agentRunId } = await seedTaskWithEdge(h, downId, kind)

      await retryNode(h.db, taskId, agentRunId, {
        cascade: true,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      })

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

      await retryNode(h.db, taskId, agentRunId, {
        cascade: true,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      })

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

    await retryNode(h.db, taskId, callRow.id, {
      cascade: false,
      deps: {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        taskRecoveryOperations: taskRecoveryOperations(h.db),
        appHome: h.appHome,
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    })

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

    await retryNode(h.db, taskId, agentRunId, {
      cascade: true,
      deps: {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        taskRecoveryOperations: taskRecoveryOperations(h.db),
        appHome: h.appHome,
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    })

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

    // RFC-359 W8：注入点做进被测代码内部（`retryNode.childCancelBeforeStatusCas`，生产不传），
    // 不再包 db 代理拦 `db.transaction`——统一事务原语不走它，旧注入器一次都不触发，
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
      retryNode(h.db, taskId, callRow.id, {
        cascade: false,
        childCancelBeforeStatusCas,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }),
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
  })

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
      retryNode(h.db, taskId, callRow.id, {
        cascade: false,
        childCancelBeforeStatusCas,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      }),
    ).rejects.toMatchObject({ code: 'retry-child-cancel-failed' })

    // Four earlier ownership / intent transactions (retry status CAS, intent claim,
    // RFC-359 W8：注入点从「包 db 代理拦 `db.transaction`」挪进被测代码内部
    // （`retryNode.childCancelBeforeStatusCas` → `cancelTask.beforeStatusCas` →
    // `setTaskStatus.beforeCas`）。这个计数因此**从含噪变成精确**：
    // 代理时代它顺带数进了几笔与子任务取消无关的事务（retry 的归属 CAS、intent 认领、
    // 取消前的状态写、releaseAfterStop……），数字一路从 13 → 12 → 11 地随「哪些事务走统一原语」往下掉；
    // 现在钩子只在**子任务那笔取消 CAS 之前**触发，于是它就等于子任务的取消尝试次数本身。
    //
    // **承重的正是这个数**（不再是附带观测量）：8 = `services/task.ts` 里 `attempts++ >= 8` 的预算被
    // 耗尽。少于 8 说明子任务的取消尝试变少了——那是真回归；多于 8 说明钩子被无关路径触发了。
    expect(cancelCasAttempts).toBe(8)
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
  })

  test('TARGET — even non-process target gets minted (current behavior, may change in PR-C)', async () => {
    // The user-clicked target is unconditionally added to `targets` in
    // retryNode (current behavior). If the user picks a review row directly,
    // a placeholder is minted for it. This is awkward semantically (you
    // can't "retry" a human decision) but is the current state.
    const downId = 'rev_x'
    const { taskId } = await seedTaskWithEdge(h, downId, 'review')

    // Find the seeded review row and "retry" it.
    const reviewRow = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, downId)))[0]!

    await retryNode(h.db, taskId, reviewRow.id, {
      cascade: false,
      deps: {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        taskRecoveryOperations: taskRecoveryOperations(h.db),
        appHome: h.appHome,
        binaryOverride: ['/usr/bin/env', 'true'],
      },
    })

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

      await retryNode(h.db, taskId, wrapRow.id, {
        cascade: true,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      })

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

      await retryNode(h.db, taskId, wrapRow.id, {
        cascade: false,
        deps: {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          taskRecoveryOperations: taskRecoveryOperations(h.db),
          appHome: h.appHome,
          binaryOverride: ['/usr/bin/env', 'true'],
        },
      })

      const wrapRows = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      ).filter((r) => r.nodeId === downId)
      expect(wrapRows.length).toBe(2) // original + placeholder
      const placeholder = wrapRows.find((r) => r.retryIndex === 1)
      expect(placeholder?.errorMessage).toBe('queued for retry')
    }
  })
})
