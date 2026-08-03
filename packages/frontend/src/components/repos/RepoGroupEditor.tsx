// RFC-249 — compact explicit directory-tree editor. Repos/groups are optional
// attachments on directory nodes; root is an ordinary node, never a "main repo".

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  CachedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupNodeAttachmentInput,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import {
  allocateRepoNodePath,
  attachAtNode,
  compareRepoNodePath,
  deleteNodeSubtree,
  detachAtNode,
  isUnder,
  joinNodePath,
  mountDepth,
  moveNodeSubtree,
  nodeName,
  parentNodePath,
  parseGitUrl,
  renameNodeSubtree,
  validateRepoGroupNodes,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Checkbox, Field, Switch, TextArea, TextInput } from '@/components/Form'
import { FOLDER_ICON, REPO_ICON, WORKGROUP_ICON } from '@/components/icons/resourceIcons'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'

export interface RepoGroupEditorProps {
  open: boolean
  onClose: () => void
  group?: RepoGroup
}

function fromGroup(group: RepoGroup | undefined): RepoGroupNodeInput[] {
  if (group === undefined) return [{ path: '', attachment: null }]
  if (group.nodes !== undefined) {
    return group.nodes.map((node) => ({
      path: node.path,
      attachment:
        node.attachment === null
          ? null
          : node.attachment.kind === 'repo'
            ? {
                kind: 'repo',
                cachedRepoId: node.attachment.cachedRepoId,
                ref: node.attachment.ref,
                subdir: node.attachment.subdir,
                readonly: node.attachment.readonly,
              }
            : {
                kind: 'group',
                childGroupId: node.attachment.childGroupId,
                readonly: node.attachment.readonly,
              },
    }))
  }

  // Rolling-upgrade fallback only. The current API always returns nodes.
  const byPath = new Map<string, RepoGroupNodeInput>()
  const ensure = (path: string): RepoGroupNodeInput => {
    const key = path.toLowerCase()
    const existing = byPath.get(key)
    if (existing !== undefined) return existing
    const parent = parentNodePath(path)
    if (parent !== null) ensure(parent)
    const created = { path, attachment: null }
    byPath.set(key, created)
    return created
  }
  ensure('')
  for (const member of group.members) {
    const node = ensure(member.mountPath)
    node.attachment =
      member.kind === 'repo'
        ? {
            kind: 'repo',
            cachedRepoId: member.cachedRepoId,
            ref: member.ref,
            subdir: member.subdir,
            readonly: member.readonly,
          }
        : {
            kind: 'group',
            childGroupId: member.childGroupId,
            readonly: member.readonly,
          }
  }
  return [...byPath.values()]
}

function topLevelSelection(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => !paths.some((candidate) => candidate !== path && isUnder(candidate, path)),
  )
}

