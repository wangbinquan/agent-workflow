// RFC-022: shared visual for the agent dependsOn closure. Used by the
// AgentForm edit preview (driven by closure-preview endpoint) and by the
// node-run Stats tab (driven by closure GET endpoint).
//
// Layout: indentation + ASCII connector glyphs (`├─` / `└─` / `│`). Pure
// CSS — no graph library. Duplicate references (same agent already
// expanded somewhere up-tree) render with `↑ see above` and no children, so
// diamond closures don't blow up vertically.

import { useTranslation } from 'react-i18next'
import { useUserLookup } from '@/hooks/useUserLookup'
import type { DependencyTreeNode } from '@/lib/dependency-tree'
import { resourceOptionLabel } from '@/lib/resource-option-label'

interface DependencyTreeProps {
  tree: DependencyTreeNode
  /** Called when the user clicks an agent name; the parent navigates. */
  onNodeClick?: (id: string) => void
}

export function DependencyTree({ tree, onNodeClick }: DependencyTreeProps) {
  const { t } = useTranslation()
  const ownerIds: Array<string | null | undefined> = []
  const pending = [tree]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) continue
    ownerIds.push(node.ownerUserId)
    pending.push(...node.children)
  }
  const owners = useUserLookup(ownerIds)
  const ownerLabel = (ownerUserId: string | null | undefined): string | undefined =>
    owners.get(ownerUserId)?.displayName ?? ownerUserId ?? undefined
  return (
    <div className="dep-tree" role="tree" aria-label={t('dependencyTree.ariaTreeLabel')}>
      <Row
        node={tree}
        prefix=""
        isRoot={true}
        isLast={true}
        onNodeClick={onNodeClick}
        ownerLabel={ownerLabel}
      />
    </div>
  )
}

interface RowProps {
  node: DependencyTreeNode
  /** Vertical guide-line prefix for this row's depth. */
  prefix: string
  isRoot: boolean
  /** When true, the row sits at the bottom of its sibling group; we draw `└─`
   *  for its connector and no `│` after it. */
  isLast: boolean
  onNodeClick?: (id: string) => void
  ownerLabel: (ownerUserId: string | null | undefined) => string | undefined
}

function Row({ node, prefix, isRoot, isLast, onNodeClick, ownerLabel }: RowProps) {
  const connector = isRoot ? '' : isLast ? '└─ ' : '├─ '
  return (
    <>
      <div
        className="dep-tree__row"
        role="treeitem"
        aria-label={resourceOptionLabel(node.name, ownerLabel(node.ownerUserId))}
      >
        <span className="dep-tree__guide" aria-hidden="true">
          {prefix}
          {connector}
        </span>
        <NodeLabel
          node={node}
          missing={node.missing}
          masked={node.masked}
          onNodeClick={onNodeClick}
          ownerLabel={ownerLabel}
        />
      </div>
      {node.children.map((child, idx) => {
        const childIsLast = idx === node.children.length - 1
        const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ')
        return (
          <Row
            key={`${child.id}-${idx}`}
            node={child}
            prefix={childPrefix}
            isRoot={false}
            isLast={childIsLast}
            onNodeClick={onNodeClick}
            ownerLabel={ownerLabel}
          />
        )
      })}
    </>
  )
}

function NodeLabel({
  node,
  missing,
  masked,
  onNodeClick,
  ownerLabel,
}: {
  node: DependencyTreeNode
  missing: boolean
  masked: boolean
  onNodeClick?: (id: string) => void
  ownerLabel: (ownerUserId: string | null | undefined) => string | undefined
}) {
  const { t } = useTranslation()
  const clickable =
    node.id !== '' && !missing && !masked && !node.duplicateRef && onNodeClick !== undefined
  const displayName = resourceOptionLabel(node.name, ownerLabel(node.ownerUserId))
  const label = (
    <span className="dep-tree__name">
      {missing
        ? t('dependencyTree.missingPrefix', { name: node.name })
        : masked
          ? t('dependencyTree.maskedPrefix', { name: node.name })
          : displayName}
    </span>
  )
  return (
    <span className="dep-tree__label">
      {clickable ? (
        <button
          type="button"
          className="dep-tree__link"
          onClick={() => onNodeClick(node.id)}
          aria-label={t('dependencyTree.openAgentAria', { name: displayName })}
        >
          {label}
        </button>
      ) : (
        label
      )}
      {!missing && !masked && (
        <span className="dep-tree__chips">
          {node.skills.length > 0 && (
            <span className="dep-tree__chip">
              {t('dependencyTree.skills', { names: node.skills.join(', ') })}
            </span>
          )}
          {node.mcps.length > 0 && (
            <span className="dep-tree__chip">
              {t('dependencyTree.mcps', { names: node.mcps.join(', ') })}
            </span>
          )}
          {node.plugins.length > 0 && (
            <span className="dep-tree__chip">
              {t('dependencyTree.plugins', { names: node.plugins.join(', ') })}
            </span>
          )}
        </span>
      )}
      {node.duplicateRef && (
        <span className="dep-tree__seeAbove">{t('dependencyTree.seeAbove')}</span>
      )}
    </span>
  )
}

/**
 * RFC-022: separate, single-line ASCII renderer for `agent-dependency-cycle`
 * error responses. Lives next to `<DependencyTree>` so AgentForm imports
 * both from the same module.
 */
export function DependencyCycleHint({ cyclePath }: { cyclePath: readonly string[] }) {
  const { t } = useTranslation()
  return (
    <p className="dep-tree__cycle" role="alert">
      <strong>{t('dependencyTree.cycleHeading')}</strong> <code>{cyclePath.join(' → ')}</code>
    </p>
  )
}
