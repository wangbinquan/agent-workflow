// File tree + inline editor for a managed skill.
//
// M1 list view is flat (the response is a flat array of paths); paths
// containing '/' display with their parent prefix so users can still see
// directory structure. Real tree view lands in M5 polish.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileNode, SkillContent } from '@agent-workflow/shared'
import { isProtectedSkillMainFile } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from './ConfirmButton'
import { ConfirmDialog } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { ErrorBanner } from './ErrorBanner'
import { TextArea, TextInput } from './Form'
import { LoadingState } from './LoadingState'

interface Props {
  skillName: string
  readonly?: boolean
  /** RFC-169: paths shown read-only (no save/delete) — the SKILL.md main file
   *  is edited through the Content tab, not the file tree. Any path matching
   *  isProtectedSkillMainFile is treated as read-only regardless. */
  readonlyPaths?: string[]
}

export function SkillFileTree({ skillName, readonly = false, readonlyPaths = [] }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const treeKey = ['skill-files', skillName]
  // RFC-170 F3 (G2-7): the skill's detail content query is the SINGLE canonical
  // holder of the composite precondition token. File writes echo it (OCC) and
  // atomically advance it from the response, so a save landing between a file
  // edit and its write is not silently clobbered; a 409 refetches a fresh token.
  const contentKey = ['skills', skillName, 'content']
  const currentToken = (): string | undefined => qc.getQueryData<SkillContent>(contentKey)?.token
  const advanceToken = (token: string | null | undefined): void => {
    if (token == null) return
    qc.setQueryData<SkillContent>(contentKey, (prev) =>
      prev === undefined ? prev : { ...prev, token },
    )
  }
  const [selected, setSelected] = useState<string | null>(null)
  const [newPath, setNewPath] = useState('')
  const [newError, setNewError] = useState<string | null>(null)

  const tree = useQuery<FileNode[]>({
    queryKey: treeKey,
    queryFn: ({ signal }) =>
      api.get(`/api/skills/${encodeURIComponent(skillName)}/files`, undefined, signal),
  })

  const fileKey = (path: string) => ['skill-file', skillName, path]
  const file = useQuery<{ content: string }>({
    queryKey: selected === null ? ['skill-file', skillName, '__none__'] : fileKey(selected),
    enabled: selected !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/skills/${encodeURIComponent(skillName)}/file`,
        { path: selected ?? '' },
        signal,
      ),
  })

  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null)
  const pendingTargetRef = useRef<HTMLElement | null>(null)
  const treeRootRef = useRef<HTMLDivElement | null>(null)

  const isPathReadonly = (path: string | null): boolean =>
    path !== null && (readonlyPaths.includes(path) || isProtectedSkillMainFile(path))

  // Sync draft from server only when the file changes or initial load lands.
  if (
    file.data !== undefined &&
    !dirty &&
    selected !== null &&
    file.data.content !== draft &&
    file.dataUpdatedAt !== 0
  ) {
    setDraft(file.data.content)
  }

  const save = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.put<{ ok: boolean; path: string; token?: string }>(
        `/api/skills/${encodeURIComponent(skillName)}/file?path=${encodeURIComponent(path)}`,
        { content, expectedToken: currentToken() },
      ),
    onSuccess: (res, vars) => {
      advanceToken(res.token)
      void qc.invalidateQueries({ queryKey: treeKey })
      void qc.invalidateQueries({ queryKey: fileKey(vars.path) })
      setDirty(false)
    },
    onError: () => {
      // A 409 (stale token) refetches the canonical token so a retry is fresh.
      void qc.invalidateQueries({ queryKey: contentKey })
    },
  })

  const del = useMutation({
    mutationFn: (path: string) => {
      const tok = currentToken()
      const q = tok !== undefined ? `&expectedToken=${encodeURIComponent(tok)}` : ''
      return api.delete<{ token?: string }>(
        `/api/skills/${encodeURIComponent(skillName)}/file?path=${encodeURIComponent(path)}${q}`,
      )
    },
    onSuccess: (res) => {
      advanceToken(res.token)
      void qc.invalidateQueries({ queryKey: treeKey })
      setSelected(null)
      setDraft('')
      setDirty(false)
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: contentKey })
    },
  })

  function selectPath(path: string) {
    setSelected(path)
    setDraft('')
    setDirty(false)
  }

  function handleSelect(path: string, trigger: HTMLButtonElement) {
    if (path === selected || pendingTargetPath !== null) return
    if (dirty) {
      pendingTargetRef.current = trigger
      setPendingTargetPath(path)
      return
    }
    selectPath(path)
  }

  function confirmPendingSelection() {
    const target = pendingTargetPath
    if (target === null) return
    const currentTarget = qc
      .getQueryData<FileNode[]>(treeKey)
      ?.find((entry) => entry.path === target)
    if (currentTarget === undefined || currentTarget.type === 'dir') {
      throw new Error(t('skills.fileTargetUnavailable'))
    }
    selectPath(target)
  }

  function handleAdd() {
    const p = newPath.trim()
    if (p === '') {
      setNewError(t('skills.fileErrPathRequired'))
      return
    }
    if (p.startsWith('/') || p.includes('..')) {
      setNewError(t('skills.fileErrRelativeOnly'))
      return
    }
    // RFC-169: never create/overwrite the main SKILL.md via the file tree —
    // it's edited through the Content tab (the backend also fail-closes).
    if (isProtectedSkillMainFile(p)) {
      setNewError(t('skills.fileErrMainFileProtected'))
      return
    }
    setNewError(null)
    save.mutate(
      { path: p, content: '' },
      {
        onSuccess: () => {
          setNewPath('')
          setSelected(p)
          setDraft('')
          setDirty(false)
        },
      },
    )
  }

  return (
    <div ref={treeRootRef} className="file-tree" tabIndex={-1}>
      <div className="file-tree__sidebar">
        <div className="file-tree__header">{t('skills.fileTreeHeader')}</div>
        {tree.isLoading && <LoadingState size="compact" />}
        {tree.error !== null && tree.error !== undefined && (
          <ErrorBanner
            error={tree.error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void tree.refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        )}
        {tree.data !== undefined && tree.data.length === 0 && (
          <EmptyState title={t('skills.fileTreeEmpty')} size="compact" />
        )}
        <ul className="file-tree__list">
          {(tree.data ?? []).map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={`file-tree__item ${selected === f.path ? 'file-tree__item--active' : ''}`}
                onClick={(event) => handleSelect(f.path, event.currentTarget)}
                disabled={f.type === 'dir'}
              >
                <span className="file-tree__icon">{f.type === 'dir' ? '▸' : '·'}</span>
                <span className="file-tree__path">{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
        {!readonly && (
          <div className="file-tree__add">
            <TextInput
              value={newPath}
              onChange={(v) => {
                setNewPath(v)
                setNewError(null)
              }}
              placeholder={t('skills.fileNewPathPlaceholder')}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleAdd}
              disabled={save.isPending}
            >
              {t('skills.fileAddButton')}
            </button>
            {newError !== null && <div className="file-tree__err">{newError}</div>}
          </div>
        )}
      </div>

      <div className="file-tree__editor">
        {selected === null ? (
          <EmptyState title={t('skills.fileEditorEmpty')} size="compact" />
        ) : file.isLoading ? (
          <LoadingState label={t('skills.fileLoadingNamed', { name: selected })} size="compact" />
        ) : file.error !== null && file.error !== undefined ? (
          <ErrorBanner
            error={file.error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void file.refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        ) : (
          <>
            <div className="file-tree__path-bar">
              <code>{selected}</code>
              <div className="file-tree__actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={!dirty || save.isPending || readonly || isPathReadonly(selected)}
                  onClick={() => save.mutate({ path: selected, content: draft })}
                >
                  {save.isPending ? t('common.saving') : t('common.save')}
                </button>
                {!readonly && !isPathReadonly(selected) && (
                  <ConfirmButton
                    label={t('skills.fileDeleteButton')}
                    onConfirm={() => del.mutateAsync(selected)}
                    variant="danger"
                    disabled={del.isPending}
                  />
                )}
              </div>
            </div>
            <TextArea
              value={draft}
              onChange={(v) => {
                setDraft(v)
                setDirty(true)
              }}
              rows={20}
              monospace
            />
            {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
            {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingTargetPath !== null}
        title={t('splitPage.unsavedTitle')}
        description={t('skills.fileDiscardConfirm')}
        confirmLabel={t('splitPage.unsavedDiscard')}
        tone="danger"
        onConfirm={confirmPendingSelection}
        onClose={() => setPendingTargetPath(null)}
        triggerRef={pendingTargetRef}
        restoreFocusFallbackRef={treeRootRef}
      />
    </div>
  )
}
