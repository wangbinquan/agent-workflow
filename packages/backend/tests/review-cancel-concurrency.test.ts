// Review mutations and user cancellation share one task-scoped FIFO.  These
// tests put an explicit holder in front of both operations so the winner order
// is deterministic rather than an accident of Promise scheduling.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ReviewDecisionKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  docVersions,
  memoryDistillJobs,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '../src/db/schema'
import { trySetTaskStatus } from '../src/services/lifecycle'
import {
  addReviewComment,
  deleteReviewComment,
  dispatchReviewNode,
  setDocumentSelection,
  submitReviewDecision,
  updateReviewCommentText,
} from '../src/services/review'
import {
  __hasTaskReviewMutationQueueForTesting,
  withTaskReviewMutationLock,
} from '../src/services/reviewMutationCoordinator'
import {
  __registerActiveTaskForTesting,
  __setActiveTaskForTesting,
  cancelTask,
} from '../src/services/task'
import { sealOpenHumanGatesForTask } from '../src/services/terminalSweep'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'
import { drainCommittedEventDeliveriesForTests } from './helpers/committedEventHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  root: string
  taskId: string
  upstreamRunId: string
  reviewRunId: string
  docVersionId: string
  commentId: string
  definition: WorkflowDefinition
  cleanup(): void
}

let current: Harness | undefined

afterEach(() => {
  __setActiveTaskForTesting(undefined)
  current?.cleanup()
  current = undefined
})

