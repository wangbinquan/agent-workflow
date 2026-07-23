// RFC-201 T3.2 — controlled Skill file editor adapter.
//
// This component owns selection and read queries only.  Create/update/delete
// are staged into route-owned edit scopes; it never sends a persistence request.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileNode } from '@agent-workflow/shared'
import { isProtectedSkillMainFile } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { EditScopeState } from '@/lib/edit-scope'
import type { SkillFileDraft } from '@/lib/skill-composite-draft'
import { EmptyState } from './EmptyState'
import { ErrorBanner } from './ErrorBanner'
import { TextArea, TextInput } from './Form'
import { LoadingState } from './LoadingState'
import { NoticeBanner } from './NoticeBanner'

export interface SkillFileTreeProps {
  skillId: string
  readonly?: boolean
  readonlyPaths?: readonly string[]
  selected: string | null
  onSelectedChange: (path: string | null) => void
  newPath: string
  onNewPathChange: (path: string) => void
  fileScopes: Readonly<Record<string, EditScopeState<SkillFileDraft>>>
  onFileLoaded: (path: string, content: string, issuedEpoch: number) => void
  onFileChange: (path: string, content: string) => void
  onStageCreate: (path: string) => void
  onStageDelete: (path: string) => void
  onUndo: (path: string) => void
  busy?: boolean
}

