// RFC-249 — shared read-only projection of the explicit repo-group directory tree.

import { useTranslation } from 'react-i18next'
import {
  compareRepoNodePath,
  mountDepth,
  nodeName,
  parentNodePath,
  type PlannedDirectoryNode,
  type PlannedRepo,
} from '@agent-workflow/shared'
import { FOLDER_ICON, REPO_ICON } from '@/components/icons/resourceIcons'
import { StatusChip } from '@/components/StatusChip'

export interface RepoLayoutTreeProps {
  /** Canonical source. Includes pure directories that cannot be inferred from repos. */
  nodes?: readonly PlannedDirectoryNode[]
  repos: readonly PlannedRepo[]
  testidPrefix?: string
  /** Hide URL and provenance while retaining the full directory hierarchy. */
  compact?: boolean
}

export interface LayoutTreeNode {
  path: string
  node: PlannedDirectoryNode
  repo: PlannedRepo | null
  children: LayoutTreeNode[]
}

/** Compatibility only for old task/layout payloads that predate node snapshots. */
function inferMinimalNodes(repos: readonly PlannedRepo[]): PlannedDirectoryNode[] {
  const paths = new Map<string, string>()
  if (repos.length > 0) paths.set('', '')
  for (const repo of repos) {
    let current = ''
    for (const segment of repo.mountPath.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      if (!paths.has(current.toLowerCase())) paths.set(current.toLowerCase(), current)
    }
  }
  return [...paths.values()]
    .sort((a, b) => mountDepth(a) - mountDepth(b) || compareRepoNodePath(a, b))
    .map((path) => ({ path, origins: [] }))
}

/** Build from explicit nodes; repos only decorate the node at the same path. */
export function buildLayoutTree(
  repos: readonly PlannedRepo[],
  explicitNodes?: readonly PlannedDirectoryNode[],
): LayoutTreeNode[] {
  const inferred = inferMinimalNodes(repos)
  const byPath = new Map<string, PlannedDirectoryNode>()
  for (const node of explicitNodes ?? []) byPath.set(node.path.toLowerCase(), node)
  // Additive fallback for rolling-upgrade/legacy payloads. Explicit pure nodes remain intact.
  for (const node of inferred) {
    if (!byPath.has(node.path.toLowerCase())) byPath.set(node.path.toLowerCase(), node)
  }
  const repoByPath = new Map(repos.map((repo) => [repo.mountPath.toLowerCase(), repo]))
  const ordered = [...byPath.values()].sort(
    (a, b) => mountDepth(a.path) - mountDepth(b.path) || compareRepoNodePath(a.path, b.path),
  )
  const treeByPath = new Map<string, LayoutTreeNode>()
  const roots: LayoutTreeNode[] = []

  for (const node of ordered) {
    const treeNode: LayoutTreeNode = {
      path: node.path,
      node,
      repo: repoByPath.get(node.path.toLowerCase()) ?? null,
      children: [],
    }
    const parent = parentNodePath(node.path)
    const parentNode = parent === null ? undefined : treeByPath.get(parent.toLowerCase())
    if (parentNode === undefined) roots.push(treeNode)
    else parentNode.children.push(treeNode)
    treeByPath.set(node.path.toLowerCase(), treeNode)
  }
  return roots
}

function Row({
  item,
  depth,
  testidPrefix,
  compact,
}: {
  item: LayoutTreeNode
  depth: number
  testidPrefix: string
  compact: boolean
}) {
  const { t } = useTranslation()
  const { path, repo, node } = item
  const label = path === '' ? t('repoGroups.layout.rootMount') : nodeName(path)
  const provenance =
    repo?.viaGroups.map((group) => group.name) ??
    node.origins[0]?.viaGroups.map((group) => group.name) ??
    []

  return (
    <>
      <li
        className={`repo-layout-tree__row${repo === null ? ' repo-layout-tree__row--directory' : ''}`}
        style={{ paddingInlineStart: `${depth * 18}px` }}
        data-testid={`${testidPrefix}-row-${path === '' ? '.' : path}`}
        aria-label={path === '' ? t('repoGroups.layout.rootMount') : path}
      >
        <span className="repo-layout-tree__icon" aria-hidden="true">
          {repo === null ? FOLDER_ICON : REPO_ICON}
        </span>
        <code className="repo-layout-tree__mount">{label}</code>
        {repo !== null && repo.ref !== '' && (
          <span className="repo-layout-tree__ref">
            {'@'} <code>{repo.ref}</code>
          </span>
        )}
        {repo !== null && repo.subdir !== '' && (
          <StatusChip kind="neutral" size="sm">
            {t('repoGroups.layout.subdirChip', { subdir: repo.subdir })}
          </StatusChip>
        )}
        {repo !== null && repo.readonly && (
          <StatusChip kind="neutral" size="sm" data-testid={`${testidPrefix}-readonly`}>
            {t('repoGroups.layout.readonlyChip')}
          </StatusChip>
        )}
        {!compact && repo !== null && (
          <span className="repo-layout-tree__url data-table__muted">{repo.repoUrlRedacted}</span>
        )}
        {!compact && provenance.length > 0 && (
          <span className="repo-layout-tree__via data-table__muted">
            {t('repoGroups.layout.via', { chain: provenance.join(' › ') })}
          </span>
        )}
      </li>
      {item.children.map((child) => (
        <Row
          key={child.path}
          item={child}
          depth={depth + 1}
          testidPrefix={testidPrefix}
          compact={compact}
        />
      ))}
    </>
  )
}

export function RepoLayoutTree({ nodes, repos, testidPrefix, compact }: RepoLayoutTreeProps) {
  const prefix = testidPrefix ?? 'repo-layout-tree'
  const tree = buildLayoutTree(repos, nodes)
  return (
    <ul className="repo-layout-tree" data-testid={prefix}>
      {tree.map((item) => (
        <Row
          key={item.path}
          item={item}
          depth={0}
          testidPrefix={prefix}
          compact={compact === true}
        />
      ))}
    </ul>
  )
}