async function seedHarness(options: { multiDoc?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'aw-review-cancel-lock-'))
  const appHome = join(root, 'app-home')
  const worktreePath = join(root, 'worktree')
  mkdirSync(join(appHome, 'review'), { recursive: true })
  mkdirSync(worktreePath, { recursive: true })

  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  const upstreamRunId = ulid()
  const reviewRunId = ulid()
  const docVersionId = ulid()
  const commentId = ulid()
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'writer',
        kind: 'agent-single',
        agentName: 'writer',
        promptTemplate: '',
      } as WorkflowNode,
      {
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: 'writer', portName: 'doc' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'review-cancel-lock',
    definition: JSON.stringify(definition),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'review-cancel-lock',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: worktreePath,
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: upstreamRunId,
    taskId,
    nodeId: 'writer',
    status: 'done',
    iteration: 0,
    retryIndex: 0,
    startedAt: Date.now() - 20,
    finishedAt: Date.now() - 10,
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: upstreamRunId,
    portName: 'doc',
    content: '# body inline',
  })
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'review',
    status: 'awaiting_review',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    startedAt: Date.now() - 5,
  })
  const bodyPath = 'review/v1.md'
  writeFileSync(join(appHome, bodyPath), '# body inline')
  await db.insert(docVersions).values({
    id: docVersionId,
    taskId,
    reviewNodeId: 'review',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'writer',
    sourcePortName: 'doc',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath,
    commentsJson: '[]',
    decision: 'pending',
    itemIndex: options.multiDoc === true ? 0 : null,
    itemPath: options.multiDoc === true ? 'docs/a.md' : null,
    selection: options.multiDoc === true ? 'unselected' : null,
    selectionStale: options.multiDoc === true ? true : null,
    createdAt: Date.now(),
  })
  await db.insert(reviewComments).values({
    id: commentId,
    docVersionId,
    anchorSectionPath: 'body',
    anchorParagraphIdx: 0,
    anchorOffsetStart: 2,
    anchorOffsetEnd: 6,
    selectedText: 'body',
    contextBefore: '# ',
    contextAfter: ' inline',
    occurrenceIndex: 1,
    commentText: 'original',
    author: 'reviewer',
    createdAt: Date.now(),
  })

  const uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
    onTerminalTask(hookDb, hookTaskId, to) {
      sealOpenHumanGatesForTask(hookDb, hookTaskId, `task-${to}`)
    },
  })

  return {
    db,
    appHome,
    worktreePath,
    root,
    taskId,
    upstreamRunId,
    reviewRunId,
    docVersionId,
    commentId,
    definition,
    cleanup: () => {
      uninstallAfterCommitPump()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function settleInOrder<A, B>(
  taskId: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  let releaseHolder: () => void = () => {}
  let markEntered: () => void = () => {}
  const entered = new Promise<void>((resolveEntered) => {
    markEntered = resolveEntered
  })
  const blocked = new Promise<void>((resolveBlocked) => {
    releaseHolder = resolveBlocked
  })
  const holder = withTaskReviewMutationLock(taskId, async () => {
    markEntered()
    await blocked
  })
  await entered

  // Both production wrappers synchronously register their task tail before
  // returning, so invocation order below is the exact FIFO acquisition order.
  const firstResult = first()
  const secondResult = second()
  releaseHolder()
  await holder
  return Promise.allSettled([firstResult, secondResult])
}

function expectRejectedCode(result: PromiseSettledResult<unknown>, code: string): void {
  expect(result.status).toBe('rejected')
  if (result.status === 'rejected') {
    expect((result.reason as { code?: string }).code).toBe(code)
  }
}

function decide(h: Harness, decision: ReviewDecisionKind, db: DbClient = h.db) {
  return submitReviewDecision({
    db,
    appHome: h.appHome,
    nodeRunId: h.reviewRunId,
    decision,
    expectedReviewIteration: 0,
    author: 'reviewer',
    ...(decision === 'rejected' ? { rejectReason: 'not acceptable' } : {}),
  })
}

/** Delay only review.ts's `{ archiveJson }` select after the doc claim. */
function delayArchiveSelect(db: DbClient, onBlocked: () => void, release: Promise<void>): DbClient {
  const wrapBuilder = (builder: object): object => {
    const proxy: object = new Proxy(builder, {
      get(target, property) {
        if (property === 'then') {
          return (
            onFulfilled?: ((value: unknown) => unknown) | null,
            onRejected?: ((reason: unknown) => unknown) | null,
          ) => {
            onBlocked()
            return release
              .then(() => Promise.resolve(target as unknown as PromiseLike<unknown>))
              .then(onFulfilled, onRejected)
          }
        }
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args) as unknown
          return typeof next === 'object' && next !== null ? wrapBuilder(next) : next
        }
      },
    })
    return proxy
  }

  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'select' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const builder = Reflect.apply(value, target, args) as object
        const fields = args[0]
        const isArchiveSelect =
          typeof fields === 'object' &&
          fields !== null &&
          Object.keys(fields).length === 1 &&
          Object.hasOwn(fields, 'archiveJson')
        return isArchiveSelect ? wrapBuilder(builder) : builder
      }
    },
  }) as DbClient
}

function observeDbSelect(db: DbClient, onSelect: () => void): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'select' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        onSelect()
        return Reflect.apply(value, target, args) as unknown
      }
    },
  }) as DbClient
}

/** Make the first canceled task UPDATE lose to running→awaiting_human. */
function loseFirstCancelCas(db: DbClient, taskId: string, onLost: () => void): DbClient {
  let lost = false
  const wrapBuilder = (
    tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
    builder: object,
    taskUpdate: boolean,
    cancelUpdate: boolean,
  ): object => {
    const proxy: object = new Proxy(builder, {
      get(target, property) {
        if (property === 'all' && taskUpdate && cancelUpdate && !lost) {
          return (...args: unknown[]) => {
            lost = true
            onLost()
            // The lifecycle writer is now transactional. Move the row through
            // the raw tx immediately before its CAS so the target UPDATE loses
            // while its companion outbox write remains absent.
            tx.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId)).run()
            const method = Reflect.get(target, property, target) as (...inner: unknown[]) => unknown
            return Reflect.apply(method, target, args)
          }
        }
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args) as unknown
          const armsCancel =
            property === 'set' &&
            typeof args[0] === 'object' &&
            args[0] !== null &&
            (args[0] as { status?: unknown }).status === 'canceled'
          return typeof next === 'object' && next !== null
            ? wrapBuilder(tx, next, taskUpdate, cancelUpdate || armsCancel)
            : next
        }
      },
    })
    return proxy
  }

  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'transaction' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const callback = args[0] as (
          tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
        ) => unknown
        return Reflect.apply(value, target, [
          (tx: Parameters<Parameters<DbClient['transaction']>[0]>[0]) => {
            const wrappedTx = new Proxy(tx, {
              get(txTarget, txProperty) {
                const txValue = Reflect.get(txTarget, txProperty, txTarget)
                if (txProperty !== 'update' || typeof txValue !== 'function') return txValue
                return (...updateArgs: unknown[]) =>
                  wrapBuilder(
                    tx,
                    Reflect.apply(txValue, txTarget, updateArgs) as object,
                    updateArgs[0] === tasks,
                    false,
                  )
              },
            })
            return callback(wrappedTx)
          },
          ...args.slice(1),
        ])
      }
    },
  }) as DbClient
}