function DraftTree({
  nodes,
  selectedPath,
  checked,
  repoById,
  groupById,
  onSelect,
  onCheck,
  onMove,
}: {
  nodes: readonly RepoGroupNodeInput[]
  selectedPath: string
  checked: ReadonlySet<string>
  repoById: ReadonlyMap<string, CachedRepo>
  groupById: ReadonlyMap<string, RepoGroup>
  onSelect: (path: string) => void
  onCheck: (path: string, checked: boolean) => void
  onMove: (path: string, parent: string) => void
}) {
  const { t } = useTranslation()
  const byParent = new Map<string | null, RepoGroupNodeInput[]>()
  for (const node of nodes) {
    const parent = parentNodePath(node.path)
    const children = byParent.get(parent) ?? []
    children.push(node)
    byParent.set(parent, children)
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => compareRepoNodePath(a.path, b.path))
  }

  const rows = (parent: string | null, depth: number): ReactNode =>
    (byParent.get(parent) ?? []).map((node) => {
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
      const childRows = rows(node.path, depth + 1)
      const hasChildren = (byParent.get(node.path)?.length ?? 0) > 0
      return (
        <div
          key={node.path}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selectedPath === node.path}
          aria-expanded={hasChildren ? true : undefined}
        >
          <div
            className={`repo-tree-editor__row${selectedPath === node.path ? ' repo-tree-editor__row--selected' : ''}`}
            style={{ paddingInlineStart: `${Math.min(depth, 5) * 14 + 6}px` }}
            draggable={node.path !== ''}
            onDragStart={(event: DragEvent<HTMLDivElement>) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.path)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => {
              event.preventDefault()
              const source = event.dataTransfer.getData('text/plain')
              if (source !== '') onMove(source, node.path)
            }}
            data-testid={`repo-group-node-${node.path === '' ? '.' : node.path}`}
          >
            <Checkbox
              checked={checked.has(node.path)}
              onChange={(value) => onCheck(node.path, value)}
              disabled={node.path === ''}
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
              type="button"
              className="repo-tree-editor__select"
              onClick={() => onSelect(node.path)}
              aria-pressed={selectedPath === node.path}
            >
              <code title={node.path === '' ? t('repoGroups.layout.rootMount') : node.path}>
                {node.path === '' ? t('repoGroups.layout.rootMount') : nodeName(node.path)}
              </code>
              <span className="repo-tree-editor__attachment" title={attachedLabel}>
                {attachedLabel}
              </span>
            </button>
            {attachment?.readonly === true && (
              <StatusChip kind="neutral" size="sm">
                {t('repoGroups.layout.readonlyChip')}
              </StatusChip>
            )}
          </div>
          {hasChildren && <div role="group">{childRows}</div>}
        </div>
      )
    })

  return (
    <div className="repo-tree-editor" role="tree" data-testid="repo-group-nodes">
      {rows(null, 0)}
    </div>
  )
}

