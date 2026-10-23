import { z } from 'zod'

export interface GraphMergeRequestDelivery {
  kind: 'merge-request'
  status: 'active' | 'merged' | 'closed'
  ref: string
  webUrl: string | null
  sourceBranch: string | null
  targetBranch: string | null
  headSha: string
  targetSha: string | null
  mergedCommitSha: string | null
  draft: boolean
  mergeableState: 'mergeable' | 'conflict' | 'unknown'
  readyToMerge: boolean
  approvalHold: boolean | null
  unresolvedReviewCount: number
}

export interface GraphDeliveryContext {
  typeId: string
  state: unknown
  updatedAt: number
}

// Read the existing development context contract, without importing backend internals.
// Invalid or differently bound evidence remains unknown/stale in the presentation.
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const pipelineSchema = z
  .object({
    status: z.enum(['pending', 'passed', 'failed']),
    mergeRequestRef: z.string().min(1),
    headSha: sha,
    targetSha: sha.nullable().default(null),
    checks: z
      .array(
        z
          .object({
            checkRef: z.string(),
            name: z.string(),
            status: z.enum(['queued', 'running', 'passed', 'failed', 'canceled', 'skipped']),
            summary: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough()
const approvalSchema = z
  .object({
    status: z.enum(['draft', 'pending', 'approved', 'rejected', 'expired', 'unavailable']),
    mergeRequestRef: z.string().nullable(),
    headSha: sha.nullable(),
    deadlineAt: z.string().nullable(),
  })
  .passthrough()
const reviewsSchema = z
  .object({
    status: z.enum(['collected', 'acknowledged', 'prepared', 'replied']),
    mergeRequestRef: z.string(),
    sourceHeadSha: sha,
    publishedHeadSha: sha.nullable(),
    threads: z.array(
      z
        .object({
          threadRef: z.string(),
          disposition: z.enum(['addressed', 'needs-human']).nullable(),
          replyBody: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

export function projectGraphDeliveryCare(
  delivery: GraphMergeRequestDelivery | null,
  contexts: readonly GraphDeliveryContext[],
) {
  function read<T extends z.ZodTypeAny>(typeId: string, schema: T) {
    const context = contexts
      .filter((item) => item.typeId === typeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!context) return null
    const parsed = schema.safeParse(context.state)
    return parsed.success
      ? { value: parsed.data as z.infer<T>, updatedAt: context.updatedAt }
      : null
  }
  const pipeline = read('development.pipeline', pipelineSchema)
  const approval = read('development.approval', approvalSchema)
  const reviews = read('development.review-resolution', reviewsSchema)
  const matches = (ref: string | null, head: string | null) =>
    delivery !== null && ref === delivery.ref && head === delivery.headSha
  return {
    pipeline: pipeline
      ? {
          ...pipeline,
          current:
            matches(pipeline.value.mergeRequestRef, pipeline.value.headSha) &&
            pipeline.value.targetSha === delivery?.targetSha,
        }
      : null,
    approval: approval
      ? {
          ...approval,
          current: matches(approval.value.mergeRequestRef, approval.value.headSha),
        }
      : null,
    reviews: reviews
      ? {
          ...reviews,
          current: matches(
            reviews.value.mergeRequestRef,
            reviews.value.publishedHeadSha ?? reviews.value.sourceHeadSha,
          ),
        }
      : null,
  }
}
export type GraphDeliveryCare = ReturnType<typeof projectGraphDeliveryCare>

export interface GraphDeliveryProgress {
  mode: 'merge-request' | 'local-artifact'
  caseState: string
  terminalKind: string | null
  blockReason: string | null
  workItemRef: string | null
  nextAction: { tone: 'info' | 'warning' | 'success'; title: string; body: string }
  delivery: GraphMergeRequestDelivery | null
  care: GraphDeliveryCare
}

export function graphDeliveryStatus(progress: GraphDeliveryProgress, zh: boolean) {
  const { delivery } = progress
  if (delivery?.status === 'merged')
    return {
      tone: 'success' as const,
      title: zh ? 'MR 已合入' : 'Merge request merged',
      body: zh
        ? '本次 MR 交付已完成，设计、验证和修复历史继续保留。'
        : 'The MR delivery is complete. Design, verification and repair history remain available.',
    }
  if (delivery?.status === 'closed')
    return {
      tone: 'warning' as const,
      title: zh ? 'MR 已关闭，未合入' : 'Merge request closed without merging',
      body: zh
        ? '该 MR 的看护已经结束；关闭不代表变更已进入目标分支。'
        : 'Care for this MR has ended. Closing it does not put the change on the target branch.',
    }
  // Ending the Case stops publication/care even if its last repository snapshot
  // is still active, or its last work item was waiting for approval or a merge.
  if (progress.caseState === 'terminal' || progress.caseState === 'blocked')
    return progress.nextAction
  if (progress.mode === 'local-artifact' && !delivery)
    return {
      tone: 'info' as const,
      title: zh ? '本地产物交付' : 'Local artifact delivery',
      body: zh
        ? '此任务沿用创建时的本地产物模式。内部候选提交不包含 MR 提交和持续看护。'
        : 'This case retains its original local artifact mode. An internal candidate commit does not include MR submission or ongoing care.',
    }
  if (!delivery)
    return {
      tone: 'info' as const,
      title: zh ? 'MR 尚未创建' : 'Merge request not yet created',
      body: zh
        ? '设计批准、实现与独立验证通过后，数字人会发布工作分支并创建 MR，然后继续处理 CI、评审和合并冲突。'
        : 'After design approval, implementation and independent verification, the employee publishes the working branch, creates an MR, and continues with CI, review feedback and merge conflicts.',
    }
  if (progress.nextAction.tone === 'warning') return progress.nextAction
  const stages: Record<string, [string, string]> = {
    'observe-mr': ['同步 MR 最新状态', 'Synchronize the latest MR state'],
    'classify-feedback': ['归因评审意见', 'Classify review feedback'],
    'acknowledge-feedback': ['确认收到评审意见', 'Acknowledge review feedback'],
    'repair-feedback': ['修复评审问题', 'Repair review findings'],
    'reply-feedback': ['发布修复并回复评审', 'Publish repairs and reply to reviewers'],
    'collect-pipeline': [
      '收集当前提交的流水线结果',
      'Collect pipeline results for the current commit',
    ],
    'classify-pipeline': ['分析流水线失败原因', 'Classify pipeline failures'],
    'repair-pipeline': ['修复流水线问题', 'Repair pipeline failures'],
    'repair-conflict': ['处理合并冲突', 'Resolve merge conflicts'],
    'publish-conflict': ['发布冲突修复', 'Publish conflict repairs'],
    'prepare-approval': ['准备审批材料', 'Prepare approval material'],
    'submit-approval': ['提交审批', 'Submit approval'],
    'observe-approval': ['跟踪审批结果', 'Track approval results'],
    'evaluate-ready': ['检查合并条件', 'Evaluate merge readiness'],
  }
  const stage = progress.workItemRef && stages[progress.workItemRef]
  if (stage)
    return { tone: 'info' as const, title: stage[zh ? 0 : 1], body: progress.nextAction.body }
  if (
    delivery.approvalHold ||
    (progress.care.approval?.current && progress.care.approval.value.status === 'pending')
  )
    return {
      tone: 'info' as const,
      title: zh ? '等待审批结果' : 'Awaiting approval',
      body: zh
        ? '审批状态更新后会自动继续，当前 MR 和审批记录保留在本页。'
        : 'Work resumes when the approval state changes. The current MR and approval record remain on this page.',
    }
  if (delivery.readyToMerge || progress.workItemRef === 'wait-merge')
    return {
      tone: 'info' as const,
      title: zh ? '等待 MR 合入' : 'Awaiting MR merge',
      body: zh
        ? '数字人继续跟踪 MR 的源提交、目标分支、CI 和评审；收到权威合入或关闭结果后才结束看护。'
        : 'The employee keeps tracking the MR head, target branch, CI and reviews until an authoritative merge or close result ends care.',
    }
  return progress.nextAction
}

export function deliveryStateLabel(state: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    active: ['MR 开放中', 'MR open'],
    merged: ['已合入', 'Merged'],
    closed: ['已关闭，未合入', 'Closed without merging'],
    pending: ['等待结果', 'Pending'],
    passed: ['通过', 'Passed'],
    failed: ['失败', 'Failed'],
    queued: ['排队中', 'Queued'],
    running: ['执行中', 'Running'],
    canceled: ['已取消', 'Canceled'],
    skipped: ['已跳过', 'Skipped'],
    draft: ['草稿', 'Draft'],
    approved: ['已批准', 'Approved'],
    rejected: ['已拒绝', 'Rejected'],
    expired: ['已过期', 'Expired'],
    unavailable: ['暂不可用', 'Unavailable'],
    mergeable: ['无合并冲突', 'No merge conflicts'],
    conflict: ['存在合并冲突', 'Merge conflicts'],
    unknown: ['尚未确认', 'Unknown'],
    collected: ['已收集评审意见', 'Feedback collected'],
    acknowledged: ['已确认接收', 'Feedback acknowledged'],
    prepared: ['修复已准备', 'Repair prepared'],
    replied: ['修复已发布并回复', 'Repair published and replied'],
    addressed: ['已处理', 'Addressed'],
    'needs-human': ['需人工判断', 'Needs human judgment'],
  }
  return labels[state]?.[zh ? 0 : 1] ?? state
}
