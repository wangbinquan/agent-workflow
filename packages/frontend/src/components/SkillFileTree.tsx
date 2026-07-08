// File tree + inline editor for a managed skill.
//
// M1 list view is flat (the response is a flat array of paths); paths
// containing '/' display with their parent prefix so users can still see
// directory structure. Real tree view lands in M5 polish.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileNode } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { ConfirmButton } from './ConfirmButton'
import { TextArea, TextInput } from './Form'
import { LoadingState } from './LoadingState'

interface Props {
  skillName: string
  readonly?: boolean
}

export function SkillFileTree({ skillName, readonly = false }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const treeKey = ['skill-files', skillName]
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
      api.put(
        `/api/skills/${encodeURIComponent(skillName)}/file?path=${encodeURIComponent(path)}`,
        {
          content,
        },
      ),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: treeKey })
      void qc.invalidateQueries({ queryKey: fileKey(vars.path) })
      setDirty(false)
    },
  })

  const del = useMutation({
    mutationFn: (path: string) =>
      api.delete(
        `/api/skills/${encodeURIComponent(skillName)}/file?path=${encodeURIComponent(path)}`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: treeKey })
      setSelected(null)
      setDraft('')
      setDirty(false)
    },
  })

  function handleSelect(path: string) {
    if (dirty && !confirm(t('skills.fileDiscardConfirm'))) return
    setSelected(path)
    setDraft('')
    setDirty(false)
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
    <div className="file-tree">
      <div className="file-tree__sidebar">
        <div className="file-tree__header">{t('skills.fileTreeHeader')}</div>
        {tree.isLoading && <LoadingState size="compact" />}
        {tree.error !== null && tree.error !== undefined && (
          <div className="error-box">{describeApiError(tree.error)}</div>
        )}
        {tree.data !== undefined && tree.data.length === 0 && (
          <div className="muted">{t('skills.fileTreeEmpty')}</div>
        )}
        <ul className="file-tree__list">
          {(tree.data ?? []).map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={`file-tree__item ${selected === f.path ? 'file-tree__item--active' : ''}`}
                onClick={() => handleSelect(f.path)}
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
          <div className="muted">{t('skills.fileEditorEmpty')}</div>
        ) : file.isLoading ? (
          <div className="muted">{t('skills.fileLoadingNamed', { name: selected })}</div>
        ) : (
          <>
            <div className="file-tree__path-bar">
              <code>{selected}</code>
              <div className="file-tree__actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={!dirty || save.isPending || readonly}
                  onClick={() => save.mutate({ path: selected, content: draft })}
                >
                  {save.isPending ? t('common.saving') : t('common.save')}
                </button>
                {!readonly && (
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
            {save.error !== null && save.error !== undefined && (
              <div className="error-box">{describeApiError(save.error)}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
