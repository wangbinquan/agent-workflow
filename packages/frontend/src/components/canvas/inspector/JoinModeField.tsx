// RFC-306 — how this node reacts when only SOME of its inbound edges carried a
// value. Rendered next to the display name for every kind that can sit
// downstream of a branch.
//
// Only shown when the node actually HAS two or more inbound dependencies:
// with one inbound edge the two modes are identical, and offering a choice that
// changes nothing is worse than offering none — the author would reasonably
// conclude the setting is broken.

import {
  joinModeOf,
  type JoinMode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { atomicNodeInspectorChange, type InspectorChangeMeta } from './historyMeta'
import { InspectorFieldAnchor } from './InspectorFieldAnchor'

/** Inbound dependency count as the AUTHOR sees it: edges plus the implicit
 *  bindings review/output nodes carry (they have no edges of their own). */
function inboundCount(definition: WorkflowDefinition, node: WorkflowNode): number {
  const edges = definition.edges.filter((e) => e.target.nodeId === node.id).length
  const rec = node as unknown as Record<string, unknown>
  if (node.kind === 'review') return edges + (rec.inputSource === undefined ? 0 : 1)
  if (node.kind === 'output' && Array.isArray(rec.ports)) {
    return edges + (rec.ports as unknown[]).filter((p) => (p as { bind?: unknown })?.bind).length
  }
  return edges
}

export function JoinModeField({
  node,
  definition,
  onPatch,
}: {
  node: WorkflowNode
  definition: WorkflowDefinition
  onPatch: (next: WorkflowNode, meta: InspectorChangeMeta) => void
}) {
  const { t } = useTranslation()
  if (inboundCount(definition, node) < 2) return null
  const current = joinModeOf(node as { joinMode?: unknown })
  const set = (mode: JoinMode) => {
    const next = { ...(node as Record<string, unknown>) }
    // 'any' is the default — strip the field rather than persisting it, so a
    // definition that never touched this setting stays byte-identical.
    if (mode === 'any') delete next.joinMode
    else next.joinMode = mode
    onPatch(
      next as unknown as WorkflowNode,
      atomicNodeInspectorChange(node.id, 'joinMode', t('inspector.fieldJoinMode')),
    )
  }
  return (
    <InspectorFieldAnchor nodeId={node.id} field="join-mode">
      <Field label={t('inspector.fieldJoinMode')} hint={t('inspector.fieldJoinModeHint')}>
        {/* RFC-317 T63（findings FE-01）—— 改用公共 `<Segmented>`。
            改造前这里手搓 `.segmented` 容器 + 两个 `<button className={... 'is-active'}>`：
            · `.segmented .is-active` 在 styles.css 里**根本不存在**（公共原语用的是
              `segmented__option` / `segmented__option--active`，36px 最小高度那条规则
              也是键在 `segmented__option` 上）——于是这两个按钮在一个有样式的胶囊容器里
              完全没有样式；
            · `role="group"` + `aria-pressed` 不是分段控件的语义，公共原语给的是
              `role="radiogroup"` / `role="radio"` / `aria-checked` + roving tabIndex
              + 方向键 / Home / End 导航，这些全都丢了。
            `testidPrefix` 正好产出原来的两个 testid，行为测试不用改。 */}
        <Segmented<JoinMode>
          value={current}
          onChange={set}
          ariaLabel={t('inspector.fieldJoinMode')}
          testidPrefix="node-join-mode"
          options={[
            { value: 'any', label: t('inspector.joinModeAny') },
            { value: 'all', label: t('inspector.joinModeAll') },
          ]}
        />
      </Field>
    </InspectorFieldAnchor>
  )
}
