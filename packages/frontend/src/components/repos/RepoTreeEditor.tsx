// RFC-249 — reusable editable projection for an explicit repository directory tree.
//
// This component owns tree semantics, keyboard navigation, drag/drop and the
// selected node's inline settings slot. Network/state mutations stay with the
// caller so every edit still goes through the shared path algebra.

import {
  useEffect,
  useMemo,
  useRef,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  CachedRepo,
  PlannedDirectoryNode,
  PlannedRepo,
  RepoGroup,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import { compareRepoNodePath, nodeName, parentNodePath } from '@agent-workflow/shared'
import { Checkbox } from '@/components/Form'
import { FOLDER_ICON, REPO_ICON, WORKGROUP_ICON } from '@/components/icons/resourceIcons'
import { StatusChip } from '@/components/StatusChip'

export interface RepoTreeNodeError {
  path: string
  message: string
}

export interface RepoTreeEditorProps {
  nodes: readonly RepoGroupNodeInput[]
  selectedPath: string
  checked: ReadonlySet<string>
  repoById: ReadonlyMap<string, CachedRepo>
  groupById: ReadonlyMap<string, RepoGroup>
  previewNodes?: readonly PlannedDirectoryNode[]
  previewRepos?: readonly PlannedRepo[]
  nodeError?: RepoTreeNodeError | null
  disabled?: boolean
  onSelect: (path: string) => void
  onCheck: (path: string, checked: boolean) => void
  onMove: (path: string, parent: string) => void
  renderSettings: (node: RepoGroupNodeInput) => ReactNode
}

type LocalEntry = { kind: 'local'; path: string; node: RepoGroupNodeInput }
type GhostEntry = {
  kind: 'ghost'
  path: string
  node: PlannedDirectoryNode
  repo: PlannedRepo | null
}
type TreeEntry = LocalEntry | GhostEntry

function errorMatches(path: string, error: RepoTreeNodeError | null | undefined): boolean {
  return error !== null && error !== undefined && error.path.toLowerCase() === path.toLowerCase()
}

function childGroupProvenance(node: PlannedDirectoryNode): string[] {
  const names = new Set<string>()
  for (const origin of node.origins) {
    // The first item is the unsaved/current group. Everything after it came
    // through a child-group attachment and is therefore a read-only ghost.
    for (const group of origin.viaGroups.slice(1)) names.add(group.name)
  }
  return [...names]
}

export function RepoTreeEditor({
  nodes,
  selectedPath,
  checked,
  repoById,
  groupById,
  previewNodes = [],
  previewRepos = [],
  nodeError,
  disabled = false,
  onSelect,
  onCheck,
  onMove,
  renderSettings,
}: RepoTreeEditorProps) {
  const { t } = useTranslation()
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const previousSelectionRef = useRef(selectedPath)

  const entries = useMemo(() => {
    const localByFoldedPath = new Map(nodes.map((node) => [node.path.toLowerCase(), node]))
    const repoByFoldedPath = new Map(
      previewRepos.map((repo) => [repo.mountPath.toLowerCase(), repo]),
    )
    const combined: TreeEntry[] = nodes.map((node) => ({ kind: 'local', path: node.path, node }))

    for (const node of previewNodes) {
      if (localByFoldedPath.has(node.path.toLowerCase())) continue
      if (childGroupProvenance(node).length === 0) continue
      combined.push({
        kind: 'ghost',
        path: node.path,
        node,
        repo: repoByFoldedPath.get(node.path.toLowerCase()) ?? null,
      })
    }
    return combined.sort((left, right) => compareRepoNodePath(left.path, right.path))
  }, [nodes, previewNodes, previewRepos])

  const byParent = useMemo(() => {
    const result = new Map<string | null, TreeEntry[]>()
    for (const entry of entries) {
      const parent = parentNodePath(entry.path)
      const children = result.get(parent) ?? []
      children.push(entry)
      result.set(parent, children)
    }
    for (const children of result.values()) {
      children.sort((left, right) => compareRepoNodePath(left.path, right.path))
    }
    return result
  }, [entries])

  const localPaths = useMemo(
    () =>
      entries
        .filter((entry): entry is LocalEntry => entry.kind === 'local')
        .map((entry) => entry.path),
    [entries],
  )

  useEffect(() => {
    const previous = previousSelectionRef.current
    previousSelectionRef.current = selectedPath
    if (previous === selectedPath) return
    queueMicrotask(() => buttonRefs.current.get(selectedPath)?.focus())
  }, [selectedPath, nodes])

  const moveKeyboardFocus = (path: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = localPaths.indexOf(path)
    let target: string | undefined
    switch (event.key) {
      case 'ArrowDown':
        target = localPaths[Math.min(localPaths.length - 1, index + 1)]
        break
      case 'ArrowUp':
        target = localPaths[Math.max(0, index - 1)]
        break
      case 'Home':
        target = localPaths[0]
        break
      case 'End':
        target = localPaths.at(-1)
        break
      case 'ArrowLeft': {
        const parent = parentNodePath(path)
        target = parent !== null && localPaths.includes(parent) ? parent : undefined
        break
      }
      case 'ArrowRight':
        target = localPaths.find((candidate) => parentNodePath(candidate) === path)
        break
      default:
        return
    }
    if (target === undefined || target === path) return
    event.preventDefault()
    onSelect(target)
    buttonRefs.current.get(target)?.focus()
  }

  const rows = (parent: string | null, depth: number): ReactNode =>
    (byParent.get(parent) ?? []).map((entry) => {
      const children = byParent.get(entry.path) ?? []
      const hasChildren = children.length > 0
      const paddingInlineStart = `${Math.min(depth, 5) * 12 + 6}px`

      if (entry.kind === 'ghost') {
        const provenance = childGroupProvenance(entry.node)
        const label =
          entry.repo?.repoUrlRedacted ??
          t('repoGroups.editor.inheritedFrom', { group: provenance.join(' › ') })
        return (
          <div
            key={`ghost:${entry.path}`}
            role="treeitem"
            aria-level={depth + 1}
            aria-disabled="true"
            aria-expanded={hasChildren ? true : undefined}
            className="repo-tree-editor__item repo-tree-editor__item--ghost"
            data-testid={`repo-group-ghost-${entry.path}`}
          >
            <div className="repo-tree-editor__row" style={{ paddingInlineStart }}>
              <span className="repo-tree-editor__ghost-spacer" aria-hidden="true" />
              <span className="repo-tree-editor__icon" aria-hidden="true">
                {entry.repo === null ? FOLDER_ICON : REPO_ICON}
              </span>
              <div className="repo-tree-editor__select repo-tree-editor__select--static">
                <code title={entry.path}>{nodeName(entry.path)}</code>
                <span className="repo-tree-editor__attachment" title={label}>
                  {label}
                </span>
              </div>
              <StatusChip kind="info" size="sm">
                {t('repoGroups.editor.inherited')}
              </StatusChip>
            </div>
            {hasChildren && <div role="group">{rows(entry.path, depth + 1)}</div>}
          </div>
        )
      }

      const node = entry.node
      const attachment = node.attachment
      const repo =
        attachment?.kind === 'repo' && attachment.cachedRepoId !== undefined
          ? repoById.get(attachment.cachedRepoId)
          : undefined
      const group =
        attachment?.kind === 'group' ? groupById.get(attachment.childGroupId) : undefined
      const attachedLabel =
        attachment === null
          ? t('repoGroups.editor.emptyDirectory')
          : attachment.kind === 'group'
            ? (group?.name ?? attachment.childGroupId)
            : (repo?.urlRedacted ?? attachment.repoUrl ?? t('repoGroups.editor.pendingRepo'))
      const hasError = errorMatches(node.path, nodeError)

      return (
        <div
          key={node.path}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selectedPath === node.path}
          aria-expanded={hasChildren ? true : undefined}
          aria-invalid={hasError || undefined}
          className="repo-tree-editor__item"
        >
          <div
            className={`repo-tree-editor__row${selectedPath === node.path ? ' repo-tree-editor__row--selected' : ''}${hasError ? ' repo-tree-editor__row--error' : ''}`}
            style={{ paddingInlineStart }}
            draggable={!disabled && node.path !== ''}
            onDragStart={(event: DragEvent<HTMLDivElement>) => {
              if (disabled) {
                event.preventDefault()
                return
              }
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.path)
            }}
            onDragOver={(event) => {
              if (disabled) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => {
              if (disabled) return
              event.preventDefault()
              const source = event.dataTransfer.getData('text/plain')
              if (source !== '') onMove(source, node.path)
            }}
            data-testid={`repo-group-node-${node.path === '' ? '.' : node.path}`}
          >
            <Checkbox
              checked={checked.has(node.path)}
              onChange={(value) => onCheck(node.path, value)}
              disabled={disabled || node.path === ''}
              aria-label={t('repoGroups.editor.selectNode', {
                path: node.path === '' ? t('repoGroups.layout.rootMount') : node.path,
              })}
            />
            <span className="repo-tree-editor__icon" aria-hidden="true">
              {attachment === null
                ? FOLDER_ICON
                : attachment.kind === 'group'
                  ? WORKGROUP_ICON
                  : REPO_ICON}
            </span>
            <button
              ref={(element) => {
                if (element === null) buttonRefs.current.delete(node.path)
                else buttonRefs.current.set(node.path, element)
              }}
              type="button"
              className="repo-tree-editor__select"
              disabled={disabled}
              onClick={() => onSelect(node.path)}
              onKeyDown={(event) => moveKeyboardFocus(node.path, event)}
              aria-pressed={selectedPath === node.path}
              data-testid={`repo-group-node-select-${node.path === '' ? '.' : node.path}`}
            >
              <code title={node.path === '' ? t('repoGroups.layout.rootMount') : node.path}>
                {node.path === '' ? t('repoGroups.layout.rootMount') : nodeName(node.path)}
              </code>
              <span className="repo-tree-editor__attachment" title={attachedLabel}>
                {attachedLabel}
              </span>
              {attachment?.kind === 'repo' && attachment.ref !== '' && (
                <span className="repo-tree-editor__meta-chip">@{attachment.ref}</span>
              )}
              {attachment?.kind === 'repo' && attachment.subdir !== '' && (
                <span className="repo-tree-editor__meta-chip">{attachment.subdir}</span>
              )}
            </button>
            {hasError ? (
              <StatusChip kind="danger" size="sm" title={nodeError?.message}>
                {t('common.error')}
              </StatusChip>
            ) : (
              attachment?.readonly === true && (
                <StatusChip kind="neutral" size="sm">
                  {t('repoGroups.layout.readonlyChip')}
                </StatusChip>
              )
            )}
          </div>
          {selectedPath === node.path && (
            <section
              className="repo-tree-editor__inline-settings"
              aria-label={t('repoGroups.editor.settingsFor', {
                path: node.path === '' ? t('repoGroups.layout.rootMount') : node.path,
              })}
              data-testid={`repo-group-node-settings-${node.path === '' ? '.' : node.path}`}
            >
              {renderSettings(node)}
            </section>
          )}
          {hasChildren && <div role="group">{rows(node.path, depth + 1)}</div>}
        </div>
      )
    })

  return (
    <div
      className="repo-tree-editor"
      role="tree"
      aria-multiselectable="true"
      aria-disabled={disabled || undefined}
      data-testid="repo-group-nodes"
    >
      {rows(null, 0)}
    </div>
  )
}
