// RFC-297 T27 —— 清单条目的来源对账 chip。
//
// 这一列回答的是用户真正想知道的那个问题：「我配的东西到底进去了没有」。
//   · injected         —— 平台注入且运行时确认加载
//   · ambient          —— 运行时自带 / 从机器或项目配置继承来的（不是我配的）
//   · declared-missing —— 我配了，运行时没报告——与告警 banner 指向同一批名字
//
// 复用既有 <StatusChip>（同 StatusBadge 的做法，RFC-035 统一过一次），不新写
// 一套 chip 样式。

import { useTranslation } from 'react-i18next'
import type { InventoryProvenance } from '@agent-workflow/shared'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'

const KIND: Record<InventoryProvenance, StatusChipKind> = {
  injected: 'success',
  ambient: 'neutral',
  // 声明了却没加载是本面板最值得注意的一行——与 banner 的告警同色。
  'declared-missing': 'danger',
}

const I18N_KEY: Record<InventoryProvenance, string> = {
  injected: 'nodeDrawer.inventory.provenance.injected',
  ambient: 'nodeDrawer.inventory.provenance.ambient',
  'declared-missing': 'nodeDrawer.inventory.provenance.declaredMissing',
}

export function ProvenanceChip({ provenance }: { provenance: InventoryProvenance }) {
  const { t } = useTranslation()
  return (
    <StatusChip kind={KIND[provenance]} size="sm">
      {t(I18N_KEY[provenance])}
    </StatusChip>
  )
}
