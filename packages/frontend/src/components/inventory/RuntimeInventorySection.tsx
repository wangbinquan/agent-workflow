// 节点详情 Session 页顶部的「运行时清单」：这一轮子进程实际加载了什么。
//
// RFC-297 把它从 opencode 专属改成跨运行时统一。原先它只认 RFC-029 dump 插件
// 写的快照，于是 Claude Code 运行时永远拿到空值，界面上显示「未生成清单文件
// （插件可能加载失败）」——把锅甩给一个 claude 根本没有的插件（用户实证的 bug）。
//
// 现在数据源由后端按各运行时自己的观测源取，前端只认一套形状，并按响应里带回
// 的 driver **静态表态**选列：
//   · 面 `unsupported` → 整块不渲染（「没有这个概念」≠「加载了 0 个」）
//   · 字段 `unsupported` → 整列不出（不给 claude 渲染一排空白）
//   · 字段 `unobservable` → 出列但显示 —，并解释「注入了但运行时不报告」
// 前端因此不认识任何运行时名字。

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { InventoryFace, RuntimeInventoryResponse } from '@agent-workflow/shared'
import { INVENTORY_FACES, isAgentNodeKind } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { InventoryFaceTable } from './InventoryFaceTable'

interface Props {
  taskId: string
  nodeRunId: string
  workflowNodeKind: string | null
}

export function RuntimeInventorySection({ taskId, nodeRunId, workflowNodeKind }: Props) {
  const { t } = useTranslation()
  // useState (not useEffect) so the open/closed preference is preserved
  // across attempt switches per RFC-029 AC-9.
  const [open, setOpen] = useState(false)
  // Non-agent kinds never produce inventory; the early-return below renders
  // nothing so the Session tab's `sessionNotApplicable` placeholder owns the
  // layout. The query is kept enabled-by-flag so hook order stays stable
  // (react-hooks/rules-of-hooks).
  const enabled = isAgentNodeKind(workflowNodeKind)
  const query = useQuery<RuntimeInventoryResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'inventory'],
    enabled,
    queryFn: ({ signal }) =>
      api.get<RuntimeInventoryResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/inventory`,
        undefined,
        signal,
      ),
  })
  if (!enabled) return null
  const data = query.data
  const observation = data?.observation
  const renderedFaces =
    data === undefined
      ? []
      : INVENTORY_FACES.filter((face) => data.declaration[face].support !== 'unsupported')

  return (
    <details
      className="inventory-section"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      data-testid="runtime-inventory-section"
    >
      <summary className="inventory-section__summary">
        <span>{t('nodeDrawer.inventory.title')}</span>
        {observation?.state === 'captured' && (
          <span className="inventory-section__chips" data-testid="inventory-chips">
            {renderedFaces.map((face) => (
              // 不支持的面不进 chips —— 显示「插·0」会被读成「加载了 0 个插件」。
              <span key={face} className="inventory-section__chip">
                {t(`nodeDrawer.inventory.chip.${face}` as const)}·
                {observation.faces[face]?.length ?? 0}
              </span>
            ))}
          </span>
        )}
      </summary>
      <InventoryBody query={query} faces={renderedFaces} />
    </details>
  )
}

interface QueryShape {
  isLoading: boolean
  error: unknown
  data: RuntimeInventoryResponse | undefined
}

function InventoryBody({ query, faces }: { query: QueryShape; faces: readonly InventoryFace[] }) {
  const { t } = useTranslation()
  if (query.isLoading) {
    return <div className="inventory-section__pending">{t('nodeDrawer.inventory.pending')}</div>
  }
  if (query.error !== null && query.error !== undefined) {
    return <div className="inventory-section__missing">{t('nodeDrawer.inventory.loadFailed')}</div>
  }
  const data = query.data
  if (data === undefined) return null
  const { observation, declaration } = data

  if (observation.state !== 'captured') {
    return (
      <div className="inventory-section__missing" data-testid="inventory-missing">
        {t(`nodeDrawer.inventory.reason.${observation.reason}`, {
          defaultValue: observation.reason,
        })}
        {observation.message != null && observation.message !== '' && (
          <span className="muted"> — {observation.message}</span>
        )}
      </div>
    )
  }

  return (
    <div className="inventory-section__body">
      {faces.map((face) => (
        <div key={face}>
          <h4 className="inventory-section__subtitle">
            {t(`nodeDrawer.inventory.subtitle.${face}` as const)}
          </h4>
          {declaration[face].support === 'unobservable' ? (
            // 平台会注入这一面，但运行时不报告——说清楚，别留一张空表让人猜。
            <div className="muted inventory-section__empty">
              {t('nodeDrawer.inventory.faceUnobservable')}
            </div>
          ) : (
            <InventoryFaceTable
              face={face}
              entries={observation.faces[face] ?? []}
              fields={declaration[face].fields}
              showProvenance={observation.provenanceUnavailable !== true}
            />
          )}
        </div>
      ))}
    </div>
  )
}
