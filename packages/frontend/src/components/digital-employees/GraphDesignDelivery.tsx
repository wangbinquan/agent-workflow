import { Card } from '@/components/Card'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip } from '@/components/StatusChip'
import {
  deliveryStateLabel,
  graphDeliveryStatus,
  type GraphDeliveryProgress,
} from './graphDeliveryModel'

export function GraphDesignDelivery({
  progress,
  zh,
}: {
  progress: GraphDeliveryProgress
  zh: boolean
}) {
  const { delivery, care } = progress
  const next = graphDeliveryStatus(progress, zh)
  const unknown = zh ? '尚未确认' : 'Unknown'
  const versionLabel = (current: boolean) =>
    current
      ? zh
        ? '当前提交'
        : 'Current commit'
      : zh
        ? '旧版本记录，等待重新检查'
        : 'Previous version; awaiting a new check'
  return (
    <Card
      title={zh ? '交付与持续看护' : 'Delivery and ongoing care'}
      data-testid="graph-delivery-care"
      actions={
        delivery && (
          <StatusChip
            kind={
              delivery.status === 'merged'
                ? 'success'
                : delivery.status === 'closed'
                  ? 'neutral'
                  : 'info'
            }
          >
            {deliveryStateLabel(delivery.status, zh)}
          </StatusChip>
        )
      }
    >
      <div className="graph-design__stack">
        <NoticeBanner
          tone={next.tone}
          title={next.title}
          action={
            delivery?.webUrl ? (
              <a
                className="btn btn--sm btn--primary"
                href={delivery.webUrl}
                target="_blank"
                rel="noreferrer"
              >
                {zh ? '打开 MR' : 'Open MR'}
              </a>
            ) : undefined
          }
        >
          {next.body}
        </NoticeBanner>
        {delivery && (
          <>
            <dl className="employee-case-context-facts">
              <div>
                <dt>MR</dt>
                <dd>{delivery.ref}</dd>
              </div>
              <div>
                <dt>{zh ? '源分支 → 目标分支' : 'Source → target branch'}</dt>
                <dd>
                  {delivery.sourceBranch ?? unknown} → {delivery.targetBranch ?? unknown}
                </dd>
              </div>
              <div>
                <dt>{zh ? '当前提交' : 'Current head'}</dt>
                <dd>
                  <code>{delivery.headSha}</code>
                </dd>
              </div>
              <div>
                <dt>{zh ? '目标分支提交' : 'Target commit'}</dt>
                <dd>
                  <code>{delivery.targetSha ?? unknown}</code>
                </dd>
              </div>
              <div>
                <dt>{zh ? '合并状态' : 'Mergeability'}</dt>
                <dd>
                  {deliveryStateLabel(delivery.mergeableState, zh)}
                  {delivery.draft ? (zh ? ' · 草稿' : ' · Draft') : ''}
                </dd>
              </div>
              <div>
                <dt>{zh ? '未解决评审' : 'Unresolved reviews'}</dt>
                <dd>{delivery.unresolvedReviewCount}</dd>
              </div>
              <div>
                <dt>{zh ? '审批暂停' : 'Approval hold'}</dt>
                <dd>
                  {delivery.approvalHold === null
                    ? unknown
                    : delivery.approvalHold
                      ? zh
                        ? '等待审批'
                        : 'Waiting for approval'
                      : zh
                        ? '无审批暂停'
                        : 'No approval hold'}
                </dd>
              </div>
              <div>
                <dt>{zh ? '已满足合并条件' : 'Merge prerequisites met'}</dt>
                <dd>
                  {delivery.readyToMerge
                    ? zh
                      ? '是，等待仓库侧合入'
                      : 'Yes; awaiting repository merge'
                    : zh
                      ? '尚未满足'
                      : 'Not yet'}
                </dd>
              </div>
              {delivery.mergedCommitSha && (
                <div>
                  <dt>{zh ? '合入提交' : 'Merged commit'}</dt>
                  <dd>
                    <code>{delivery.mergedCommitSha}</code>
                  </dd>
                </div>
              )}
            </dl>
            <section
              aria-label={zh ? '流水线检查' : 'Pipeline checks'}
              className="graph-design__stack"
            >
              <strong>
                {zh ? 'CI 流水线' : 'CI pipeline'} ·{' '}
                {care.pipeline?.current
                  ? deliveryStateLabel(care.pipeline.value.status, zh)
                  : unknown}
              </strong>
              {care.pipeline ? (
                <>
                  <p className="muted">
                    {versionLabel(care.pipeline.current)} · {zh ? '记录更新于' : 'Record updated'}{' '}
                    {new Date(care.pipeline.updatedAt).toLocaleString()}
                  </p>
                  {!care.pipeline.current && (
                    <p>
                      {zh ? '记录中的提交：' : 'Recorded commit: '}
                      <code>{care.pipeline.value.headSha}</code> →{' '}
                      <code>{care.pipeline.value.targetSha ?? unknown}</code>
                    </p>
                  )}
                  <ul className="graph-design__list">
                    {care.pipeline.value.checks.map((check) => (
                      <li key={check.checkRef}>
                        {check.name} · {deliveryStateLabel(check.status, zh)}
                        {!care.pipeline!.current ? (zh ? '（旧版本）' : ' (previous version)') : ''}
                        {check.summary && <p className="muted">{check.summary}</p>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">
                  {zh
                    ? '尚无可读取的流水线检查记录；未配置连接时不会开始 CI 看护，也不能判为通过。岗位配置后请使用该岗位新建工作；正在运行的工作保持启动时的配置。'
                    : 'No readable pipeline check record yet. CI care requires a configured connection; missing evidence does not mean passed. After configuring the job, use it to start new work. Existing work retains its original configuration.'}{' '}
                  <a href="/digital-employees/graph-development%402?view=jobs&jobTemplateId=platform%3Agraph-development%3Ajob%3Amr-ci-v1&workItem=collect-pipeline">
                    {zh ? '配置 CI 看护岗位' : 'Configure CI care job'}
                  </a>
                </p>
              )}
            </section>
            {care.approval && (
              <section aria-label={zh ? '审批进度' : 'Approval progress'}>
                <strong>
                  {zh ? '审批' : 'Approval'} ·{' '}
                  {care.approval.current
                    ? deliveryStateLabel(care.approval.value.status, zh)
                    : unknown}
                </strong>
                <p className="muted">
                  {versionLabel(care.approval.current)} · {zh ? '记录更新于' : 'Record updated'}{' '}
                  {new Date(care.approval.updatedAt).toLocaleString()}
                </p>
                {care.approval.value.deadlineAt && (
                  <p>
                    {zh ? '截止时间' : 'Deadline'}:{' '}
                    {new Date(care.approval.value.deadlineAt).toLocaleString()}
                  </p>
                )}
              </section>
            )}
            {care.reviews && (
              <section aria-label={zh ? '评审反馈处理' : 'Review feedback handling'}>
                <strong>
                  {zh ? '评审反馈' : 'Review feedback'} ·{' '}
                  {deliveryStateLabel(care.reviews.value.status, zh)}
                </strong>
                <p className="muted">{versionLabel(care.reviews.current)}</p>
                <ul className="graph-design__list">
                  {care.reviews.value.threads.map((thread) => (
                    <li key={thread.threadRef}>
                      {thread.threadRef} ·{' '}
                      {thread.disposition
                        ? deliveryStateLabel(thread.disposition, zh)
                        : zh
                          ? '待归因'
                          : 'Awaiting classification'}
                      {thread.replyBody && <p>{thread.replyBody}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
