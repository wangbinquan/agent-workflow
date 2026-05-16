// RFC-022: shared visual for the agent dependsOn closure. Used by the
// AgentForm edit preview (driven by closure-preview endpoint) and by the
// node-run Stats tab (driven by closure GET endpoint).
//
// Layout: indentation + ASCII connector glyphs (`├─` / `└─` / `│`). Pure
// CSS — no graph library. Duplicate references (same agent already
// expanded somewhere up-tree) render with `↑ see above` and no children, so
// diamond closures don't blow up vertically.

import { useTranslation } from 'react-i18next'
import type { DependencyTreeNode } from '@/lib/dependency-tree'

interface DependencyTreeProps {
  tree: DependencyTreeNode
  /** Called when the user clicks an agent name; the parent navigates. */
  onNodeClick?: (name: string) => void
}

export function DependencyTree({ tree, onNodeClick }: DependencyTreeProps) {
  return (
    <div className="dep-tree" role="tree" aria-label="Dependency tree">
      <Row node={tree} prefix="" isRoot={true} isLast={true} onNodeClick={onNodeClick} />
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
  onNodeClick?: (name: string) => void
}

function Row({ node, prefix, isRoot, isLast, onNodeClick }: RowProps) {
  const connector = isRoot ? '' : isLast ? '└─ ' : '├─ '
  const missing = node.description === '' && node.skillCount === 0 && !node.duplicateRef
  // A truly missing agent has no row in the flat list — buildDependencyTree
  // returns a placeholder with empty fields. We rely on the convention that
  // the dependsOn entries are always non-empty so this heuristic is safe.
  return (
    <>
      <div className="dep-tree__row" role="treeitem" aria-label={node.name}>
        <span className="dep-tree__guide" aria-hidden="true">
          {prefix}
          {connector}
        </span>
        <NodeLabel node={node} missing={missing} onNodeClick={onNodeClick} />
      </div>
      {node.children.map((child, idx) => {
        const childIsLast = idx === node.children.length - 1
        const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ')
        return (
          <Row
            key={`${child.name}-${idx}`}
            node={child}
            prefix={childPrefix}
            isRoot={false}
            isLast={childIsLast}
            onNodeClick={onNodeClick}
          />
        )
      })}
    </>
  )
}

function NodeLabel({
  node,
  missing,
  onNodeClick,
}: {
  node: DependencyTreeNode
  missing: boolean
  onNodeClick?: (name: string) => void
}) {
  const { t } = useTranslation()
  const clickable = !missing && !node.duplicateRef && onNodeClick !== undefined
  const label = (
    <span className="dep-tree__name">{missing ? `<missing> ${node.name}` : node.name}</span>
  )
  return (
    <span className="dep-tree__label">
      {clickable ? (
        <button
          type="button"
          className="dep-tree__link"
          onClick={() => onNodeClick(node.name)}
          aria-label={`Open agent ${node.name}`}
        >
          {label}
        </button>
      ) : (
        label
      )}
      {!missing && (
        <span className="dep-tree__chips">
          <span className="dep-tree__chip">
            {t('dependencyTree.skillCount', { count: node.skillCount })}
          </span>
          <span className="dep-tree__chip">
            {node.readonly ? t('dependencyTree.readonly') : t('dependencyTree.writes')}
          </span>
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
