// RFC-271 T35 —— 六类详情/编辑页共用的「导出配置包」入口。
//
// 做成**一个公共组件**而不是每页复制一套：六处的行为完全一致（点一下、下载一个
// zip、失败给一条可读的错），复制六份的唯一结果是六份各自漂移。
//
// 普通入口走公共 `.btn`；More 内则复用统一的 `ResourceActionItem`。

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { downloadResourcePackage, type ExportableType } from '@/api/resourcePackages'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ResourceActionItem, useResourceActionBusy } from '@/components/ResourceActionList'
import { resourcePackageFilename, triggerBlobDownload } from '@/lib/resource-package-download'

export interface ResourcePackageExportButtonProps {
  type: ExportableType
  id: string
  /** 资源显示名——只用于文件名。 */
  name: string
  variant?: 'button' | 'action'
  description?: string
  disabled?: boolean
  disabledReason?: string
  className?: string
  'data-testid'?: string
  /** 可选的额外失败通知；组件自身始终保留可见的 ErrorBanner。 */
  onError?: (message: string) => void
}

export function ResourcePackageExportButton(props: ResourcePackageExportButtonProps): ReactElement {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const reportActionBusy = useResourceActionBusy()
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const disabled = busy || props.disabled === true

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const runExport = (): void => {
    if (disabled) return
    setError(null)
    setBusy(true)
    reportActionBusy?.(true)
    const abort = new AbortController()
    abortRef.current?.abort()
    abortRef.current = abort
    void downloadResourcePackage(props.type, props.id, abort.signal)
      .then((blob) => {
        if (!mountedRef.current || abort.signal.aborted) return
        triggerBlobDownload(blob, resourcePackageFilename(props.type, props.name))
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || abort.signal.aborted) return
        setError(err)
        props.onError?.(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!mountedRef.current || abortRef.current !== abort) return
        abortRef.current = null
        setBusy(false)
        reportActionBusy?.(false)
      })
  }

  const testid = props['data-testid'] ?? `export-package-${props.type}`
  const label = busy ? t('resourcePackage.exporting') : t('resourcePackage.exportPackage')
  const control =
    props.variant === 'action' ? (
      <ResourceActionItem
        label={label}
        description={
          props.disabled === true && props.disabledReason !== undefined
            ? props.disabledReason
            : (props.description ?? t('resourcePackage.exportHint'))
        }
        disabled={disabled}
        title={props.disabled === true ? props.disabledReason : undefined}
        aria-busy={busy || undefined}
        data-testid={testid}
        onClick={runExport}
      />
    ) : (
      <button
        type="button"
        className={props.className ?? 'btn'}
        disabled={disabled}
        title={props.disabled === true ? props.disabledReason : undefined}
        aria-busy={busy || undefined}
        data-testid={testid}
        onClick={runExport}
      >
        {label}
      </button>
    )

  return (
    <>
      {error !== null ? <ErrorBanner error={error} /> : null}
      {control}
    </>
  )
}
