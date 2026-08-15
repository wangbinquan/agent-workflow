// RFC-249 — bulk repository attachment dialog for the high-frequency flat layout.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, RepoGroupNodeAttachmentInput } from '@agent-workflow/shared'
import { parseGitUrl } from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Checkbox, TextArea, TextInput } from '@/components/Form'
import { TabBar, tabDomIds } from '@/components/TabBar'

export type RepoBulkAddMode = 'repos' | 'urls'

export interface RepoBulkAddItem {
  source: string
  attachment: RepoGroupNodeAttachmentInput
}

export interface RepoBulkAddDialogProps {
  open: boolean
  initialMode: RepoBulkAddMode
  repos: readonly CachedRepo[]
  targetLabel: string
  onClose: () => void
  onAdd: (items: RepoBulkAddItem[]) => boolean
  onDraftDirtyChange?: (dirty: boolean) => void
}

export function RepoBulkAddDialog({
  open,
  initialMode,
  repos,
  targetLabel,
  onClose,
  onAdd,
  onDraftDirtyChange,
}: RepoBulkAddDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<RepoBulkAddMode>(initialMode)
  const [search, setSearch] = useState('')
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set())
  const [pastedUrls, setPastedUrls] = useState('')
  const [discardOpen, setDiscardOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    setSearch('')
    setSelectedRepoIds(new Set())
    setPastedUrls('')
    setDiscardOpen(false)
  }, [initialMode, open])

  const draftDirty = selectedRepoIds.size > 0 || pastedUrls !== ''
  useEffect(() => {
    onDraftDirtyChange?.(open && draftDirty)
  }, [draftDirty, onDraftDirtyChange, open])

  // The parent owns the router-level guard through a synchronously-readable
  // ref. Publish from the input event as well as the effect so an immediate
  // browser Back cannot overtake React's passive-effect flush in WebKit.
  const updateSelectedRepoIds = (next: Set<string>): void => {
    setSelectedRepoIds(next)
    onDraftDirtyChange?.(open && (next.size > 0 || pastedUrls !== ''))
  }
  const updatePastedUrls = (next: string): void => {
    setPastedUrls(next)
    onDraftDirtyChange?.(open && (selectedRepoIds.size > 0 || next !== ''))
  }

  const filteredRepos = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return [...repos]
    return repos.filter((repo) => repo.urlRedacted.toLowerCase().includes(needle))
  }, [repos, search])

  const pastedEntries = useMemo(
    () =>
      pastedUrls
        .split(/\r?\n/)
        .map((url, index) => ({ url: url.trim(), line: index + 1 }))
        .filter((entry) => entry.url !== ''),
    [pastedUrls],
  )
  const invalidLines = pastedEntries
    .filter((entry) => parseGitUrl(entry.url) === null)
    .map((entry) => entry.line)
  const uniqueUrls = [...new Set(pastedEntries.map((entry) => entry.url))]
  const duplicateCount = pastedEntries.length - uniqueUrls.length
  const panelIds = tabDomIds('repo-group-bulk-add', mode)

  const submit = (): void => {
    const added =
      mode === 'repos'
        ? onAdd(
            repos
              .filter((repo) => selectedRepoIds.has(repo.id))
              .map((repo) => ({
                source: repo.urlRedacted,
                attachment: {
                  kind: 'repo' as const,
                  cachedRepoId: repo.id,
                  ref: '',
                  subdir: '',
                  readonly: false,
                },
              })),
          )
        : onAdd(
            uniqueUrls.map((url) => ({
              source: url,
              attachment: {
                kind: 'repo' as const,
                repoUrl: url,
                ref: '',
                subdir: '',
                readonly: false,
              },
            })),
          )
    if (added) {
      onDraftDirtyChange?.(false)
      onClose()
    }
  }

  const requestClose = (): void => {
    if (draftDirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }

  const discardAndClose = (): void => {
    setSelectedRepoIds(new Set())
    setPastedUrls('')
    setDiscardOpen(false)
    onDraftDirtyChange?.(false)
    onClose()
  }

  const canSubmit =
    mode === 'repos' ? selectedRepoIds.size > 0 : uniqueUrls.length > 0 && invalidLines.length === 0

  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        title={t('repoGroups.editor.bulkDialogTitle')}
        size="md"
        data-testid="repo-group-bulk-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={requestClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canSubmit}
              onClick={submit}
              data-testid="repo-group-bulk-submit"
            >
              {mode === 'repos'
                ? t('repoGroups.editor.addSelected', { count: selectedRepoIds.size })
                : t('repoGroups.editor.addUrls')}
            </button>
          </>
        }
      >
        <p className="repo-bulk-add__target">
          {t('repoGroups.editor.addTo', { path: targetLabel })}
        </p>
        <TabBar
          tabs={[
            { key: 'repos', label: t('repoGroups.editor.cachedReposTab') },
            { key: 'urls', label: t('repoGroups.editor.urlsTab') },
          ]}
          active={mode}
          onSelect={setMode}
          variant="inline"
          ariaLabel={t('repoGroups.editor.bulkMode')}
          idPrefix="repo-group-bulk-add"
          rootTestid="repo-group-bulk-tabs"
        />

        <section
          role="tabpanel"
          id={panelIds.panelId}
          aria-labelledby={panelIds.tabId}
          className="repo-bulk-add__panel"
        >
          {mode === 'repos' ? (
            <>
              <TextInput
                value={search}
                onChange={setSearch}
                type="search"
                placeholder={t('repoGroups.editor.searchRepos')}
                aria-label={t('repoGroups.editor.searchRepos')}
                data-testid="repo-group-bulk-search"
              />
              <div className="repo-bulk-add__actions" role="toolbar">
                <button
                  type="button"
                  className="btn btn--xs"
                  data-testid="repo-group-bulk-select-visible"
                  disabled={filteredRepos.length === 0}
                  onClick={() => {
                    const next = new Set(selectedRepoIds)
                    for (const repo of filteredRepos) next.add(repo.id)
                    updateSelectedRepoIds(next)
                  }}
                >
                  {t('repoGroups.editor.selectVisibleRepos', { count: filteredRepos.length })}
                </button>
                <button
                  type="button"
                  className="btn btn--xs"
                  data-testid="repo-group-bulk-clear"
                  disabled={selectedRepoIds.size === 0}
                  onClick={() => updateSelectedRepoIds(new Set())}
                >
                  {t('repoGroups.editor.clearSelection')}
                </button>
              </div>
              <div className="repo-bulk-add__list" data-testid="repo-group-bulk-repo-list">
                {filteredRepos.map((repo) => (
                  <Checkbox
                    key={repo.id}
                    checked={selectedRepoIds.has(repo.id)}
                    onChange={(checked) => {
                      const next = new Set(selectedRepoIds)
                      if (checked) next.add(repo.id)
                      else next.delete(repo.id)
                      updateSelectedRepoIds(next)
                    }}
                    label={repo.urlRedacted}
                    hint={repo.defaultBranch ?? undefined}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <TextArea
                value={pastedUrls}
                onChange={updatePastedUrls}
                placeholder={t('repoGroups.editor.pasteUrlsPlaceholder')}
                data-testid="repo-group-bulk-urls"
              />
              {invalidLines.length > 0 && (
                <p className="form-field__error" role="alert" data-testid="repo-group-paste-errors">
                  {t('repoGroups.editor.invalidUrlLines', { lines: invalidLines.join(', ') })}
                </p>
              )}
              {duplicateCount > 0 && (
                <p className="form-field__hint" role="status">
                  {t('repoGroups.editor.duplicateUrlsIgnored', { count: duplicateCount })}
                </p>
              )}
            </>
          )}
        </section>
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        title={t('splitPage.unsavedTitle')}
        description={t('splitPage.unsavedBody')}
        cancelLabel={t('splitPage.unsavedStay')}
        confirmLabel={t('splitPage.unsavedDiscard')}
        tone="danger"
        onClose={() => setDiscardOpen(false)}
        onConfirm={discardAndClose}
      />
    </>
  )
}