/** Keep one task moving between cancelable states before every task-cancel CAS. */
function starveTaskCancelCas(db: DbClient, taskId: string, onAttempt: () => void): DbClient {
  let nextStatus: 'awaiting_human' | 'awaiting_review' = 'awaiting_review'
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'transaction' || typeof value !== 'function') return value
      return (...args: unknown[]) => {
        // Every lifecycle CAS opens a transaction. Churn the target immediately
        // before each boundary so a child cancellation can never win its
        // read→CAS window, while the transaction itself remains production-real.
        onAttempt()
        const status = nextStatus
        nextStatus = status === 'awaiting_review' ? 'awaiting_human' : 'awaiting_review'
        db.update(tasks).set({ status }).where(eq(tasks.id, taskId)).run()
        return Reflect.apply(value, target, args)
      }
    },
  }) as DbClient
}

// RFC-285 B6①：service 签名新增作者校验 authz——本文件既有用例全走 owner 旁路
// 保持原语义；作者矩阵的专项覆盖在 reviews-comment-patch 的 B6① describe。
const OWNER_AUTHZ = { actorUserId: 'u_owner_authz', role: 'owner' as const }

describe('review mutation vs task cancellation linearization', () => {
  test.each(['approved', 'rejected', 'iterated'] as const)(
    'cancel first makes a queued %s decision lose with zero decision side effects',
    async (decision) => {
      const h = (current = await seedHarness())
      const [cancelResult, decisionResult] = await settleInOrder(
        h.taskId,
        () => cancelTask(h.db, h.taskId),
        () => decide(h, decision),
      )

      expect(cancelResult.status).toBe('fulfilled')
      expectRejectedCode(decisionResult, 'task-terminal')
      expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
        'canceled',
      )
      expect(
        (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
      ).toBe('canceled')
      const doc = (
        await h.db.select().from(docVersions).where(eq(docVersions.id, h.docVersionId))
      )[0]!
      expect(doc.decision).toBe('pending')
      expect(doc.decidedAt).toBeNull()
      expect(doc.commentsJson).toBe('[]')
      const comments = await h.db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.docVersionId, h.docVersionId))
      expect(comments.map((row) => row.commentText)).toEqual(['original'])
      expect(
        await h.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId)),
      ).toHaveLength(0)
      expect(
        await h.db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'writer'))),
      ).toHaveLength(1)
      expect(await h.db.select().from(memoryDistillJobs)).toHaveLength(0)
    },
  )

  test('approve first commits its complete fact set before queued cancel seals the task', async () => {
    const h = (current = await seedHarness())
    const [decisionResult, cancelResult] = await settleInOrder(
      h.taskId,
      () => decide(h, 'approved'),
      () => cancelTask(h.db, h.taskId),
    )

    expect(decisionResult.status).toBe('fulfilled')
    expect(cancelResult.status).toBe('fulfilled')
    expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
      'canceled',
    )
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
    ).toBe('done')
    const doc = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, h.docVersionId))
    )[0]!
    expect(doc.decision).toBe('approved')
    expect(doc.commentsJson).toContain('original')
    expect(await h.db.select().from(reviewComments)).toHaveLength(0)
    const reviewOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
    expect(reviewOutputs.map((row) => row.portName).sort()).toEqual([
      'approval_meta',
      'approved_doc',
    ])
    expect(
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'writer'))),
    ).toHaveLength(1)
    await drainCommittedEventDeliveriesForTests(h.db)
    expect(await h.db.select().from(memoryDistillJobs)).toHaveLength(1)
  })

  test('decision WS is emitted only after outputs and the lifecycle transition are complete', async () => {
    const h = (current = await seedHarness())
    let stateAtEvent: { runStatus: string | undefined; outputCount: number } | undefined
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(h.taskId), (event) => {
      if (event.type !== 'review.decision_made') return
      stateAtEvent = {
        runStatus: h.db
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, h.reviewRunId))
          .limit(1)
          .all()[0]?.status,
        outputCount: h.db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, h.reviewRunId))
          .all().length,
      }
    })
    try {
      await decide(h, 'approved')
    } finally {
      unsubscribe()
    }
    expect(stateAtEvent).toEqual({ runStatus: 'done', outputCount: 2 })
  })

  test('a post-claim approve failure emits no false-success decision WS', async () => {
    const h = (current = await seedHarness())
    rmSync(join(h.appHome, 'review', 'v1.md'))
    const decisions: unknown[] = []
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(h.taskId), (event) => {
      if (event.type === 'review.decision_made') decisions.push(event)
    })
    try {
      await expect(decide(h, 'approved')).rejects.toThrow()
    } finally {
      unsubscribe()
    }
    expect(decisions).toHaveLength(0)
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
    ).toBe('awaiting_review')
  })

  test('a claimed decision excludes dispatch refresh; refresh reopens on a fresh run after decision', async () => {
    const h = (current = await seedHarness())
    const sourcePath = 'doc.md'
    writeFileSync(join(h.worktreePath, sourcePath), '# fresh upstream body')
    await h.db
      .update(nodeRunOutputs)
      .set({ content: sourcePath, kind: 'path<md>' })
      .where(eq(nodeRunOutputs.nodeRunId, h.upstreamRunId))
    await h.db
      .update(nodeRuns)
      .set({ consumedUpstreamRunsJson: JSON.stringify({ writer: h.upstreamRunId }) })
      .where(eq(nodeRuns.id, h.reviewRunId))
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: sourcePath })
      .where(eq(docVersions.id, h.docVersionId))
    await Bun.sleep(2)
    const freshUpstreamRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: freshUpstreamRunId,
      taskId: h.taskId,
      nodeId: 'writer',
      status: 'done',
      iteration: 0,
      retryIndex: 1,
      startedAt: Date.now() - 2,
      finishedAt: Date.now() - 1,
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: freshUpstreamRunId,
      portName: 'doc',
      content: sourcePath,
      kind: 'path<md>',
    })

    let unblockArchive: () => void = () => {}
    let archiveBlocked: () => void = () => {}
    const blocked = new Promise<void>((resolveBlocked) => {
      archiveBlocked = resolveBlocked
    })
    const release = new Promise<void>((resolveRelease) => {
      unblockArchive = resolveRelease
    })
    const decisionDb = delayArchiveSelect(h.db, archiveBlocked, release)
    const decision = decide(h, 'approved', decisionDb)
    await blocked

    let dispatchTouchedDb = false
    let schedulerClaimed = false
    const dispatch = dispatchReviewNode({
      db: observeDbSelect(h.db, () => {
        dispatchTouchedDb = true
        if (!schedulerClaimed) {
          schedulerClaimed = true
          // dispatchReviewNode normally runs after the scheduler has claimed
          // pending → running. This direct service fixture models that entry.
          h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, h.taskId)).run()
        }
      }),
      taskId: h.taskId,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((node) => node.id === 'review')!,
      iteration: 0,
      scopeRoot: h.worktreePath,
    })
    // The decision already owns the task mutation section. Dispatch must not
    // even begin its DB read phase until that complete decision fact set lands.
    expect(dispatchTouchedDb).toBe(false)
    unblockArchive()
    await decision
    const dispatchResult = await dispatch
    expect(dispatchResult.kind).toBe('awaiting_review')

    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
    ).toBe('done')
    expect(
      await h.db
        .select()
        .from(docVersions)
        .where(
          and(eq(docVersions.reviewNodeRunId, h.reviewRunId), eq(docVersions.decision, 'pending')),
        ),
    ).toHaveLength(0)
    const reopenedRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'review')))
    expect(reopenedRuns).toHaveLength(2)
    const reopened = reopenedRuns.find((run) => run.id !== h.reviewRunId)!
    expect(reopened.status).toBe('awaiting_review')
    const pending = await h.db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.reviewNodeRunId, reopened.id), eq(docVersions.decision, 'pending')))
    expect(pending).toHaveLength(1)
    expect(pending[0]?.versionIndex).toBe(1)
  })

  test('cancel first makes queued stale-source dispatch perform zero refresh writes', async () => {
    const h = (current = await seedHarness())
    await h.db
      .update(nodeRuns)
      .set({ consumedUpstreamRunsJson: JSON.stringify({ writer: h.upstreamRunId }) })
      .where(eq(nodeRuns.id, h.reviewRunId))
    const freshUpstreamRunId = ulid()
    await h.db.insert(nodeRuns).values({
      id: freshUpstreamRunId,
      taskId: h.taskId,
      nodeId: 'writer',
      status: 'done',
      iteration: 0,
      retryIndex: 1,
      startedAt: Date.now() - 2,
      finishedAt: Date.now() - 1,
    })
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: freshUpstreamRunId,
      portName: 'doc',
      content: '# fresh upstream body',
    })
    const created: unknown[] = []
    const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(h.taskId), (event) => {
      if (event.type === 'review.created') created.push(event)
    })
    try {
      const [cancelResult, dispatchResult] = await settleInOrder(
        h.taskId,
        () => cancelTask(h.db, h.taskId),
        () =>
          dispatchReviewNode({
            db: h.db,
            taskId: h.taskId,
            appHome: h.appHome,
            definition: h.definition,
            node: h.definition.nodes.find((node) => node.id === 'review')!,
            iteration: 0,
            scopeRoot: h.worktreePath,
          }),
      )
      expect(cancelResult.status).toBe('fulfilled')
      expect(dispatchResult).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'canceled' },
      })
    } finally {
      unsubscribe()
    }
    const docs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewRunId))
    expect(docs).toHaveLength(1)
    expect(docs[0]?.decision).toBe('pending')
    expect(docs[0]?.versionIndex).toBe(1)
    expect(created).toHaveLength(0)
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]
        ?.consumedUpstreamRunsJson,
    ).toBe(JSON.stringify({ writer: h.upstreamRunId }))
  })

  test('cancel retries when a non-coordinator writer wins CAS into another cancelable state', async () => {
    const h = (current = await seedHarness())
    await h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, h.taskId))
    let firstCasLost = false

    const result = await cancelTask(
      loseFirstCancelCas(h.db, h.taskId, () => {
        firstCasLost = true
      }),
      h.taskId,
    )

    expect(firstCasLost).toBe(true)
    expect(result.status).toBe('canceled')
    expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
      'canceled',
    )
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
    ).toBe('canceled')
  })

  test('cancel status broadcast runs after releasing the task mutation queue', async () => {
    const h = (current = await seedHarness())
    let queuePresentAtBroadcast: boolean | undefined
    let listenerReentry: Promise<void> | undefined
    const unsubscribe = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (event) => {
      if (
        event.type !== 'task.status' ||
        event.taskId !== h.taskId ||
        event.status !== 'canceled'
      ) {
        return
      }
      queuePresentAtBroadcast = __hasTaskReviewMutationQueueForTesting(h.taskId)
      listenerReentry = withTaskReviewMutationLock(h.taskId, async () => {})
    })
    try {
      await cancelTask(h.db, h.taskId)
      await listenerReentry
    } finally {
      unsubscribe()
    }

    expect(queuePresentAtBroadcast).toBe(false)
  })

  test('parent cancel releases the parent mutation lock before waiting on an active child', async () => {
    const h = (current = await seedHarness())
    const childId = ulid()
    const workflowId = (
      await h.db.select({ workflowId: tasks.workflowId }).from(tasks).where(eq(tasks.id, h.taskId))
    )[0]!.workflowId
    await h.db.insert(tasks).values({
      id: childId,
      name: 'active child',
      workflowId,
      workflowSnapshot: JSON.stringify(h.definition),
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${childId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      parentTaskId: h.taskId,
      invocationDepth: 1,
    })
    const childController = new AbortController()
    __registerActiveTaskForTesting(childId, childController)
    let childAborted: () => void = () => {}
    const childAbortSeen = new Promise<void>((resolveAbort) => {
      childAborted = resolveAbort
    })
    let letChildSettle: () => void = () => {}
    const childMaySettle = new Promise<void>((resolveSettle) => {
      letChildSettle = resolveSettle
    })
    let schedulerSettled: Promise<void> = Promise.resolve()
    childController.signal.addEventListener(
      'abort',
      () => {
        childAborted()
        schedulerSettled = withTaskReviewMutationLock(childId, async () => {
          await childMaySettle
          await trySetTaskStatus({
            db: h.db,
            taskId: childId,
            to: 'canceled',
            allowedFrom: ['running'],
            extra: { finishedAt: Date.now() },
            reason: 'test-scheduler-cancel',
          })
        })
      },
      { once: true },
    )

    const cancel = cancelTask(h.db, h.taskId)
    await childAbortSeen
    let parentProbeEntered = false
    const parentProbe = withTaskReviewMutationLock(h.taskId, async () => {
      parentProbeEntered = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(parentProbeEntered).toBe(true)

    letChildSettle()
    await Promise.all([parentProbe, schedulerSettled, cancel])
    expect((await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]?.status).toBe(
      'canceled',
    )
  })

  test('parent cascade surfaces child cancel starvation instead of reporting success', async () => {
    const h = (current = await seedHarness())
    const childId = ulid()
    const workflowId = (
      await h.db.select({ workflowId: tasks.workflowId }).from(tasks).where(eq(tasks.id, h.taskId))
    )[0]!.workflowId
    await h.db.insert(tasks).values({
      id: childId,
      name: 'starved child',
      workflowId,
      workflowSnapshot: JSON.stringify(h.definition),
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${childId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
      parentTaskId: h.taskId,
      invocationDepth: 1,
    })
    let cancelCasAttempts = 0
    const starvingDb = starveTaskCancelCas(h.db, childId, () => {
      cancelCasAttempts += 1
    })

    await expect(cancelTask(starvingDb, h.taskId)).rejects.toMatchObject({
      code: 'cancel-transition-starved',
    })

    expect(cancelCasAttempts).toBeGreaterThanOrEqual(8)
    expect((await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
      'canceled',
    )
    expect((await h.db.select().from(tasks).where(eq(tasks.id, childId)))[0]?.status).not.toBe(
      'canceled',
    )
  })

  test.each(['add', 'update', 'delete'] as const)(
    'cancel first makes a queued comment %s leave comment rows untouched',
    async (operation) => {
      const h = (current = await seedHarness())
      const mutate = (): Promise<unknown> => {
        if (operation === 'add') {
          return addReviewComment({
            db: h.db,
            appHome: h.appHome,
            nodeRunId: h.reviewRunId,
            anchor: {
              sectionPath: 'body',
              paragraphIdx: 0,
              offsetStart: 2,
              offsetEnd: 6,
              selectedText: 'body',
              contextBefore: '# ',
              contextAfter: ' inline',
              occurrenceIndex: 1,
            },
            commentText: 'too late',
          })
        }
        if (operation === 'update') {
          return updateReviewCommentText(h.db, h.reviewRunId, h.commentId, 'too late', OWNER_AUTHZ)
        }
        return deleteReviewComment(h.db, h.reviewRunId, h.commentId, OWNER_AUTHZ)
      }
      const [cancelResult, commentResult] = await settleInOrder(
        h.taskId,
        () => cancelTask(h.db, h.taskId),
        mutate,
      )

      expect(cancelResult.status).toBe('fulfilled')
      expectRejectedCode(commentResult, 'task-terminal')
      const comments = await h.db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.docVersionId, h.docVersionId))
      expect(comments).toHaveLength(1)
      expect(comments[0]?.id).toBe(h.commentId)
      expect(comments[0]?.commentText).toBe('original')
    },
  )

  test('comment first lands before queued cancel and remains an auditable pre-terminal fact', async () => {
    const h = (current = await seedHarness())
    const [commentResult, cancelResult] = await settleInOrder(
      h.taskId,
      () => updateReviewCommentText(h.db, h.reviewRunId, h.commentId, 'landed first', OWNER_AUTHZ),
      () => cancelTask(h.db, h.taskId),
    )

    expect(commentResult.status).toBe('fulfilled')
    expect(cancelResult.status).toBe('fulfilled')
    expect(
      (await h.db.select().from(reviewComments).where(eq(reviewComments.id, h.commentId)))[0]
        ?.commentText,
    ).toBe('landed first')
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
    ).toBe('canceled')
  })

  test.each(['failed', 'interrupted'] as const)(
    'RFC-202 keeps an awaiting review writable while its task is revivable (%s)',
    async (taskStatus) => {
      const h = (current = await seedHarness())
      await h.db.update(tasks).set({ status: taskStatus }).where(eq(tasks.id, h.taskId))

      await updateReviewCommentText(
        h.db,
        h.reviewRunId,
        h.commentId,
        `${taskStatus}-draft`,
        OWNER_AUTHZ,
      )

      expect(
        (await h.db.select().from(reviewComments).where(eq(reviewComments.id, h.commentId)))[0]
          ?.commentText,
      ).toBe(`${taskStatus}-draft`)
      expect(
        (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewRunId)))[0]?.status,
      ).toBe('awaiting_review')
    },
  )

  test('cancel first makes a queued selection leave both selection fields untouched', async () => {
    const h = (current = await seedHarness({ multiDoc: true }))
    const [cancelResult, selectionResult] = await settleInOrder(
      h.taskId,
      () => cancelTask(h.db, h.taskId),
      () =>
        setDocumentSelection({
          db: h.db,
          nodeRunId: h.reviewRunId,
          docVersionId: h.docVersionId,
          selection: 'accepted',
        }),
    )

    expect(cancelResult.status).toBe('fulfilled')
    expectRejectedCode(selectionResult, 'task-terminal')
    const doc = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, h.docVersionId))
    )[0]!
    expect(doc.selection).toBe('unselected')
    expect(doc.selectionStale).toBe(true)
  })

  test('selection first lands before queued cancel and is not rewritten by the sweep', async () => {
    const h = (current = await seedHarness({ multiDoc: true }))
    const [selectionResult, cancelResult] = await settleInOrder(
      h.taskId,
      () =>
        setDocumentSelection({
          db: h.db,
          nodeRunId: h.reviewRunId,
          docVersionId: h.docVersionId,
          selection: 'accepted',
        }),
      () => cancelTask(h.db, h.taskId),
    )

    expect(selectionResult.status).toBe('fulfilled')
    expect(cancelResult.status).toBe('fulfilled')
    const doc = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, h.docVersionId))
    )[0]!
    expect(doc.selection).toBe('accepted')
    expect(doc.selectionStale).toBe(false)
  })
})
