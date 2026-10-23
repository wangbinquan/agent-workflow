import { expect, test } from 'vitest'
import {
  deliveryStateLabel,
  graphDeliveryStatus,
  type GraphDeliveryProgress,
  type GraphMergeRequestDelivery,
} from '@/features/development-automation/graph-development/graphDeliveryModel'

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

test.each([true, false])('MR preparation describes CI as configuration-dependent (zh=%s)', (zh) => {
  const progress = { ...stopped(zh, null), caseState: 'active', terminalKind: null }
  const status = graphDeliveryStatus(progress, zh)
  expect(status.title).toBe(zh ? 'MR 尚未创建' : 'Merge request not yet created')
  expect(status.body).toContain(zh ? 'CI 看护需要' : 'CI care requires')
  expect(status.body).toContain(zh ? '启动时的岗位' : 'frozen when this work started')
})

test.each([true, false])(
  'MR observation explains repository updates and external termination instead of internal event names (zh=%s)',
  (zh) => {
    const progress = {
      ...stopped(zh, delivery()),
      caseState: 'waiting',
      terminalKind: null,
      workItemRef: 'observe-mr',
      nextAction: {
        tone: 'info' as const,
        title: 'waiting for event',
        body: 'verification request, review request, implementation request',
      },
    }
    const status = graphDeliveryStatus(progress, zh)
    expect(status.body).toContain(
      zh ? '源提交、目标分支、评审和冲突状态' : 'MR head, target branch, reviews and conflicts',
    )
    expect(status.body).toContain(
      zh ? '仓库确认合入或关闭后结束看护' : 'repository confirms that the MR was merged or closed',
    )
    expect(status.body).toContain(
      zh ? '启动时的岗位配置' : 'configuration frozen when this work started',
    )
    expect(status.body).not.toContain('verification request')
    expect(status.body).not.toContain('implementation request')
  },
)

test.each([true, false])(
  'blocked and warning next actions remain authoritative over ordinary MR stage copy (zh=%s)',
  (zh) => {
    const nextAction = {
      tone: 'warning' as const,
      title: zh ? '需要重新审核设计' : 'Design review required',
      body: zh ? '候选依据已变化，请重新审核。' : 'The candidate basis changed; review it again.',
    }
    for (const caseState of ['blocked', 'waiting']) {
      for (const value of [null, delivery()]) {
        const progress = {
          ...stopped(zh, value),
          caseState,
          terminalKind: null,
          workItemRef: 'observe-mr',
          nextAction,
        }
        expect(graphDeliveryStatus(progress, zh)).toEqual(nextAction)
      }
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
