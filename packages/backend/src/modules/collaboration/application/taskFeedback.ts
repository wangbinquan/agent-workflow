import { ulid } from 'ulid'
import type { TaskFeedback } from '@agent-workflow/shared'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type { ReviewActor } from '../public/types'
import type { ReviewTaskAccessPort } from './ports/reviewTaskAccess'
import type { TaskFeedbackStore } from './ports/taskFeedbackStore'

export interface CreateTaskFeedbackInput {
  readonly actor: ReviewActor
  readonly taskId: string
  readonly bodyMd: string
}

export interface CreateTaskFeedbackResult {
  readonly feedback: TaskFeedback
  readonly distillJobId: string
}

export class TaskFeedbackService {
  constructor(
    private readonly store: TaskFeedbackStore,
    private readonly taskAccess: ReviewTaskAccessPort,
    private readonly now: () => number = Date.now,
    private readonly mintId: () => string = ulid,
  ) {}

  async canView(actor: ReviewActor, taskId: string): Promise<boolean> {
    const task = await this.store.loadTaskIdentity(taskId)
    if (task === null) return false
    return (await this.taskAccess.resolveRelationship(actor, task.id, task.ownerUserId)).taskVisible
  }

  async create(
    input: CreateTaskFeedbackInput,
    memoryDistillEnqueuer: MemoryDistillEnqueuer,
  ): Promise<CreateTaskFeedbackResult> {
    const id = this.mintId()
    await this.store.insert({
      id,
      taskId: input.taskId,
      authorUserId: input.actor.user.id,
      bodyMd: input.bodyMd,
      createdAt: this.now(),
    })
    const enqueued = await memoryDistillEnqueuer.enqueue({
      sourceKind: 'feedback',
      sourceEventId: id,
      taskId: input.taskId,
    })
    await this.store.markDistilled(id, enqueued.jobId)
    const feedback = await this.store.getById(id)
    if (feedback === null) {
      throw new Error('task_feedback row vanished immediately after insert')
    }
    return { feedback, distillJobId: enqueued.jobId }
  }

  async list(taskId: string): Promise<readonly TaskFeedback[]> {
    return await this.store.listByTask(taskId)
  }

  async listRecent(limit = 20): Promise<readonly TaskFeedback[]> {
    return await this.store.listRecent(limit)
  }
}
