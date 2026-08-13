// RFC-297 T24 —— 一张按 driver 表态选列的通用清单表，取代 RFC-029 的四张
// 手写表（AgentsTable / SkillsTable / McpsTable / PluginsTable）。
//
// 为什么不是「五张表」：加 `tools` 面时如果照着抄第五张，差异就永远散在五个
// 组件里；而两个运行时报告的字段本来就不同（opencode 的 dump 插件给 mode /
// model / path / description / type / hint，claude 的 init 只给名字 + MCP 状态），
// 硬凑一套固定列的结果只能是「给 claude 渲染一排空白」。
//
// 「动态」落在**选列**而不是**造列**：字段集是编译期封闭的联合，列名一一对应
// i18n 键（`Resources` interface 是强类型的，运行时冒出来的字段名会以英文原文
// 泄漏到中文界面）。driver 只是对每个字段表态，本组件据此决定这一列渲不渲染。

import { useTranslation } from 'react-i18next'
import type {
  FaceSupport,
  InventoryEntry,
  InventoryFace,
  InventoryFieldsByFace,
} from '@agent-workflow/shared'
import { INVENTORY_FIELDS_BY_FACE } from '@agent-workflow/shared'
import { StatusBadge } from './StatusBadge'
import { sourceLabel } from './sourceLabel'
import { ProvenanceChip } from './ProvenanceChip'

type AnyField = InventoryFieldsByFace[InventoryFace]

interface Props {
  face: InventoryFace
  entries: readonly InventoryEntry[]
  /** 该面下每个富字段的表态；`unsupported` 的字段整列不渲染。 */
  fields: Readonly<Record<string, FaceSupport>>
  /** 存量行没有平台声明清单可对账时隐藏来源列（显示会是一整列错值）。 */
  showProvenance: boolean
}

export function InventoryFaceTable({ face, entries, fields, showProvenance }: Props) {
  const { t } = useTranslation()
  const columns = (INVENTORY_FIELDS_BY_FACE[face] as readonly AnyField[]).filter(
    (field) => fields[field] !== 'unsupported',
  )

  if (entries.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }

  return (
    <table className={`inventory-table inventory-table--${face}`}>
      <colgroup>
        <col className="col-name" />
        {showProvenance && <col className="col-provenance" />}
        {columns.map((field) => (
          <col key={field} className={`col-${field}`} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th>{t('nodeDrawer.inventory.col.name')}</th>
          {showProvenance && <th>{t('nodeDrawer.inventory.col.provenance')}</th>}
          {columns.map((field) => (
            <th key={field}>{t(`nodeDrawer.inventory.col.${field}` as const)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.key}>
            <td>
              <span title={entry.name}>{entry.name}</span>
            </td>
            {showProvenance && (
              <td>
                <ProvenanceChip provenance={entry.provenance} />
              </td>
            )}
            {columns.map((field) => (
              <td key={field}>
                <Cell entry={entry} field={field} support={fields[field]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Cell({
  entry,
  field,
  support,
}: {
  entry: InventoryEntry
  field: AnyField
  support: FaceSupport | undefined
}) {
  const { t } = useTranslation()
  // 注入了但该运行时不报告——与「报告了但没有值」是两回事，故给出解释而非空白。
  if (support === 'unobservable') {
    return (
      <span className="muted" title={t('nodeDrawer.inventory.fieldUnobservable')}>
        —
      </span>
    )
  }
  if (field === 'model') {
    const provider = entry.modelProviderId
    const id = entry.modelId
    if (provider == null && id == null) return <>—</>
    return <>{`${provider ?? '?'} / ${id ?? '?'}`}</>
  }
  if (field === 'status') {
    return entry.status == null ? <>—</> : <StatusBadge status={entry.status} />
  }
  if (field === 'source') {
    return entry.source == null ? <>—</> : <>{sourceLabel(entry.source, t)}</>
  }
  const value =
    field === 'mode'
      ? entry.mode
      : field === 'path'
        ? entry.path
        : field === 'description'
          ? entry.description
          : field === 'type'
            ? entry.type
            : field === 'hint'
              ? entry.hint
              : null
  if (value == null || value === '') return <>—</>
  return <span title={value}>{value}</span>
}
