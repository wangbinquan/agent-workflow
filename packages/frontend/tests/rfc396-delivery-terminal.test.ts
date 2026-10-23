import { expect, test } from 'vitest'
import {
  deliveryStateLabel,
  graphDeliveryStatus,
  type GraphDeliveryProgress,
  type GraphMergeRequestDelivery,
} from '@/components/digital-employees/graphDeliveryModel'

function delivery(
  status: GraphMergeRequestDelivery['status'] = 'active',
): GraphMergeRequestDelivery {
  return {
    kind: 'merge-request',
    status,
    ref: 'repo!42',
    webUrl: 'https://example.test/repo/-/merge_requests/42',
    sourceBranch: 'work/42',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    mergedCommitSha: status === 'merged' ? 'c'.repeat(40) : null,
    draft: false,
    mergeableState: 'mergeable',
    readyToMerge: true,
    approvalHold: false,
    unresolvedReviewCount: 0,
  }
}

function stopped(zh: boolean, value: GraphMergeRequestDelivery | null): GraphDeliveryProgress {
  return {
    mode: 'merge-request',
    caseState: 'terminal',
    terminalKind: 'canceled',
    blockReason: null,
    workItemRef: 'wait-merge',
    nextAction: {
      tone: 'info',
      title: zh ? '工作已结束' : 'Work finished',
      body: zh
        ? '数字员工已停止关注这个工作对象，完整历史仍保留在本页。'
        : 'The employee stopped watching this work; the full history remains here.',
    },
    delivery: value,
    care: { pipeline: null, approval: null, reviews: null },
  }
}

test.each([true, false])(
  'a terminal case without an MR never promises future publication (zh=%s)',
  (zh) => {
    for (const mode of ['merge-request', 'local-artifact'] as const) {
      const progress = { ...stopped(zh, null), mode }
      const status = graphDeliveryStatus(progress, zh)
      expect(status.title).toBe(zh ? '工作已结束' : 'Work finished')
      expect(status.body).toContain(zh ? '已停止关注' : 'stopped watching')
      expect(status.body).not.toContain(zh ? '会发布' : 'publishes the working branch')
    }
  },
)

test.each([true, false])(
  'a stopped case with an open MR no longer claims running care or waiting for merge (zh=%s)',
  (zh) => {
    for (const workItemRef of ['collect-pipeline', 'observe-approval', 'wait-merge']) {
      const progress = { ...stopped(zh, delivery()), workItemRef }
      const status = graphDeliveryStatus(progress, zh)
      expect(status.title).toBe(zh ? '工作已结束' : 'Work finished')
      expect(status.body).toContain(zh ? '已停止关注' : 'stopped watching')
      expect(status.body).not.toContain(zh ? '继续跟踪' : 'keeps tracking')
      expect(progress.delivery?.status).toBe('active')
    }
    // An open repository object alone does not mean the digital employee is still watching it.
    expect(deliveryStateLabel('active', zh)).toBe(zh ? 'MR 开放中' : 'MR open')
  },
)

test.each([true, false])(
  'authoritative merged and closed receipts take precedence over a generic terminal state (zh=%s)',
  (zh) => {
    const merged = graphDeliveryStatus(stopped(zh, delivery('merged')), zh)
    expect(merged).toMatchObject({
      title: zh ? 'MR 已合入' : 'Merge request merged',
      tone: 'success',
    })
    const closed = graphDeliveryStatus(stopped(zh, delivery('closed')), zh)
    expect(closed).toMatchObject({
      title: zh ? 'MR 已关闭，未合入' : 'Merge request closed without merging',
      tone: 'warning',
    })
  },
)
