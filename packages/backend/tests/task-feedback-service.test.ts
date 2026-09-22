// RFC-041 — task feedback service + clarify/review enqueue hooks.

import { beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { memoryDistillJobs, taskFeedback, tasks, workflows } from '../src/db/schema'
import { TaskFeedbackService } from '../src/modules/collaboration/application/taskFeedback'
import { DrizzleTaskFeedbackStore } from '../src/modules/collaboration/infrastructure/taskFeedbackStore'
import type { ReviewActor } from '../src/modules/collaboration/public/types'
import type { MemoryDistillEnqueuer } from '../src/modules/memory/public/participants'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

const ACTOR: ReviewActor = {
  user: { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin', status: 'active' },
  source: 'session',
  permissions: new Set(),
}

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const wfId = ulid()
  await db
    .insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return taskId
}

function createTestDistillEnqueuer(db: ProviderNeutralDatabase): MemoryDistillEnqueuer {
  return {
    async enqueue(input) {
      const jobId = ulid()
      const createdAt = Date.now()
      const debounceKey = `${input.taskId}:feedback`
      const nextRunAt = createdAt + 5_000
      await db.insert(memoryDistillJobs).values({
        id: jobId,
        debounceKey,
        sourceKind: input.sourceKind,
        sourceEventId: input.sourceEventId,
        taskId: input.taskId,
        scopeResolvedJson: '{}',
        status: 'pending',
        attempts: 0,
        nextRunAt,
        createdAt,
        outputLang: null,
      })
      return { jobId, debounceKey, nextRunAt }
    },
  }
}

describeEachProvider('createTaskFeedback', (harness) => {
  let db: ProviderNeutralDatabase
  let service: TaskFeedbackService
  beforeEach(() => {
    db = harness.db
    service = new TaskFeedbackService(new DrizzleTaskFeedbackStore(db), {
      canManageReviewers: () => true,
      resolveRelationship: async () => ({
        taskVisible: true,
        taskActorRole: 'owner',
        resourceAclBypass: true,
      }),
      visibleTaskIds: async (_actor, taskIds) => new Set(taskIds),
    })
    resetBroadcastersForTests()
  })

  test('inserts the feedback row + enqueues a distill job + back-links job id', async () => {
    const taskId = await seedTask(db)
    const r = await service.create(
      {
        actor: ACTOR,
        taskId,
        bodyMd: 'remember this',
      },
      createTestDistillEnqueuer(db),
    )
    expect(r.feedback.taskId).toBe(taskId)
    expect(r.feedback.bodyMd).toBe('remember this')
    expect(r.feedback.distilled).toBe(true)
    expect(r.feedback.distillJobId).toBe(r.distillJobId)

    // Distill job row created
    const jobs = await db.select().from(memoryDistillJobs).all()
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.sourceKind).toBe('feedback')
    expect(jobs[0]!.sourceEventId).toBe(r.feedback.id)
    expect(jobs[0]!.debounceKey).toBe(`${taskId}:feedback`)

    // Feedback row updated with distill_job_id
    const fb = (
      await db.select().from(taskFeedback).where(eq(taskFeedback.id, r.feedback.id)).all()
    )[0]!
    expect(fb.distillJobId).toBe(r.distillJobId)
    expect(fb.distilled).toBe(1)
  })

  // RFC-366 AC-15（能力影响清单 C3 的用户可见后果）。
  //
  // 这条存在的理由：RFC-366 给五类源加了 launch_origin 准入门之后，
  // `enqueueDistillJob` 多了一种**正常结局**——返回 null（定时 / webhook / 事件 / API /
  // 内部任务在默认白名单下被拒）。留言本身照常保存、照常列出，只是不再有蒸馏 job。
  // 上面那条正向用例只覆盖了「有 job」的一半；被拒那一半如果写成 `enqueued!.jobId`
  // 就会在生产上抛，写成 `?? undefined` 就会让 UI 的「已交付提炼」chip 挂着一个不存在
  // 的 job id。判据在 `taskFeedback.ts` 的 `if (enqueued !== null) await
  // this.store.markDistilled(...)` 与 `distillJobId: enqueued?.jobId ?? null` 两行。
  test('AC-15: 入队被准入门拒绝时，留言照常落库但 distilled=false / distillJobId=null', async () => {
    const taskId = await seedTask(db)
    const rejecting: MemoryDistillEnqueuer = {
      async enqueue() {
        return null
      },
    }
    const r = await service.create(
      { actor: ACTOR, taskId, bodyMd: 'scheduled-run note' },
      rejecting,
    )

    // 留言本体不受影响——被拒的是提炼，不是留言。
    expect(r.feedback.taskId).toBe(taskId)
    expect(r.feedback.bodyMd).toBe('scheduled-run note')
    expect(await service.list(taskId)).toHaveLength(1)

    // 两个字段都必须是「没有 job」的形态，不能是 undefined、空串或残留的旧值。
    expect(r.distillJobId).toBeNull()
    expect(r.feedback.distilled).toBe(false)
    expect(r.feedback.distillJobId).toBeNull()

    // 落库侧同样：markDistilled 一次都不该被调用。
    const fb = (
      await db.select().from(taskFeedback).where(eq(taskFeedback.id, r.feedback.id)).all()
    )[0]!
    expect(fb.distilled).toBe(0)
    expect(fb.distillJobId).toBeNull()

    // 而且确实没有任何 job 行被写出来。
    expect(await db.select().from(memoryDistillJobs).all()).toHaveLength(0)
  })

  test('listTaskFeedback returns asc by createdAt', async () => {
    const taskId = await seedTask(db)
    await service.create({ actor: ACTOR, taskId, bodyMd: 'first' }, createTestDistillEnqueuer(db))
    await new Promise((r) => setTimeout(r, 5))
    await service.create({ actor: ACTOR, taskId, bodyMd: 'second' }, createTestDistillEnqueuer(db))
    const list = await service.list(taskId)
    expect(list.length).toBe(2)
    expect(list[0]!.bodyMd).toBe('first')
    expect(list[1]!.bodyMd).toBe('second')
  })
})
