// RFC-261 — 页码分页公共组件（新公共原语）：上一页 / 下一页 + 「第 x / y 页」
// + 直接跳页（按钮或 Enter 提交）。
// 服务端 offset 分页列表面共用（首个消费者：webhook 投递审计 DeliveriesPanel）。
// pageCount<=1 时仍渲染（禁用态）保持布局稳定。
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NumberInput } from '@/components/Form'

export function Pagination(props: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  disabled?: boolean
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const safePageCount = Math.max(1, Math.trunc(props.pageCount))
  const [targetPage, setTargetPage] = useState<number | undefined>(props.page)
  const prevDisabled = props.disabled === true || props.page <= 1
  const nextDisabled = props.disabled === true || props.page >= safePageCount
  const jumpDisabled = props.disabled === true || safePageCount <= 1

  useEffect(() => {
    setTargetPage(Math.min(Math.max(1, Math.trunc(props.page)), safePageCount))
  }, [props.page, safePageCount])

  const jumpToPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (jumpDisabled) return
    if (targetPage === undefined || !Number.isInteger(targetPage)) {
      setTargetPage(props.page)
      return
    }
    const nextPage = Math.min(Math.max(1, targetPage), safePageCount)
    setTargetPage(nextPage)
    if (nextPage !== props.page) props.onPageChange(nextPage)
  }

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
      <span className="muted pagination__label" aria-live="polite">
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
      <form
        className="pagination__jump"
        aria-label={t('common.pagination.jumpFormAria')}
        noValidate
        onSubmit={jumpToPage}
      >
        <label className="pagination__jump-field">
          <span>{t('common.pagination.jumpLabel')}</span>
          <NumberInput
            value={targetPage}
            onChange={setTargetPage}
            min={1}
            max={safePageCount}
            step={1}
            disabled={jumpDisabled}
            className="form-input--sm pagination__jump-input"
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <button
          type="submit"
          className="btn btn--sm"
          aria-label={t('common.pagination.jumpActionAria')}
          disabled={jumpDisabled}
        >
          {t('common.pagination.jumpAction')}
        </button>
      </form>
    </nav>
  )
}
