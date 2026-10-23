import { Card } from '@/components/Card'
import { FormSection } from '@/components/FormSection'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip } from '@/components/StatusChip'
import {
  deliveryStateLabel,
  graphDeliveryStatus,
  graphPipelineStatus,
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
  const ended =
    progress.caseState === 'terminal' ||
    delivery?.status === 'merged' ||
    delivery?.status === 'closed'
  const pipelineStatus = graphPipelineStatus(care.pipeline)
  const missingPipelineResults = pipelineStatus === 'unknown'
  const unknown = zh ? '尚未确认' : 'Unknown'
  const versionLabel = (current: boolean) =>
    ended
      ? current
        ? zh
          ? '与本次交付版本一致'
          : 'Matches the recorded delivery'
        : zh
          ? '其他版本的历史记录'
          : 'Historical record for another revision'
      : current
        ? zh
          ? '当前提交'
          : 'Current commit'
        : zh
          ? '旧版本记录，等待重新检查'
          : 'Previous version; awaiting a new check'
  const pipelineConfiguration = (
    <p className="muted">
      {zh
        ? '仅凭空记录无法判断是否配置或启动了 CI。需要 CI 看护时，请核对岗位的企业流水线连接。配置后用该岗位新建工作；已有工作保持启动时的配置。'
        : 'An empty record does not establish whether CI is configured or has started. For CI care, check the job’s pipeline connection and start new work with the configured job. Existing work retains the configuration it started with.'}{' '}
      <a href="/digital-employees/graph-development%402?view=jobs&jobTemplateId=platform%3Agraph-development%3Ajob%3Amr-ci-v1&workItem=collect-pipeline">
        {ended
          ? zh
            ? '为后续工作配置 CI 看护岗位'
            : 'Configure CI care for future work'
          : zh
            ? '配置 CI 看护岗位'
            : 'Configure CI care job'}
      </a>
    </p>
  )
  return (
    <Card
      title={
        ended
          ? zh
            ? '交付记录'
            : 'Delivery record'
          : zh
            ? '交付与持续看护'
            : 'Delivery and ongoing care'
      }
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
            <p>
              <strong>{delivery.ref}</strong> ·{' '}
              <span>
                {delivery.sourceBranch ?? unknown} → {delivery.targetBranch ?? unknown}
              </span>
            </p>
            <section
              aria-label={zh ? '流水线检查' : 'Pipeline checks'}
              className="graph-design__stack"
            >
              <strong>
                {ended
                  ? zh
                    ? 'CI 历史记录'
                    : 'CI history'
                  : `${zh ? 'CI 流水线' : 'CI pipeline'} · ${
                      pipelineStatus === 'stale' ? unknown : deliveryStateLabel(pipelineStatus, zh)
                    }`}
              </strong>
              {missingPipelineResults ? (
                <>
                  <p className="muted">
                    {zh
                      ? '尚无可读取的流水线检查结果，不能判为通过。'
                      : 'No readable pipeline check results are available; CI cannot be considered passed.'}
                  </p>
                  {!ended && pipelineConfiguration}
                </>
              ) : ended ? (
                <p className="muted">
                  {zh
                    ? '工作已结束，检查结果保留在下方明细中。'
                    : 'This work has ended. Check results remain in the details below.'}
                </p>
              ) : pipelineStatus === 'stale' ? (
                <p className="muted">{versionLabel(false)}</p>
              ) : null}
            </section>
            <FormSection
              title={
                ended
                  ? zh
                    ? '查看交付历史明细'
                    : 'View delivery history'
                  : zh
                    ? '版本、检查、审批与评审记录'
                    : 'Version, check, approval and review records'
              }
              size="compact"
              collapsible
              data-testid="graph-delivery-records"
            >
              <div className="graph-design__stack">
                {ended && (
                  <p className="muted">
                    {zh
                      ? '以下是工作结束时保留的记录，不再等待流水线、评审或审批。'
                      : 'These records were retained when the work ended. Pipeline checks, reviews and approvals are no longer awaited.'}
                  </p>
                )}
                <dl className="employee-case-context-facts">
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
                            ? ended
                              ? '记录时存在审批暂停'
                              : '等待审批'
                            : ended
                              ? 'Approval hold was present'
                              : 'Waiting for approval'
                          : zh
                            ? '无审批暂停'
                            : 'No approval hold'}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {ended
                        ? zh
                          ? '合并条件（记录值）'
                          : 'Merge prerequisites (recorded)'
                        : zh
                          ? '已满足合并条件'
                          : 'Merge prerequisites met'}
                    </dt>
                    <dd>
                      {delivery.readyToMerge
                        ? zh
                          ? ended
                            ? '已满足'
                            : '是，等待仓库侧合入'
                          : ended
                            ? 'Met'
                            : 'Yes; awaiting repository merge'
                        : zh
                          ? ended
                            ? '未满足'
                            : '尚未满足'
                          : ended
                            ? 'Not met'
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
                {care.pipeline && (
                  <section
                    aria-label={zh ? '流水线记录' : 'Pipeline record'}
                    className="graph-design__stack"
                  >
                    <strong>
                      {zh ? '记录中的流水线状态' : 'Recorded pipeline status'} ·{' '}
                      {deliveryStateLabel(care.pipeline.value.status, zh)}
                    </strong>
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
                          {!care.pipeline!.current
                            ? zh
                              ? '（旧版本）'
                              : ' (previous version)'
                            : ''}
                          {check.summary && <p className="muted">{check.summary}</p>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {ended && missingPipelineResults && pipelineConfiguration}
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
              </div>
            </FormSection>
          </>
        )}
      </div>
    </Card>
  )
}
