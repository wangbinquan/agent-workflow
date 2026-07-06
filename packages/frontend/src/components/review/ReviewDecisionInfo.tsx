// RFC-142 — 决策信息块（公共组件）。
//
// 已决策版本 / 轮次的「谁在什么时间做了什么决策、原因是什么」统一展示：
//   - 决策 chip（StatusChip）+ 决策人（AttributionChip；系统行显示「系统」）+ 决策时间；
//   - rejected 显示退回原因全文（缺失显示「未记录」占位）；
//   - superseded 显示系统作废说明（'upstream-refreshed' 映射 i18n 固定文案，
//     未知历史值原样透传）；
//   - iterated 不重复展示 decisionReason —— 它是渲染态评论块，与页面已呈现的
//     冻结评论逐字重复（design D1）。
// 三个调用位：单文档详情（当前 + 历史只读视图）、多文档轮视图。pending /
// 无决策时渲染 null。
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { AttributionChip, type AttributionRole } from '@/components/AttributionChip'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'

export type ReviewDecisionView = 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'

function chipKind(decision: ReviewDecisionView): StatusChipKind {
  if (decision === 'approved') return 'success'
  if (decision === 'rejected') return 'danger'
  if (decision === 'iterated') return 'info'
  return 'neutral'
}

/** superseded 的机器标记（services/review.ts 刷新退休路径写死的值）。 */
const UPSTREAM_REFRESHED = 'upstream-refreshed'

export interface ReviewDecisionInfoProps {
  decision: ReviewDecisionView | undefined
  decisionReason?: string | null | undefined
  decidedAt?: number | null | undefined
  decidedBy?: string | null | undefined
  decidedByRole?: AttributionRole
  /** useUserLookup 解析出的决策人公开信息（加载中 / 未知为 undefined）。 */
  user?: UserPublic | undefined
  'data-testid'?: string
}

export function ReviewDecisionInfo(props: ReviewDecisionInfoProps) {
  const { t } = useTranslation()
  const { decision } = props
  if (decision === undefined || decision === 'pending') return null
  const isSystem = props.decidedBy === 'system'
  const trimmedReason = props.decisionReason?.trim() ?? ''
  const reason =
    decision === 'rejected'
      ? trimmedReason.length > 0
        ? trimmedReason
        : t('reviews.decisionInfo.reasonMissing')
      : decision === 'superseded'
        ? trimmedReason.length === 0 || trimmedReason === UPSTREAM_REFRESHED
          ? t('reviews.decisionInfo.supersededReason')
          : trimmedReason
        : null
  return (
    <div
      className="review-decision-info"
      data-testid={props['data-testid'] ?? 'review-decision-info'}
    >
      <p className="page__hint review-decision-info__row">
        <StatusChip kind={chipKind(decision)} size="sm">
          {t(`reviews.decision.${decision}` as const)}
        </StatusChip>{' '}
        {t('attribution.decidedBy')}:{' '}
        {isSystem ? (
          <span className="chip chip--tight">{t('reviews.decisionInfo.systemDecider')}</span>
        ) : (
          <AttributionChip
            userId={props.decidedBy}
            role={props.decidedByRole ?? null}
            user={props.user}
          />
        )}
        {props.decidedAt !== null && props.decidedAt !== undefined && (
          <span className="muted">
            {' '}
            · {t('reviews.decisionInfo.decidedAt')} {new Date(props.decidedAt).toLocaleString()}
          </span>
        )}
      </p>
      {reason !== null && (
        <p className="page__hint review-decision-info__reason" data-testid="review-decision-reason">
          {decision === 'rejected' && (
            <span className="review-decision-info__reason-label">
              {t('reviews.decisionInfo.rejectReason')}:{' '}
            </span>
          )}
          {reason}
        </p>
      )}
    </div>
  )
}