export function RepoGroupEditor({ open, onClose, group }: RepoGroupEditorProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [nodes, setNodes] = useState<RepoGroupNodeInput[]>(() => fromGroup(group))
  const [selectedPath, setSelectedPath] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [localError, setLocalError] = useState<string | null>(null)
  const [newDirectory, setNewDirectory] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSearch, setBulkSearch] = useState('')
  const [bulkRepoIds, setBulkRepoIds] = useState<Set<string>>(new Set())
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pastedUrls, setPastedUrls] = useState('')
  const [batchParent, setBatchParent] = useState('')
  const [directoryNameDraft, setDirectoryNameDraft] = useState('')
  const [deleteIntent, setDeleteIntent] = useState<{
    paths: string[]
    nodeCount: number
    attachmentCount: number
  } | null>(null)

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setDescription(group?.description ?? '')
    setNodes(fromGroup(group))
    setSelectedPath('')
    setChecked(new Set())
    setLocalError(null)
    setBulkOpen(false)
    setPasteOpen(false)
    setDeleteIntent(null)
  }, [open, group])

  useEffect(() => {
    setDirectoryNameDraft(nodeName(selectedPath))
  }, [selectedPath])

  const repos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: open,
  })
  const groups = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: open,
  })
  const repoById = useMemo(
    () => new Map((repos.data?.items ?? []).map((repo) => [repo.id, repo])),
    [repos.data?.items],
  )
  const groupById = useMemo(
    () => new Map((groups.data?.items ?? []).map((item) => [item.id, item])),
    [groups.data?.items],
  )

  const commitNodes = (producer: () => RepoGroupNodeInput[]): RepoGroupNodeInput[] | null => {
    try {
      const next = validateRepoGroupNodes(producer()) as RepoGroupNodeInput[]
      setNodes(next)
      const live = new Set(next.map((node) => node.path))
      if (!live.has(selectedPath)) setSelectedPath('')
      setChecked((current) => new Set([...current].filter((path) => live.has(path))))
      setLocalError(null)
      return next
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const wireKey = useMemo(() => JSON.stringify(nodes), [nodes])
  const [debouncedNodes, setDebouncedNodes] = useState(nodes)
  useEffect(() => {
    const id = setTimeout(() => setDebouncedNodes(nodes), 350)
    return () => clearTimeout(id)
  }, [wireKey, nodes])
  const preview = useQuery<RepoGroupLayoutResponse & { pendingImports: number }>({
    // Layout validity depends only on the tree. The group's display name is
    // deliberately not a cache identity component (RFC-223).
    queryKey: ['repo-group-preview-v2', JSON.stringify(debouncedNodes)],
    queryFn: ({ signal }) =>
      api.post('/api/repo-groups/preview', { nodes: debouncedNodes }, signal),
    enabled: open,
    retry: false,
  })

  const save = useMutation({
    mutationFn: async () => {
      const body = { name, description, nodes }
      if (group === undefined) return api.post('/api/repo-groups', body)
      return api.put(`/api/repo-groups/${group.id}`, { ...body, expectedVersion: group.version })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['repo-groups'] })
      if (group !== undefined) {
        await qc.invalidateQueries({ queryKey: ['repo-group-layout', group.id] })
      }
      onClose()
    },
  })

  const selected = nodes.find((node) => node.path === selectedPath) ?? nodes[0]!
  const selectedAttachment = selected.attachment
  const directoryOptions = nodes
    .slice()
    .sort((a, b) => compareRepoNodePath(a.path, b.path))
    .map((node) => ({
      value: node.path,
      label: node.path === '' ? t('repoGroups.layout.rootMount') : node.path,
    }))
  const eligibleParents = directoryOptions.filter(
    (option) =>
      option.value !== selectedPath &&
      !isUnder(selectedPath, option.value) &&
      (selectedPath === '' || option.value !== parentNodePath(selectedPath)),
  )
  const checkedRoots = topLevelSelection([...checked])
  const batchParentOptions = directoryOptions.filter(
    (option) =>
      !checkedRoots.some(
        (checkedPath) => option.value === checkedPath || isUnder(checkedPath, option.value),
      ),
  )

  const commitDirectoryRename = (): void => {
    if (selectedPath === '') return
    const value = directoryNameDraft.trim()
    if (value === '') {
      setDirectoryNameDraft(nodeName(selectedPath))
      return
    }
    if (value === nodeName(selectedPath)) return
    const nextPath = joinNodePath(parentNodePath(selectedPath) ?? '', value)
    if (commitNodes(() => renameNodeSubtree(nodes, selectedPath, value)) !== null) {
      setSelectedPath(nextPath)
    }
  }

  const addDirectory = (): void => {
    const value = newDirectory.trim()
    if (value === '') return
    if (
      commitNodes(() => [
        ...nodes,
        { path: joinNodePath(selectedPath, value), attachment: null },
      ]) !== null
    ) {
      setNewDirectory('')
    }
  }

  const addRepos = (
    items: Array<{ source: string; attachment: RepoGroupNodeAttachmentInput }>,
  ): boolean =>
    commitNodes(() => {
      const next = [...nodes]
      const occupied = next.map((node) => node.path)
      for (const item of items) {
        const path = allocateRepoNodePath(selectedPath, item.source, occupied)
        occupied.push(path)
        next.push({ path, attachment: item.attachment })
      }
      return next
    }) !== null

  const requestDelete = (paths: readonly string[]): void => {
    const roots = topLevelSelection(paths).filter((path) => path !== '')
    if (roots.length === 0) return
    const affected = nodes.filter((node) =>
      roots.some((root) => node.path === root || isUnder(root, node.path)),
    )
    setDeleteIntent({
      paths: roots,
      nodeCount: affected.length,
      attachmentCount: affected.filter((node) => node.attachment !== null).length,
    })
  }

  const deleteSubtrees = (paths: readonly string[]): void => {
    const roots = [...paths].sort((a, b) => mountDepth(b) - mountDepth(a))
    const committed = commitNodes(() => {
      let next = [...nodes]
      for (const path of roots) next = deleteNodeSubtree(next, path)
      return next
    })
    if (committed !== null) setChecked(new Set())
  }

  const applyBatch = (kind: 'readonly' | 'writable' | 'detach' | 'move') => {
    const selectedPaths = topLevelSelection([...checked])
    const committed = commitNodes(() => {
      if (kind === 'readonly' || kind === 'writable' || kind === 'detach') {
        return nodes.map((node) => {
          if (!checked.has(node.path) || node.attachment === null) return node
          if (kind === 'detach') return { ...node, attachment: null }
          return {
            ...node,
            attachment: { ...node.attachment, readonly: kind === 'readonly' },
          }
        })
      }
      let next = [...nodes]
      for (const path of selectedPaths) next = moveNodeSubtree(next, path, batchParent)
      return next
    })
    if (committed !== null) setChecked(new Set())
  }

  const canSave =
    name.trim().length > 0 &&
    (preview.data?.totalRepos ?? 0) > 0 &&
    !preview.isError &&
    !preview.isFetching &&
    !save.isPending
  const filteredRepos = (repos.data?.items ?? []).filter((repo) =>
    repo.urlRedacted.toLowerCase().includes(bulkSearch.trim().toLowerCase()),
  )
  const selectableAttachmentPaths = nodes
    .filter((node) => node.path !== '' && node.attachment !== null)
    .map((node) => node.path)
  const pastedUrlEntries = pastedUrls
    .split(/\r?\n/)
    .map((url, index) => ({ url: url.trim(), line: index + 1 }))
    .filter((entry) => entry.url !== '')
  const invalidPastedLines = pastedUrlEntries
    .filter((entry) => parseGitUrl(entry.url) === null)
    .map((entry) => entry.line)
  const uniquePastedUrls = [...new Set(pastedUrlEntries.map((entry) => entry.url))]

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={
          group === undefined
            ? t('repoGroups.editor.createTitle')
            : t('repoGroups.editor.editTitle')
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn" onClick={onClose} data-testid="repo-group-cancel">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canSave}
              onClick={() => save.mutate()}
              data-testid="repo-group-save"
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
        {localError !== null && <ErrorBanner error={new Error(localError)} />}

        <div className="repo-group-editor__meta">
          <Field label={t('repoGroups.editor.name')} required>
            <TextInput value={name} onChange={setName} data-testid="repo-group-name" />
          </Field>
          <Field label={t('repoGroups.editor.description')}>
            <TextInput
              value={description}
              onChange={setDescription}
              data-testid="repo-group-desc"
            />
          </Field>
        </div>

        <div className="repo-group-editor__toolbar" role="toolbar">
          <button
            type="button"
            className={`btn btn--sm${bulkOpen ? ' btn--selected' : ''}`}
            onClick={() => setBulkOpen((value) => !value)}
            data-testid="repo-group-bulk-repos"
          >
            {t('repoGroups.editor.bulkAddRepos')}
          </button>
          <button
            type="button"
            className={`btn btn--sm${pasteOpen ? ' btn--selected' : ''}`}
            onClick={() => setPasteOpen((value) => !value)}
            data-testid="repo-group-paste-urls"
          >
            {t('repoGroups.editor.pasteUrls')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={selectableAttachmentPaths.length === 0}
            onClick={() => setChecked(new Set(selectableAttachmentPaths))}
            data-testid="repo-group-select-all-attachments"
          >
            {t('repoGroups.editor.selectAllAttachments')}
          </button>
          <div className="repo-group-editor__new-directory">
            <TextInput
              value={newDirectory}
              onChange={setNewDirectory}
              placeholder={t('repoGroups.editor.newDirectoryPlaceholder')}
              aria-label={t('repoGroups.editor.newDirectoryPlaceholder')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addDirectory()
                }
              }}
            />
            <button type="button" className="btn btn--sm" onClick={addDirectory}>
              {t('repoGroups.editor.addDirectory')}
            </button>
          </div>
          <span className="repo-group-editor__target data-table__muted">
            {t('repoGroups.editor.addTo', {
              path: selectedPath === '' ? t('repoGroups.layout.rootMount') : selectedPath,
            })}
          </span>
        </div>

        {bulkOpen && (
          <section className="repo-group-editor__bulk" data-testid="repo-group-bulk-panel">
            <TextInput
              value={bulkSearch}
              onChange={setBulkSearch}
              type="search"
              placeholder={t('repoGroups.editor.searchRepos')}
              aria-label={t('repoGroups.editor.searchRepos')}
            />
            <div className="repo-group-editor__bulk-actions" role="toolbar">
              <button
                type="button"
                className="btn btn--xs"
                disabled={filteredRepos.length === 0}
                onClick={() =>
                  setBulkRepoIds((current) => {
                    const next = new Set(current)
                    for (const repo of filteredRepos) next.add(repo.id)
                    return next
                  })
                }
              >
                {t('repoGroups.editor.selectVisibleRepos', { count: filteredRepos.length })}
              </button>
              <button
                type="button"
                className="btn btn--xs"
                disabled={bulkRepoIds.size === 0}
                onClick={() => setBulkRepoIds(new Set())}
              >
                {t('repoGroups.editor.clearSelection')}
              </button>
            </div>
            <div className="repo-group-editor__bulk-list">
              {filteredRepos.map((repo) => (
                <Checkbox
                  key={repo.id}
                  checked={bulkRepoIds.has(repo.id)}
                  onChange={(value) =>
                    setBulkRepoIds((current) => {
                      const next = new Set(current)
                      if (value) next.add(repo.id)
                      else next.delete(repo.id)
                      return next
                    })
                  }
                  label={repo.urlRedacted}
                  hint={repo.defaultBranch ?? undefined}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={bulkRepoIds.size === 0}
              onClick={() => {
                const selectedRepos = (repos.data?.items ?? []).filter((repo) =>
                  bulkRepoIds.has(repo.id),
                )
                const added = addRepos(
                  selectedRepos.map((repo) => ({
                    source: repo.urlRedacted,
                    attachment: {
                      kind: 'repo',
                      cachedRepoId: repo.id,
                      ref: '',
                      subdir: '',
                      readonly: false,
                    },
                  })),
                )
                if (added) {
                  setBulkRepoIds(new Set())
                  setBulkOpen(false)
                }
              }}
            >
              {t('repoGroups.editor.addSelected', { count: bulkRepoIds.size })}
            </button>
          </section>
        )}

        {pasteOpen && (
          <section className="repo-group-editor__paste" data-testid="repo-group-paste-panel">
            <TextArea
              value={pastedUrls}
              onChange={setPastedUrls}
              placeholder={t('repoGroups.editor.pasteUrlsPlaceholder')}
            />
            {invalidPastedLines.length > 0 && (
              <p
                className="form-field__error repo-group-editor__paste-error"
                role="alert"
                data-testid="repo-group-paste-errors"
              >
                {t('repoGroups.editor.invalidUrlLines', {
                  lines: invalidPastedLines.join(', '),
                })}
              </p>
            )}
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={uniquePastedUrls.length === 0 || invalidPastedLines.length > 0}
              onClick={() => {
                const added = addRepos(
                  uniquePastedUrls.map((url) => ({
                    source: url,
                    attachment: {
                      kind: 'repo',
                      repoUrl: url,
                      ref: '',
                      subdir: '',
                      readonly: false,
                    },
                  })),
                )
                if (added) {
                  setPastedUrls('')
                  setPasteOpen(false)
                }
              }}
            >
              {t('repoGroups.editor.addUrls')}
            </button>
          </section>
        )}

        {checked.size > 0 && (
          <div className="repo-group-editor__batch" data-testid="repo-group-batch-bar">
            <strong>{t('repoGroups.editor.selectedCount', { count: checked.size })}</strong>
            <button type="button" className="btn btn--xs" onClick={() => applyBatch('readonly')}>
              {t('repoGroups.editor.markReadonly')}
            </button>
            <button type="button" className="btn btn--xs" onClick={() => applyBatch('writable')}>
              {t('repoGroups.editor.markWritable')}
            </button>
            <button type="button" className="btn btn--xs" onClick={() => applyBatch('detach')}>
              {t('repoGroups.editor.detach')}
            </button>
            <button type="button" className="btn btn--xs" onClick={() => setChecked(new Set())}>
              {t('repoGroups.editor.clearSelection')}
            </button>
            <Select
              value={batchParent}
              onChange={setBatchParent}
              ariaLabel={t('repoGroups.editor.moveTo')}
              options={batchParentOptions}
            />
            <button type="button" className="btn btn--xs" onClick={() => applyBatch('move')}>
              {t('repoGroups.editor.move')}
            </button>
            <button
              type="button"
              className="btn btn--xs btn--danger"
              onClick={() => requestDelete([...checked])}
            >
              {t('common.delete')}
            </button>
          </div>
        )}

        <div className="repo-group-editor__status" aria-live="polite">
          {preview.isFetching ? (
            <span className="data-table__muted">{t('repoGroups.editor.validating')}</span>
          ) : preview.error !== null && preview.error !== undefined ? (
            <ErrorBanner error={preview.error} />
          ) : (
            <span className="data-table__muted">
              {t('repoGroups.editor.layoutSummary', {
                nodes: preview.data?.totalNodes ?? nodes.length,
                repos: preview.data?.totalRepos ?? 0,
              })}
              {(preview.data?.pendingImports ?? 0) > 0 &&
                ` · ${t('repoGroups.editor.pendingImports', { count: preview.data?.pendingImports ?? 0 })}`}
            </span>
          )}
        </div>

        <div className="repo-group-editor__workspace">
          <section className="repo-group-editor__tree-pane">
            <DraftTree
              nodes={nodes}
              selectedPath={selectedPath}
              checked={checked}
              repoById={repoById}
              groupById={groupById}
              onSelect={setSelectedPath}
              onCheck={(path, value) =>
                setChecked((current) => {
                  const next = new Set(current)
                  if (value) next.add(path)
                  else next.delete(path)
                  return next
                })
              }
              onMove={(path, parent) => commitNodes(() => moveNodeSubtree(nodes, path, parent))}
            />
          </section>

          <aside
            className="repo-group-editor__inspector"
            aria-label={t('repoGroups.editor.nodeSettings')}
          >
            <div className="repo-group-editor__inspector-head">
              <strong>
                {selectedPath === '' ? t('repoGroups.layout.rootMount') : selectedPath}
              </strong>
              {selectedPath !== '' && (
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  onClick={() => requestDelete([selectedPath])}
                >
                  {t('repoGroups.editor.deleteSubtree')}
                </button>
              )}
            </div>

            {selectedPath !== '' && (
              <>
                <Field label={t('repoGroups.editor.directoryName')}>
                  <TextInput
                    value={directoryNameDraft}
                    onChange={setDirectoryNameDraft}
                    onBlur={commitDirectoryRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      } else if (event.key === 'Escape') {
                        setDirectoryNameDraft(nodeName(selectedPath))
                        event.currentTarget.blur()
                      }
                    }}
                  />
                </Field>
                <Field label={t('repoGroups.editor.parentDirectory')}>
                  <Select
                    value={parentNodePath(selectedPath) ?? ''}
                    onChange={(parent) => {
                      const nextPath = joinNodePath(parent, nodeName(selectedPath))
                      if (
                        commitNodes(() => moveNodeSubtree(nodes, selectedPath, parent)) !== null
                      ) {
                        setSelectedPath(nextPath)
                      }
                    }}
                    ariaLabel={t('repoGroups.editor.parentDirectory')}
                    options={eligibleParents}
                  />
                </Field>
              </>
            )}

            {selectedAttachment === null ? (
              <>
                <Field label={t('repoGroups.editor.attachRepo')}>
                  <Select
                    value=""
                    onChange={(repoId) => {
                      if (repoId === '') return
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, {
                          kind: 'repo',
                          cachedRepoId: repoId,
                          ref: '',
                          subdir: '',
                          readonly: false,
                        }),
                      )
                    }}
                    ariaLabel={t('repoGroups.editor.attachRepo')}
                    placeholder={t('repoGroups.editor.pickRepo')}
                    options={[
                      { value: '', label: t('repoGroups.editor.pickRepo') },
                      ...(repos.data?.items ?? []).map((repo) => ({
                        value: repo.id,
                        label: repo.urlRedacted,
                      })),
                    ]}
                  />
                </Field>
                <Field label={t('repoGroups.editor.attachGroup')}>
                  <Select
                    value=""
                    onChange={(groupId) => {
                      if (groupId === '') return
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, {
                          kind: 'group',
                          childGroupId: groupId,
                          readonly: false,
                        }),
                      )
                    }}
                    ariaLabel={t('repoGroups.editor.attachGroup')}
                    placeholder={t('repoGroups.editor.pickGroup')}
                    options={[
                      { value: '', label: t('repoGroups.editor.pickGroup') },
                      ...(groups.data?.items ?? [])
                        .filter((item) => item.id !== group?.id)
                        .map((item) => ({ value: item.id, label: item.name })),
                    ]}
                  />
                </Field>
              </>
            ) : selectedAttachment.kind === 'repo' ? (
              <>
                <Field label={t('repoGroups.editor.attachedRepo')}>
                  <Select
                    value={selectedAttachment.cachedRepoId ?? ''}
                    onChange={(repoId) => {
                      if (repoId === '') return
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, {
                          ...selectedAttachment,
                          cachedRepoId: repoId,
                          repoUrl: undefined,
                        }),
                      )
                    }}
                    ariaLabel={t('repoGroups.editor.attachedRepo')}
                    options={(repos.data?.items ?? []).map((repo) => ({
                      value: repo.id,
                      label: repo.urlRedacted,
                    }))}
                  />
                </Field>
                <Field label={t('repoGroups.editor.ref')}>
                  <TextInput
                    value={selectedAttachment.ref}
                    onChange={(ref) =>
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, { ...selectedAttachment, ref }),
                      )
                    }
                    placeholder={t('repoGroups.editor.refPlaceholder')}
                  />
                </Field>
                <Field label={t('repoGroups.editor.subdir')}>
                  <TextInput
                    value={selectedAttachment.subdir}
                    onChange={(subdir) =>
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, { ...selectedAttachment, subdir }),
                      )
                    }
                    placeholder={t('repoGroups.editor.subdirPlaceholder')}
                  />
                </Field>
                <Switch
                  checked={selectedAttachment.readonly}
                  onChange={(readonly) =>
                    commitNodes(() =>
                      attachAtNode(nodes, selectedPath, { ...selectedAttachment, readonly }),
                    )
                  }
                  label={t('repoGroups.editor.readonly')}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => commitNodes(() => detachAtNode(nodes, selectedPath))}
                >
                  {t('repoGroups.editor.detach')}
                </button>
              </>
            ) : (
              <>
                <Field label={t('repoGroups.editor.attachedGroup')}>
                  <Select
                    value={selectedAttachment.childGroupId}
                    onChange={(childGroupId) =>
                      commitNodes(() =>
                        attachAtNode(nodes, selectedPath, { ...selectedAttachment, childGroupId }),
                      )
                    }
                    ariaLabel={t('repoGroups.editor.attachedGroup')}
                    options={(groups.data?.items ?? [])
                      .filter((item) => item.id !== group?.id)
                      .map((item) => ({ value: item.id, label: item.name }))}
                  />
                </Field>
                <Switch
                  checked={selectedAttachment.readonly}
                  onChange={(readonly) =>
                    commitNodes(() =>
                      attachAtNode(nodes, selectedPath, { ...selectedAttachment, readonly }),
                    )
                  }
                  label={t('repoGroups.editor.readonly')}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => commitNodes(() => detachAtNode(nodes, selectedPath))}
                >
                  {t('repoGroups.editor.detach')}
                </button>
              </>
            )}
          </aside>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleteIntent !== null}
        title={t('repoGroups.editor.deleteSubtreeTitle')}
        description={t('repoGroups.editor.deleteSubtreeDescription', {
          nodes: deleteIntent?.nodeCount ?? 0,
          attachments: deleteIntent?.attachmentCount ?? 0,
        })}
        confirmLabel={t('repoGroups.editor.deleteSubtreeConfirm')}
        tone="danger"
        onClose={() => setDeleteIntent(null)}
        onConfirm={() => {
          if (deleteIntent !== null) deleteSubtrees(deleteIntent.paths)
        }}
      />
    </>
  )
}
