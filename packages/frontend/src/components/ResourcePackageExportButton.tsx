// RFC-271 T35 —— 六类详情/编辑页共用的「导出配置包」入口。
//
// 做成**一个公共组件**而不是每页复制一套：六处的行为完全一致（点一下、下载一个
// zip、失败给一条可读的错），复制六份的唯一结果是六份各自漂移。
//
// 样式全部走既有 class（`.btn .btn--sm`），不引入任何自有 CSS。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { downloadResourcePackage, type ExportableType } from '@/api/resourcePackages'
import { resourcePackageFilename, triggerBlobDownload } from '@/lib/resource-package-download'

export interface ResourcePackageExportButtonProps {
  type: ExportableType
  id: string
  /** 资源显示名——只用于文件名。 */
  name: string
  className?: string
  'data-testid'?: string
  /** 失败时交给页面既有的错误呈现（各页的 banner 位置不同，这里不自己渲染）。 */
  onError?: (message: string) => void
}

export function ResourcePackageExportButton(props: ResourcePackageExportButtonProps): ReactElement {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  return (
    <button
      type="button"
      className={props.className ?? 'btn btn--sm'}
      disabled={busy}
      data-testid={props['data-testid'] ?? `export-package-${props.type}`}
      onClick={() => {
        setBusy(true)
        void downloadResourcePackage(props.type, props.id)
          .then((blob) => {
            triggerBlobDownload(blob, resourcePackageFilename(props.type, props.name))
          })
          .catch((err: unknown) => {
            // 导出会因为「闭包里有你看不见的资源」整体失败（AC-7）——那是**预期内**
            // 的产品行为，不是异常，所以要把服务端那句可读的原因交回给页面，而不是
            // 吞掉或弹一个通用错误。
            props.onError?.(err instanceof Error ? err.message : String(err))
          })
          .finally(() => setBusy(false))
      }}
    >
      {t('resourcePackage.exportPackage')}
    </button>
  )
}
