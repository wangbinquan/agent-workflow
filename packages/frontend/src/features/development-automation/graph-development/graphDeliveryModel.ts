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

/** An initial empty pending context is a placeholder, not evidence that CI has started. */
export function graphPipelineStatus(pipeline: GraphDeliveryCare['pipeline']) {
  if (!pipeline || (pipeline.value.status === 'pending' && pipeline.value.checks.length === 0))
    return 'unknown'
  if (!pipeline.current) return 'stale'
  if (pipeline.value.status !== 'pending') return pipeline.value.status
  if (pipeline.value.checks.some((check) => check.status === 'running')) return 'running'
  if (pipeline.value.checks.some((check) => check.status === 'queued')) return 'queued'
  return 'pending'
}

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
  if (progress.nextAction.tone === 'warning') return progress.nextAction
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
        ? '设计批准、实现与独立验证通过后，数字人会发布工作分支并创建 MR，继续处理评审和合并冲突。CI 看护需要本工作启动时的岗位已配置企业流水线连接。'
        : 'After design approval, implementation and independent verification, the employee publishes the working branch, creates an MR, and handles reviews and merge conflicts. CI care requires a pipeline connection in the job configuration frozen when this work started.',
    }
  const stages: Record<string, [string, string, string, string]> = {
    'observe-mr': [
      '同步 MR 最新状态',
      'Synchronize the latest MR state',
      '数字人会同步 MR 的源提交、目标分支、评审和冲突状态；仓库确认合入或关闭后结束看护。CI 检查按本工作启动时的岗位配置执行。',
      'The employee synchronizes the MR head, target branch, reviews and conflicts. Care ends when the repository confirms that the MR was merged or closed. CI checks follow the job configuration frozen when this work started.',
    ],
    'classify-feedback': [
      '归因评审意见',
      'Classify review feedback',
      '正在判断哪些评审意见需要修改代码、补充说明或人工决定，处理结果会保留在 MR 记录中。',
      'Review feedback is being classified into code changes, explanations or human decisions. The handling results remain in the MR record.',
    ],
    'acknowledge-feedback': [
      '确认收到评审意见',
      'Acknowledge review feedback',
      '正在确认收到新的评审意见，随后按意见内容修复或回复。',
      'New review feedback is being acknowledged before the employee repairs or replies to it.',
    ],
    'repair-feedback': [
      '修复评审问题',
      'Repair review findings',
      '正在按已批准的设计修复评审问题；发布前会重新验证修改后的候选。',
      'Review findings are being repaired against the approved design. The changed candidate is verified again before publication.',
    ],
    'reply-feedback': [
      '发布修复并回复评审',
      'Publish repairs and reply to reviewers',
      '正在将处理结果回复到原评审线程；需要改代码的修复会更新当前 MR。',
      'Results are being posted to the original review threads. Repairs that require code changes update this MR.',
    ],
    'collect-pipeline': [
      '收集当前提交的流水线结果',
      'Collect pipeline results for the current commit',
      '正在通过已配置的连接收集流水线状态和检查记录；结果必须对应当前 MR 的源提交和目标分支。',
      'The configured connection is collecting pipeline states and check records for the current MR head and target branch.',
    ],
    'classify-pipeline': [
      '分析流水线失败原因',
      'Classify pipeline failures',
      '正在依据流水线检查和日志判断失败原因，再按岗位配置安排修复。',
      'Pipeline checks and logs are being used to identify the cause of failure and select the repair configured for this job.',
    ],
    'repair-pipeline': [
      '修复流水线问题',
      'Repair pipeline failures',
      '正在修复当前提交的流水线问题；修改后重新验证候选并等待新提交的检查结果。',
      'Pipeline failures for the current commit are being repaired. The changed candidate is verified again and new checks must match the published commit.',
    ],
    'repair-conflict': [
      '处理合并冲突',
      'Resolve merge conflicts',
      '正在将目标分支的变化合入当前工作分支并处理冲突；修复仍须符合已批准的设计。',
      'Target branch changes are being merged into the working branch and conflicts resolved against the approved design.',
    ],
    'publish-conflict': [
      '发布冲突修复',
      'Publish conflict repairs',
      '正在验证并发布冲突修复，随后重新同步 MR 的提交和合并状态。',
      'The conflict repair is being verified and published before the MR commits and mergeability are synchronized again.',
    ],
    'prepare-approval': [
      '准备审批材料',
      'Prepare approval material',
      '正在为当前 MR 提交准备审批材料，材料和后续决定会保留在审批记录中。',
      'Approval material is being prepared for the current MR commit. The material and decision remain in the approval record.',
    ],
    'submit-approval': [
      '提交审批',
      'Submit approval',
      '正在通过已配置的审批流程提交材料，随后跟踪该提交对应的审批决定。',
      'Material is being submitted through the configured approval process. The decision is tracked for the corresponding commit.',
    ],
    'observe-approval': [
      '跟踪审批结果',
      'Track approval results',
      '审批决定更新后继续处理当前 MR；旧提交的审批不会作为当前提交已批准的依据。',
      'Work on this MR continues when the approval decision changes. Approval for an earlier commit does not approve the current commit.',
    ],
    'evaluate-ready': [
      '检查合并条件',
      'Evaluate merge readiness',
      '正在核对当前 MR 的提交、检查、评审和审批记录；条件满足后等待仓库侧合入，数字人不会自动合并。',
      'The current MR commits, checks, reviews and approvals are being checked. Once the prerequisites are met, the employee waits for the repository to merge the MR; it does not merge automatically.',
    ],
  }
  const stage = progress.workItemRef && stages[progress.workItemRef]
  if (stage) return { tone: 'info' as const, title: stage[zh ? 0 : 1], body: stage[zh ? 2 : 3] }
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
        ? '数字人继续跟踪 MR 的源提交、目标分支和评审，并按本工作的岗位配置跟踪 CI；收到仓库确认的合入或关闭结果后才结束看护。'
        : 'The employee keeps tracking the MR head, target branch and reviews, with CI care as configured for this work. Care ends only when the repository confirms a merge or close.',
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
