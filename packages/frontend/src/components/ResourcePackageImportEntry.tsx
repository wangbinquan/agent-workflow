// RFC-271 T37 —— 列表页的「导入配置包」入口。
//
// 按钮 + 对话框 + 导入后失效缓存，打包成一个组件：六个列表页各接一行，而不是每页
// 复制一遍 `useState` + `<Dialog>` + `invalidateQueries`。
//
// **一个入口通吃六类**：包的根类型写在包里，用户不需要先选「我要导入哪一类」——
// 那是把内部结构泄漏成交互负担。所以六个列表页挂的是同一个组件，落到哪一类由包决定。

import { useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ResourcePackageImportDialog } from '@/components/ResourcePackageImportDialog'

export interface ResourcePackageImportEntryProps {
  /** 导入完成后要失效的查询键（各列表页自己的那把）。 */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>
  className?: string
}

export function ResourcePackageImportEntry(props: ResourcePackageImportEntryProps): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className={props.className ?? 'btn btn--sm'}
        data-testid="import-package-entry"
        onClick={() => setOpen(true)}
      >
        {t('resourcePackage.importTitle')}
      </button>
      <ResourcePackageImportDialog
        open={open}
        onClose={() => setOpen(false)}
        onImported={() => {
          // 导入可能同时落多类资源（一个工作流包会带进 agent / 技能 / MCP…），
          // 所以失效的不只是当前列表——调用方把相关的键都传进来。
          for (const key of props.invalidateKeys ?? []) {
            void qc.invalidateQueries({ queryKey: [...key] })
          }
        }}
      />
    </>
  )
}
