// RFC-261 UI 修订 — 列表页筛选栏公共原语。
//
// 为什么是公共组件而不是某页私有 chrome：仓内已有三处同族形态各写各的
//   · `.user-directory__toolbar`（卡片式：Segmented + Select，本组件的视觉母本）
//   · `.changes__toolbar`（行内 label + 控件成组）
//   · `OperationsToolbar`（/tasks 系：筛选收进弹层，适合筛选维度多 + 带搜索的场景）
// 前两者是同一件东西的两份实现。本组件把它抽成一份：卡片容器 + 控件族左对齐 +
// 动作（清除筛选）右对齐 + 每个控件带可见维度标签。首个消费者是 webhook 投递
// 审计面板；`user-directory` 视觉等价、可后续迁移过来（记 audit-backlog，不在
// 本次改动里动它以免掀翻 users 页的视觉基线）。
//
// 维度标签用 <span> 而非 <label>：Select 是自定义 role=combobox 按钮且已带
// `ariaLabel`（完整描述，如「按事件类型过滤」），再套 <label> 会双重标注；
// 视觉标签给眼睛、aria-label 给读屏——`.changes__toolbar-label` 同款分工。
import type { ReactNode } from 'react'

export function FilterBar(props: {
  /** 筛选栏整体的可访问名（role=group）。 */
  ariaLabel: string
  /** Dense audit/list surfaces may trim chrome without changing control targets. */
  density?: 'default' | 'compact'
  /** 筛选控件（Segmented / FilterField 包裹的 Select 等），左对齐成一族。 */
  children: ReactNode
  /** 右对齐动作位——典型是「清除筛选」；无激活筛选时传 undefined 即不渲染。 */
  trailing?: ReactNode
  'data-testid'?: string
}) {
  return (
    <div
      className={`filter-bar${props.density === 'compact' ? ' filter-bar--compact' : ''}`}
      role="group"
      aria-label={props.ariaLabel}
      data-testid={props['data-testid']}
    >
      <div className="filter-bar__controls">{props.children}</div>
      {props.trailing !== undefined && props.trailing !== null && (
        <div className="filter-bar__actions">{props.trailing}</div>
      )}
    </div>
  )
}

/** 一个筛选维度：可见标签 + 控件。选中后控件只显示值（`push` / `acme/api`），
 *  没有标签就分不清哪个下拉管哪个维度——这正是本次修订要解决的问题。 */
export function FilterField(props: { label: string; children: ReactNode }) {
  return (
    <span className="filter-bar__field">
      <span className="filter-bar__label">{props.label}</span>
      {props.children}
    </span>
  )
}