export function SkillFileTree({
  skillId,
  readonly = false,
  readonlyPaths = [],
  selected,
  onSelectedChange,
  newPath,
  onNewPathChange,
  fileScopes,
  onFileLoaded,
  onFileChange,
  onStageCreate,
  onStageDelete,
  onUndo,
  busy = false,
}: SkillFileTreeProps) {
  const { t } = useTranslation()
  const treeKey = ['skill-files', skillId]
  const [newError, setNewError] = useState<string | null>(null)
  const readEpochRef = useRef(0)
  const onFileLoadedRef = useRef(onFileLoaded)

  useEffect(() => {
    onFileLoadedRef.current = onFileLoaded
  }, [onFileLoaded])

  const tree = useQuery<FileNode[]>({
    queryKey: treeKey,
    queryFn: ({ signal }) =>
      api.get(`/api/skills/${encodeURIComponent(skillId)}/files`, undefined, signal),
  })

  const selectedScope = selected === null ? undefined : fileScopes[selected]
  const shouldReadSelected =
    selected !== null && (selectedScope === undefined || selectedScope.baseline.exists)
  const file = useQuery<{ content: string }>({
    queryKey:
      selected === null ? ['skill-file', skillId, '__none__'] : ['skill-file', skillId, selected],
    enabled: shouldReadSelected,
    queryFn: ({ signal }) =>
      api.get(`/api/skills/${encodeURIComponent(skillId)}/file`, { path: selected ?? '' }, signal),
  })

  useEffect(() => {
    if (selected === null || file.data === undefined || file.dataUpdatedAt === 0) return
    readEpochRef.current += 1
    onFileLoadedRef.current(selected, file.data.content, readEpochRef.current)
  }, [file.data, file.dataUpdatedAt, selected])

  const rows = useMemo(() => {
    const byPath = new Map((tree.data ?? []).map((node) => [node.path, node]))
    for (const [path, scope] of Object.entries(fileScopes)) {
      if (scope.draft.exists && !byPath.has(path)) byPath.set(path, { path, type: 'file' })
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  }, [fileScopes, tree.data])

  const isPathReadonly = (path: string | null): boolean =>
    path !== null && (readonlyPaths.includes(path) || isProtectedSkillMainFile(path))

  function validateNewPath(raw: string): string | null {
    const path = raw.trim()
    if (path === '') return t('skills.fileErrPathRequired')
    if (path.startsWith('/') || path.includes('..')) return t('skills.fileErrRelativeOnly')
    if (isProtectedSkillMainFile(path)) return t('skills.fileErrMainFileProtected')
    if (rows.some((row) => row.path === path) || fileScopes[path]?.draft.exists === true) {
      return t('skills.fileErrAlreadyExists')
    }
    return null
  }

  function handleAdd() {
    const path = newPath.trim()
    const error = validateNewPath(path)
    if (error !== null) {
      setNewError(error)
      return
    }
    setNewError(null)
    onStageCreate(path)
    onSelectedChange(path)
  }

  const pendingLabel = (scope: EditScopeState<SkillFileDraft> | undefined): string | null => {
    if (scope === undefined || !scope.dirty) return null
    if (!scope.baseline.exists && scope.draft.exists) return t('skills.filePendingCreate')
    if (scope.baseline.exists && !scope.draft.exists) return t('skills.filePendingDelete')
    return t('skills.filePendingUpdate')
  }

  return (
    <div className="file-tree" tabIndex={-1}>
      <div className="file-tree__sidebar">
        <div className="file-tree__header">{t('skills.fileTreeHeader')}</div>
        {tree.isLoading && <LoadingState size="compact" />}
        {tree.error !== null && tree.error !== undefined && (
          <ErrorBanner error={tree.error} onRetry={() => void tree.refetch()} />
        )}
        {tree.data !== undefined && rows.length === 0 && (
          <EmptyState title={t('skills.fileTreeEmpty')} size="compact" />
        )}
        <ul className="file-tree__list">
          {rows.map((fileNode) => {
            const scope = fileScopes[fileNode.path]
            const status = pendingLabel(scope)
            return (
              <li key={fileNode.path}>
                <button
                  type="button"
                  className={`file-tree__item ${selected === fileNode.path ? 'file-tree__item--active' : ''}`}
                  onClick={() => onSelectedChange(fileNode.path)}
                  disabled={fileNode.type === 'dir'}
                >
                  <span className="file-tree__icon">{fileNode.type === 'dir' ? '▸' : '·'}</span>
                  <span className="file-tree__path">{fileNode.path}</span>
                  {status !== null && <span className="chip chip--tight">{status}</span>}
                </button>
              </li>
            )
          })}
        </ul>
        {!readonly && (
          <div className="file-tree__add">
            <TextInput
              value={newPath}
              onChange={(value) => {
                onNewPathChange(value)
                setNewError(null)
              }}
              placeholder={t('skills.fileNewPathPlaceholder')}
              data-testid="skill-new-path"
              disabled={busy}
            />
            <button type="button" className="btn btn--sm" onClick={handleAdd} disabled={busy}>
              {t('skills.fileStageAddButton')}
            </button>
            {newError !== null && <div className="file-tree__err">{newError}</div>}
          </div>
        )}
      </div>

      <div className="file-tree__editor">
        {selected === null ? (
          <EmptyState title={t('skills.fileEditorEmpty')} size="compact" />
        ) : selectedScope === undefined && file.isLoading ? (
          <LoadingState label={t('skills.fileLoadingNamed', { name: selected })} size="compact" />
        ) : file.error !== null && file.error !== undefined && selectedScope === undefined ? (
          <ErrorBanner error={file.error} onRetry={() => void file.refetch()} />
        ) : selectedScope === undefined ? (
          <LoadingState label={t('skills.fileLoadingNamed', { name: selected })} size="compact" />
        ) : !selectedScope.draft.exists ? (
          <EmptyState
            title={t('skills.fileDeleteStagedTitle', { path: selected })}
            description={t('skills.fileDeleteStagedDescription')}
            size="compact"
            action={
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => onUndo(selected)}
                disabled={busy || selectedScope.inFlight !== undefined}
              >
                {t('skills.fileUndoPending')}
              </button>
            }
          />
        ) : (
          <>
            <div className="file-tree__path-bar">
              <code>{selected}</code>
              <div className="file-tree__actions">
                {pendingLabel(selectedScope) !== null && (
                  <span className="chip chip--tight">{pendingLabel(selectedScope)}</span>
                )}
                {selectedScope.dirty && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const cancelsCreate = !selectedScope.baseline.exists
                      onUndo(selected)
                      if (cancelsCreate) onSelectedChange(null)
                    }}
                    disabled={
                      busy ||
                      selectedScope.inFlight !== undefined ||
                      selectedScope.ambiguousSubmit !== undefined
                    }
                  >
                    {t('skills.fileUndoPending')}
                  </button>
                )}
                {!readonly && !isPathReadonly(selected) && selectedScope.baseline.exists && (
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => onStageDelete(selected)}
                    disabled={busy || selectedScope.inFlight !== undefined}
                  >
                    {t('skills.fileStageDeleteButton')}
                  </button>
                )}
              </div>
            </div>
            {selectedScope.staleRemote !== undefined && (
              <NoticeBanner tone="warning" size="compact">
                {t('skills.fileStaleWarning')}
              </NoticeBanner>
            )}
            <TextArea
              value={selectedScope.draft.content}
              onChange={(value) => onFileChange(selected, value)}
              rows={20}
              monospace
              disabled={busy || readonly || isPathReadonly(selected)}
            />
          </>
        )}
      </div>
    </div>
  )
}
