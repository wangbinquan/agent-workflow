// RFC-261 — 页码分页公共组件（新公共原语）：上一页 / 下一页 + 「第 x / y 页」。
// 服务端 offset 分页列表面共用（首个消费者：webhook 投递审计 DeliveriesPanel）。
// pageCount<=1 时仍渲染（禁用态）保持布局稳定。
import { useTranslation } from 'react-i18next'

export function Pagination(props: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  disabled?: boolean
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const prevDisabled = props.disabled === true || props.page <= 1
  const nextDisabled = props.disabled === true || props.page >= props.pageCount
  return (
    <nav
      className="pagination"
      aria-label={t('common.pagination.aria')}
      data-testid={props['data-testid']}
    >
      <button
        type="button"
        className="btn btn--sm"
        disabled={prevDisabled}
        onClick={() => props.onPageChange(props.page - 1)}
      >
        {t('common.pagination.prev')}
      </button>
      <span className="muted pagination__label">
        {t('common.pagination.pageOf', { page: props.page, pageCount: props.pageCount })}
      </span>
      <button
        type="button"
        className="btn btn--sm"
        disabled={nextDisabled}
        onClick={() => props.onPageChange(props.page + 1)}
      >
        {t('common.pagination.next')}
      </button>
    </nav>
  )
}
