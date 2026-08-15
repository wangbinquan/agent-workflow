// RFC-249 — compact explicit directory-tree editor. Repos/groups are optional
// attachments on directory nodes; root is an ordinary node, never a "main repo".

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  CachedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
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
  renameNodeSubtree,
  repoNodeNameFromUrl,
  validateRepoGroupNodes,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextInput } from '@/components/Form'
import {
  RepoBulkAddDialog,
  type RepoBulkAddItem,
  type RepoBulkAddMode,
} from '@/components/repos/RepoBulkAddDialog'
import { isRepoGroupPreviewPending } from '@/components/repos/repoGroupPreviewState'
import { RepoTreeEditor, type RepoTreeNodeError } from '@/components/repos/RepoTreeEditor'
import { Select } from '@/components/Select'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'

export interface RepoGroupEditorProps {
  open: boolean
  onClose: () => void
  group?: RepoGroup
  canWrite: boolean
  hasWritePermission: () => boolean
}

interface RepoGroupSaveRequest {
  session: number
  nodes: RepoGroupNodeInput[]
}

function fromGroup(group: RepoGroup | undefined): RepoGroupNodeInput[] {
  if (group === undefined) return [{ path: '', attachment: null }]
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

function draftFingerprint(
  name: string,
  description: string,
  nodes: readonly RepoGroupNodeInput[],
): string {
  return JSON.stringify({ name, description, nodes })
}

function topLevelSelection(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => !paths.some((candidate) => candidate !== path && isUnder(candidate, path)),
  )
}

function previewNodeError(error: unknown): RepoTreeNodeError | null {
  if (!(error instanceof ApiError)) return null
  if (typeof error.details !== 'object' || error.details === null || Array.isArray(error.details)) {
    return null
  }
  const details = error.details as Record<string, unknown>
  const path = [details.nodePath, details.path, details.mountPath].find(
    (value): value is string => typeof value === 'string',
  )
  return path === undefined ? null : { path, message: error.message }
}

export function RepoGroupEditor({
  open,
  onClose,
  group,
  canWrite,
  hasWritePermission,
}: RepoGroupEditorProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [showDescription, setShowDescription] = useState((group?.description ?? '') !== '')
  const [nodes, setNodes] = useState<RepoGroupNodeInput[]>(() => fromGroup(group))
  const [selectedPath, setSelectedPath] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [localError, setLocalError] = useState<string | null>(null)
  const [newDirectory, setNewDirectory] = useState('')
  const [bulkMode, setBulkMode] = useState<RepoBulkAddMode | null>(null)
  const [bulkDraftDirty, setBulkDraftDirty] = useState(false)
  const [batchParent, setBatchParent] = useState('')
  const [batchNotice, setBatchNotice] = useState<string | null>(null)
  const [directoryNameDraft, setDirectoryNameDraft] = useState('')
  const [deleteIntent, setDeleteIntent] = useState<{
    paths: string[]
    nodeCount: number
    attachmentCount: number
  } | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const initialDraftRef = useRef(
    draftFingerprint(group?.name ?? '', group?.description ?? '', fromGroup(group)),
  )
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const editorSessionRef = useRef(0)
  const editorIdentityRef = useRef(`${open}:${canWrite}:${group?.id ?? 'new'}`)
  const resetSaveRef = useRef<() => void>(() => {})
  useEffect(() => {
    const identity = `${open}:${canWrite}:${group?.id ?? 'new'}`
    if (editorIdentityRef.current !== identity) {
      editorIdentityRef.current = identity
      editorSessionRef.current += 1
      resetSaveRef.current()
    }
    if (!open || canWrite) return
    // Permission loss is stronger than the ordinary unsaved-changes flow: no
    // stale editor or nested confirmation may remain actionable.
    dirtyRef.current = null
    busyRef.current = false
    setBulkMode(null)
    setBulkDraftDirty(false)
    setDeleteIntent(null)
    setDiscardOpen(false)
    onClose()
  }, [canWrite, group?.id, onClose, open])

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setDescription(group?.description ?? '')
    setShowDescription((group?.description ?? '') !== '')
    const seededNodes = fromGroup(group)
    setNodes(seededNodes)
    initialDraftRef.current = draftFingerprint(
      group?.name ?? '',
      group?.description ?? '',
      seededNodes,
    )
    dirtyRef.current = null
    busyRef.current = false
    setSelectedPath('')
    setChecked(new Set())
    setLocalError(null)
    setBulkMode(null)
    setBulkDraftDirty(false)
    setBatchNotice(null)
    setDeleteIntent(null)
    setDiscardOpen(false)
  }, [open, group])

  useEffect(() => {
    setDirectoryNameDraft(nodeName(selectedPath))
  }, [selectedPath])

  const repos = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
    enabled: open && canWrite,
  })
  const groups = useQuery<{ items: RepoGroup[] }>({
    queryKey: ['repo-groups'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
    enabled: open && canWrite,
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
  const debouncedWireKey = useMemo(() => JSON.stringify(debouncedNodes), [debouncedNodes])
  const preview = useQuery<RepoGroupLayoutResponse & { pendingImports: number }>({
    // Layout validity depends only on the tree. The group's display name is
    // deliberately not a cache identity component (RFC-223).
    queryKey: ['repo-group-preview-v2', debouncedWireKey],
    queryFn: ({ signal }) =>
      api.post('/api/repo-groups/preview', { nodes: debouncedNodes }, signal),
    enabled: open && canWrite,
    retry: false,
  })
  const previewPending = isRepoGroupPreviewPending(wireKey, debouncedWireKey, preview.isFetching)

  const save = useMutation({
    mutationFn: async ({ nodes: submittedNodes, session }: RepoGroupSaveRequest) => {
      if (session !== editorSessionRef.current) throw new Error('repo editor session ended')
      if (!hasWritePermission()) throw new Error('repo write permission required')
      const body = { name, description, nodes: submittedNodes }
      if (group === undefined) return api.post('/api/repo-groups', body)
      return api.put(`/api/repo-groups/${group.id}`, { ...body, expectedVersion: group.version })
    },
    onSuccess: async (_saved, request) => {
      if (request.session !== editorSessionRef.current || !hasWritePermission()) return
      await qc.invalidateQueries({ queryKey: ['repo-groups'] })
      if (request.session !== editorSessionRef.current || !hasWritePermission()) return
      if (group !== undefined) {
        await qc.invalidateQueries({ queryKey: ['repo-group-layout', group.id] })
      }
      dirtyRef.current = null
      busyRef.current = false
      onClose()
    },
  })
  resetSaveRef.current = save.reset

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

  const addRepos = (items: RepoBulkAddItem[]): boolean =>
    commitNodes(() => {
      const next = nodes.map((node) => ({ ...node }))
      const occupied = next.map((node) => node.path)
      for (const item of items) {
        const preferredPath = joinNodePath(selectedPath, repoNodeNameFromUrl(item.source))
        const emptyTarget = next.find(
          (node) =>
            node.path.toLowerCase() === preferredPath.toLowerCase() && node.attachment === null,
        )
        if (emptyTarget !== undefined) {
          emptyTarget.attachment = item.attachment
          continue
        }
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
    const attachmentCount = nodes.filter(
      (node) => checked.has(node.path) && node.attachment !== null,
    ).length
    const skippedDirectories = checked.size - attachmentCount
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
    if (committed !== null) {
      setChecked(new Set())
      setBatchNotice(
        kind === 'move'
          ? t('repoGroups.editor.batchMoved', { count: selectedPaths.length })
          : t('repoGroups.editor.batchApplied', {
              count: attachmentCount,
              skipped: skippedDirectories,
            }),
      )
    }
  }

  const hasUnappliedDraft =
    newDirectory !== '' || directoryNameDraft !== nodeName(selectedPath) || bulkDraftDirty
  const canSave =
    canWrite &&
    name.trim().length > 0 &&
    (preview.data?.totalRepos ?? 0) > 0 &&
    !preview.isError &&
    !previewPending &&
    !hasUnappliedDraft &&
    !save.isPending
  const selectableAttachmentPaths = nodes
    .filter((node) => node.path !== '' && node.attachment !== null)
    .map((node) => node.path)
  const materialDirty =
    draftFingerprint(name, description, nodes) !== initialDraftRef.current || hasUnappliedDraft
  dirtyRef.current = open && canWrite && materialDirty ? `repo-group:${group?.id ?? 'new'}` : null
  busyRef.current = open && canWrite && save.isPending

  const discardAndClose = (): boolean => {
    if (busyRef.current) return false
    dirtyRef.current = null
    setBulkMode(null)
    setBulkDraftDirty(false)
    setDeleteIntent(null)
    setDiscardOpen(false)
    onClose()
    return true
  }

  const requestClose = (): void => {
    if (busyRef.current) return
    if (dirtyRef.current !== null) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }

  return (
    <>
      <Dialog
        open={open && canWrite}
        onClose={requestClose}
        title={
          group === undefined
            ? t('repoGroups.editor.createTitle')
            : t('repoGroups.editor.editTitle')
        }
        size="lg"
        dismissDisabled={save.isPending}
        data-testid="repo-group-editor-dialog"
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={save.isPending}
              onClick={requestClose}
              data-testid="repo-group-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canSave}
              onClick={() => save.mutate({ session: editorSessionRef.current, nodes })}
              data-testid="repo-group-save"
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
        {localError !== null && <ErrorBanner error={new Error(localError)} />}

        <fieldset className="repo-group-editor__fields" disabled={save.isPending || !canWrite}>
          <div
            className={`repo-group-editor__meta${showDescription ? '' : ' repo-group-editor__meta--compact'}`}
          >
            <Field label={t('repoGroups.editor.name')} required>
              <TextInput value={name} onChange={setName} data-testid="repo-group-name" />
            </Field>
            {showDescription ? (
              <Field label={t('repoGroups.editor.description')}>
                <TextInput
                  value={description}
                  onChange={setDescription}
                  data-testid="repo-group-desc"
                />
              </Field>
            ) : (
              <button
                type="button"
                className="btn btn--sm repo-group-editor__add-description"
                onClick={() => setShowDescription(true)}
                data-testid="repo-group-add-description"
              >
                {t('repoGroups.editor.addDescription')}
              </button>
            )}
          </div>

          {checked.size === 0 ? (
            <div className="repo-group-editor__toolbar" role="toolbar">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setBulkMode('repos')}
                data-testid="repo-group-bulk-repos"
              >
                {t('repoGroups.editor.bulkAddRepos')}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setBulkMode('urls')}
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
                  data-testid="repo-group-new-directory"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addDirectory()
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={addDirectory}
                  data-testid="repo-group-add-directory"
                >
                  {t('repoGroups.editor.addDirectory')}
                </button>
              </div>
              <span className="repo-group-editor__target data-table__muted">
                {t('repoGroups.editor.addTo', {
                  path: selectedPath === '' ? t('repoGroups.layout.rootMount') : selectedPath,
                })}
              </span>
            </div>
          ) : (
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
            {previewPending ? (
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
            {batchNotice !== null && (
              <span className="repo-group-editor__batch-notice">{batchNotice}</span>
            )}
            {hasUnappliedDraft && (
              <span className="repo-group-editor__draft-notice">
                {t('repoGroups.editor.finishDraftBeforeSave')}
              </span>
            )}
          </div>

          <div className="repo-group-editor__workspace">
            <RepoTreeEditor
              nodes={nodes}
              selectedPath={selectedPath}
              checked={checked}
              repoById={repoById}
              groupById={groupById}
              previewNodes={preview.data?.nodes}
              previewRepos={preview.data?.repos}
              nodeError={previewNodeError(preview.error)}
              disabled={save.isPending || !canWrite}
              onSelect={setSelectedPath}
              onCheck={(path, value) =>
                setChecked((current) => {
                  const next = new Set(current)
                  if (value) next.add(path)
                  else next.delete(path)
                  return next
                })
              }
              onMove={(path, parent) => {
                const nextRoot = joinNodePath(parent, nodeName(path))
                if (commitNodes(() => moveNodeSubtree(nodes, path, parent)) === null) return
                if (selectedPath === path) setSelectedPath(nextRoot)
                else if (isUnder(path, selectedPath)) {
                  setSelectedPath(`${nextRoot}${selectedPath.slice(path.length)}`)
                }
              }}
              renderSettings={() => (
                <>
                  <div className="repo-tree-editor__settings-head">
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
                          data-testid="repo-group-directory-name"
                          onBlur={commitDirectoryRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              event.currentTarget.blur()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              event.stopPropagation()
                              setDirectoryNameDraft(nodeName(selectedPath))
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
                              commitNodes(() => moveNodeSubtree(nodes, selectedPath, parent)) !==
                              null
                            ) {
                              setSelectedPath(nextPath)
                            }
                          }}
                          ariaLabel={t('repoGroups.editor.parentDirectory')}
                          data-testid="repo-group-parent-directory"
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
                              attachAtNode(nodes, selectedPath, {
                                ...selectedAttachment,
                                childGroupId,
                              }),
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
                </>
              )}
            />
          </div>
        </fieldset>
      </Dialog>
      <RepoBulkAddDialog
        open={canWrite && bulkMode !== null}
        initialMode={bulkMode ?? 'repos'}
        repos={repos.data?.items ?? []}
        targetLabel={selectedPath === '' ? t('repoGroups.layout.rootMount') : selectedPath}
        onClose={() => {
          setBulkMode(null)
          setBulkDraftDirty(false)
        }}
        onAdd={addRepos}
        onDraftDirtyChange={(dirty) => {
          setBulkDraftDirty(dirty)
          if (dirty && open && canWrite) {
            dirtyRef.current = `repo-group:${group?.id ?? 'new'}`
          }
        }}
      />
      <ConfirmDialog
        open={canWrite && deleteIntent !== null}
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
      <ConfirmDialog
        open={canWrite && discardOpen}
        title={t('splitPage.unsavedTitle')}
        description={t('splitPage.unsavedBody')}
        cancelLabel={t('splitPage.unsavedStay')}
        confirmLabel={t('splitPage.unsavedDiscard')}
        tone="danger"
        onClose={() => setDiscardOpen(false)}
        onConfirm={() => {
          discardAndClose()
        }}
      />
      <UnsavedChangesGuard dirtyRef={dirtyRef} busyRef={busyRef} onDiscard={discardAndClose} />
    </>
  )
}
