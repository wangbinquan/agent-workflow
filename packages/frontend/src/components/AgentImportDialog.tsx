// RFC-197 — three-stage agent.md import task flow for /agents/new.
// Parsing and merge semantics remain owned by RFC-018/RFC-194; this component
// owns source selection, complete disclosure, blocking feedback, and the
// stable "applied to draft, not created" result.

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  importRefSelectorKey,
  parseAgentMarkdown,
  type AgentMarkdownParseResult,
  type CreateAgent,
  type ImportRefAmbiguity,
  type ImportRefSelection,
  type ResolveAgentImportRefsRequest,
  type ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { describeApiError } from '@/i18n'
import {
  describeAgentImport,
  agentMarkdownFilenameStem,
  validateAgentMarkdownFile,
  type AgentImportPreviewItem,
  type AgentImportPreview,
} from '@/lib/agent-import-preview'
import { fieldsOverwrittenByImport, importOrphanSidecarConflicts } from '@/lib/agent-import-merge'
import { structureImportWarnings } from '@/lib/agent-import-warnings'
import { Card } from './Card'
import { Dialog } from './Dialog'
import { EmptyState } from './EmptyState'
import { ErrorBanner } from './ErrorBanner'
import { FileDropzone, formatShortBytes } from './FileDropzone'
import { Field, TextArea } from './Form'
import { StatusChip } from './StatusChip'
import { TabBar, tabDomIds } from './TabBar'
import { emptyAgent, type AgentTab } from './AgentForm'
import {
  hasEveryImportRefSelection,
  ImportRefMappingFields,
  importRefAmbiguitiesFromError,
  importRefStaleChoicesFromError,
} from './ImportRefMappingFields'

export interface AgentImportDialogProps {
  open: boolean
  onClose: () => void
  onResolve: (request: ResolveAgentImportRefsRequest) => Promise<ResolveAgentImportRefsResult>
  onApply: (result: AgentMarkdownParseResult, resolved: ResolveAgentImportRefsResult) => void
  currentValue: CreateAgent
  triggerRef?: RefObject<HTMLButtonElement | null>
  onViewForm?: (tab: AgentTab) => void
}

type SourceTab = 'upload' | 'paste'

const SOURCE_TAB_PREFIX = 'agent-import-source'
const SOURCE_TAB_IDS = {
  upload: tabDomIds(SOURCE_TAB_PREFIX, 'upload'),
  paste: tabDomIds(SOURCE_TAB_PREFIX, 'paste'),
} satisfies Record<SourceTab, ReturnType<typeof tabDomIds>>

interface SourceDraft {
  active: SourceTab
  uploadFile: File | null
  pasteText: string
  selectionError: string | null
}

interface SourceSnapshot {
  kind: SourceTab
  label: string
  rawText: string
  filenameStem?: string
  fileSize?: number
}

type ImportPhase =
  | { kind: 'select'; source: SourceDraft; busy: 'read-file' | null }
  | {
      kind: 'review'
      source: SourceSnapshot
      sourceDraft: SourceDraft
      parse: AgentMarkdownParseResult
      preview: AgentImportPreview
      ambiguities: ImportRefAmbiguity[]
      selections: ImportRefSelection[]
      resolving: boolean
      resolveError: string | null
    }
  | {
      kind: 'result'
      sourceLabel: string
      appliedItemCount: number
      affectedSections: Array<{ tab: AgentTab; count: number }>
      firstAffectedTab: AgentTab
    }

const EMPTY_AGENT = emptyAgent()

function freshSelectPhase(): ImportPhase {
  return {
    kind: 'select',
    source: {
      active: 'upload',
      uploadFile: null,
      pasteText: '',
      selectionError: null,
    },
    busy: null,
  }
}

export function AgentImportDialog({
  open,
  onClose,
  onResolve,
  onApply,
  currentValue,
  triggerRef,
  onViewForm,
}: AgentImportDialogProps) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<ImportPhase>(freshSelectPhase)
  const readGenerationRef = useRef(0)
  const openRef = useRef(open)
  const chooseButtonRef = useRef<HTMLButtonElement | null>(null)
  const pasteTextAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const selectBusy = phase.kind === 'select' ? phase.busy : null
  const selectActive = phase.kind === 'select' ? phase.source.active : null

  useEffect(() => {
    openRef.current = open
    if (!open) {
      readGenerationRef.current += 1
      setPhase(freshSelectPhase())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      if (phase.kind === 'review') reviewHeadingRef.current?.focus()
      else if (phase.kind === 'result') resultHeadingRef.current?.focus()
      else if (selectBusy === null) {
        if (selectActive === 'upload') chooseButtonRef.current?.focus()
        else if (selectActive === 'paste') pasteTextAreaRef.current?.focus()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, phase.kind, selectActive, selectBusy])

  const reviewState = useMemo(() => {
    if (phase.kind !== 'review') return null
    const warnings = structureImportWarnings(phase.parse.warnings)
    const blockingWarning = warnings.find((warning) => warning.blocking)
    const nonBlockingWarnings = warnings.filter((warning) => !warning.blocking)
    const orphanConflicts = importOrphanSidecarConflicts(currentValue, phase.parse)
    const willOverwrite = fieldsOverwrittenByImport(currentValue, phase.parse, EMPTY_AGENT)
    return {
      blockingWarning,
      nonBlockingWarnings,
      orphanConflicts,
      willOverwrite,
      canApply:
        phase.preview.itemCount > 0 &&
        blockingWarning === undefined &&
        orphanConflicts.length === 0 &&
        !phase.resolving &&
        hasEveryImportRefSelection(phase.ambiguities, phase.selections),
    }
  }, [currentValue, phase])

  if (!open) return null

  function invalidateRead(): void {
    readGenerationRef.current += 1
  }

  function closeDialog(): void {
    invalidateRead()
    onClose()
  }

  function selectSourceTab(next: SourceTab): void {
    setPhase((current) => {
      if (current.kind !== 'select' || current.busy !== null) return current
      return {
        ...current,
        source: { ...current.source, active: next, selectionError: null },
      }
    })
  }

  function selectFile(file: File | null): void {
    invalidateRead()
    setPhase((current) => {
      if (current.kind !== 'select' || current.busy !== null) return current
      if (file === null) {
        return {
          ...current,
          source: { ...current.source, uploadFile: null, selectionError: null },
        }
      }
      const check = validateAgentMarkdownFile(file)
      if (!check.ok) {
        return {
          ...current,
          source: {
            ...current.source,
            uploadFile: null,
            selectionError: t('agentForm.importDialog.invalidExtension'),
          },
        }
      }
      return {
        ...current,
        source: { ...current.source, uploadFile: file, selectionError: null },
      }
    })
  }

  function updatePasteText(value: string): void {
    setPhase((current) => {
      if (current.kind !== 'select' || current.busy !== null) return current
      return {
        ...current,
        source: { ...current.source, pasteText: value, selectionError: null },
      }
    })
  }

  function enterReview(source: SourceSnapshot, sourceDraft: SourceDraft): void {
    const parse = parseAgentMarkdown(source.rawText, {
      // An empty file has no import payload. Do not let the filename fallback
      // manufacture a name-only change that turns a true no-op into Apply.
      filenameStem:
        source.kind === 'upload' && source.rawText.trim() !== '' ? source.filenameStem : undefined,
    })
    setPhase({
      kind: 'review',
      source,
      sourceDraft,
      parse,
      preview: describeAgentImport(parse),
      ambiguities: [],
      selections: [],
      resolving: false,
      resolveError: null,
    })
  }

  async function checkSource(): Promise<void> {
    if (phase.kind !== 'select' || phase.busy !== null) return
    const sourceDraft = phase.source
    if (sourceDraft.active === 'paste') {
      if (sourceDraft.pasteText.trim() === '') return
      enterReview(
        {
          kind: 'paste',
          label: t('agentForm.importDialog.sourcePaste'),
          rawText: sourceDraft.pasteText,
        },
        sourceDraft,
      )
      return
    }

    const file = sourceDraft.uploadFile
    if (file === null) return
    const generation = ++readGenerationRef.current
    setPhase({
      kind: 'select',
      source: { ...sourceDraft, selectionError: null },
      busy: 'read-file',
    })
    try {
      const rawText = await file.text()
      if (generation !== readGenerationRef.current || !openRef.current) return
      enterReview(
        {
          kind: 'upload',
          label: file.name,
          rawText,
          filenameStem: agentMarkdownFilenameStem(file.name),
          fileSize: file.size,
        },
        sourceDraft,
      )
    } catch (error) {
      if (generation !== readGenerationRef.current || !openRef.current) return
      const detail = error instanceof Error ? error.message : String(error)
      setPhase({
        kind: 'select',
        source: {
          ...sourceDraft,
          selectionError: t('agentForm.importDialog.fileReadFailed', { message: detail }),
        },
        busy: null,
      })
    }
  }

  function backToSource(): void {
    if (phase.kind !== 'review') return
    // Resolving portable references is read-only and cancelable. Advancing the
    // generation makes a late response inert before the review is discarded.
    invalidateRead()
    setPhase({ kind: 'select', source: phase.sourceDraft, busy: null })
  }

  async function applyToDraft(): Promise<void> {
    if (phase.kind !== 'review' || reviewState?.canApply !== true) return
    const snapshot = phase
    const firstAffectedTab = phase.preview.firstTab
    if (firstAffectedTab === null) return
    const generation = ++readGenerationRef.current
    setPhase({ ...snapshot, resolving: true, resolveError: null })
    const resolveWith = (selections: ImportRefSelection[]) =>
      onResolve({
        dependsOn: snapshot.parse.partial.dependsOn,
        mcp: snapshot.parse.partial.mcp,
        plugins: snapshot.parse.partial.plugins,
        skills: snapshot.parse.skillSelectors,
        selections,
      })
    const parkResolutionError = (error: unknown, selections: ImportRefSelection[]) => {
      const ambiguities = importRefAmbiguitiesFromError(error)
      setPhase({
        ...snapshot,
        ambiguities: ambiguities ?? snapshot.ambiguities,
        selections,
        resolving: false,
        resolveError: ambiguities === null ? describeApiError(error) : null,
      })
    }
    try {
      const resolved = await resolveWith(snapshot.selections)
      if (generation !== readGenerationRef.current || !openRef.current) return
      onApply(snapshot.parse, resolved)
      setPhase({
        kind: 'result',
        sourceLabel: reviewSourceLabel(snapshot.source),
        appliedItemCount: snapshot.preview.itemCount,
        affectedSections: snapshot.preview.sections.map((section) => ({
          tab: section.tab,
          count: section.items.length,
        })),
        firstAffectedTab,
      })
    } catch (error) {
      if (generation !== readGenerationRef.current || !openRef.current) return
      const staleChoices = importRefStaleChoicesFromError(error)
      if (staleChoices !== null) {
        const staleKeys = new Set(
          staleChoices.map((choice) => importRefSelectorKey(choice.selector)),
        )
        setPhase({
          ...snapshot,
          ambiguities: staleChoices,
          selections: snapshot.selections.filter(
            (selection) => !staleKeys.has(importRefSelectorKey(selection.selector)),
          ),
          resolving: false,
          resolveError: null,
        })
        return
      }
      parkResolutionError(error, snapshot.selections)
    }
  }

  function viewForm(tab: AgentTab): void {
    onViewForm?.(tab)
    closeDialog()
  }

  function resetImport(): void {
    invalidateRead()
    setPhase(freshSelectPhase())
  }

  function reviewSourceLabel(source: SourceSnapshot): string {
    if (source.kind === 'upload') {
      return t('agentForm.importDialog.sourceUpload', {
        name: source.label,
        size: formatShortBytes(source.fileSize ?? 0),
      })
    }
    return t('agentForm.importDialog.sourcePaste', {
      size: formatShortBytes(new TextEncoder().encode(source.rawText).byteLength),
    })
  }

  function sectionLabel(tab: AgentTab): string {
    const keys: Record<AgentTab, string> = {
      basics: 'agentForm.tabBasics',
      prompt: 'agentForm.tabPrompt',
      ports: 'agentForm.tabPorts',
      resources: 'agentForm.tabResources',
      advanced: 'agentForm.tabAdvanced',
    }
    return t(keys[tab])
  }

  function renderPreviewValue(item: AgentImportPreviewItem): ReactNode {
    switch (item.kind) {
      case 'text':
        return (
          <span className="agent-import__item-text" title={item.value}>
            {item.value === '' ? t('agentForm.importDialog.emptyValue') : item.value}
          </span>
        )
      case 'body':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.bodySummary', {
                bytes: item.bytes,
                lines: item.lines,
              })}
            </span>
            {item.excerpt !== '' && <span className="agent-import__excerpt">{item.excerpt}</span>}
          </>
        )
      case 'inputs':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.inputSummary', { count: item.values.length })}
            </span>
            {renderDetailList(
              item.values.map(
                (port) =>
                  `${port.name} · ${port.kind}${port.description ? ` — ${port.description}` : ''}`,
              ),
            )}
          </>
        )
      case 'list':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.listSummary', { count: item.values.length })}
            </span>
            {renderDetailList(item.values)}
          </>
        )
      case 'map':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.mapSummary', { count: item.entries.length })}
            </span>
            {renderDetailList(item.entries.map(([key, value]) => `${key} → ${value}`))}
          </>
        )
      case 'json':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.ruleSummary', { count: item.entries })}
            </span>
            <pre>{item.value}</pre>
          </>
        )
      case 'extra':
        return (
          <>
            <span className="agent-import__item-meta">
              {t('agentForm.importDialog.extraLabel', { type: item.valueType })}
            </span>
            <pre>{item.value}</pre>
          </>
        )
    }
  }

  function renderDetailList(values: string[]): ReactNode {
    if (values.length === 0) {
      return (
        <span className="agent-import__empty-value">{t('agentForm.importDialog.emptyValue')}</span>
      )
    }
    return (
      <ul className="agent-import__detail-list">
        {values.map((value, index) => (
          <li key={`${value}-${index}`} title={value}>
            {value}
          </li>
        ))}
      </ul>
    )
  }

  const canCheck =
    phase.kind === 'select' &&
    phase.busy === null &&
    (phase.source.active === 'upload'
      ? phase.source.uploadFile !== null
      : phase.source.pasteText.trim() !== '')

  const footer =
    phase.kind === 'select' ? (
      <>
        <button type="button" className="btn" onClick={closeDialog}>
          {t('agentForm.importDialog.cancelButton')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canCheck}
          aria-busy={phase.busy !== null || undefined}
          data-testid="agent-import-parse"
          onClick={() => void checkSource()}
        >
          {phase.busy === 'read-file'
            ? t('agentForm.importDialog.checkingFile')
            : t('agentForm.importDialog.checkButton')}
        </button>
      </>
    ) : phase.kind === 'review' ? (
      <>
        <button
          type="button"
          className="btn"
          data-testid="agent-import-back"
          onClick={backToSource}
        >
          {t('agentForm.importDialog.backButton')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={reviewState?.canApply !== true}
          aria-busy={phase.resolving || undefined}
          data-testid="agent-import-apply"
          onClick={() => void applyToDraft()}
        >
          {t('agentForm.importDialog.applyDraftButton', { count: phase.preview.itemCount })}
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className="btn"
          data-testid="agent-import-another"
          onClick={resetImport}
        >
          {t('agentForm.importDialog.importAnother')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="agent-import-view-form"
          onClick={() => viewForm(phase.firstAffectedTab)}
        >
          {t('agentForm.importDialog.viewForm')}
        </button>
      </>
    )

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title={t('agentForm.importDialog.title')}
      size="lg"
      // Keep this ref stable while the Dialog stays open. Phase/tab focus is
      // handed off by the effect above; changing Dialog.initialFocusRef would
      // run its cleanup and briefly restore focus outside the still-open modal.
      initialFocusRef={chooseButtonRef}
      triggerRef={triggerRef}
      bodyTabIndex={phase.kind === 'select' ? undefined : 0}
      data-testid="agent-import-dialog"
      footer={footer}
    >
      <div className="agent-import">
        {phase.kind === 'select' && (
          <section className="agent-import__phase" data-testid="agent-import-select">
            <div className="agent-import__phase-heading">
              <h3>{t('agentForm.importDialog.selectTitle')}</h3>
              <p>{t('agentForm.importDialog.selectDescription')}</p>
            </div>
            <TabBar<SourceTab>
              variant="inline"
              tabs={[
                {
                  key: 'upload',
                  label: t('agentForm.importDialog.tabUpload'),
                  disabled: phase.busy !== null,
                },
                {
                  key: 'paste',
                  label: t('agentForm.importDialog.tabPaste'),
                  disabled: phase.busy !== null,
                },
              ]}
              active={phase.source.active}
              onSelect={selectSourceTab}
              ariaLabel={t('agentForm.importDialog.selectTitle')}
              idPrefix={SOURCE_TAB_PREFIX}
            />

            <div
              role="tabpanel"
              id={SOURCE_TAB_IDS.upload.panelId}
              aria-labelledby={SOURCE_TAB_IDS.upload.tabId}
              hidden={phase.source.active !== 'upload'}
            >
              {phase.source.active === 'upload' && (
                <FileDropzone
                  file={phase.source.uploadFile}
                  onFileChange={selectFile}
                  accept=".md,.markdown,text/markdown,text/plain"
                  disabled={phase.busy !== null}
                  title={t('agentForm.importDialog.uploadTitle')}
                  description={t('agentForm.importDialog.uploadDescription')}
                  chooseLabel={t('agentForm.importDialog.chooseFile')}
                  replaceLabel={t('agentForm.importDialog.replaceFile')}
                  removeLabel={t('agentForm.importDialog.removeFile')}
                  error={phase.source.selectionError ?? undefined}
                  buttonRef={chooseButtonRef}
                  icon={
                    <svg width="24" height="24" viewBox="0 0 24 24">
                      <path d="M7 3h7l4 4v14H7z" />
                      <path d="M14 3v5h5M12 17v-6m-3 3 3-3 3 3" />
                    </svg>
                  }
                  data-testid="agent-import-file"
                />
              )}
            </div>
            <div
              role="tabpanel"
              id={SOURCE_TAB_IDS.paste.panelId}
              aria-labelledby={SOURCE_TAB_IDS.paste.tabId}
              hidden={phase.source.active !== 'paste'}
            >
              {phase.source.active === 'paste' && (
                <Field
                  label={t('agentForm.importDialog.pasteLabel')}
                  hint={t('agentForm.importDialog.pasteHint')}
                >
                  <TextArea
                    textareaRef={pasteTextAreaRef}
                    value={phase.source.pasteText}
                    onChange={updatePasteText}
                    rows={10}
                    monospace
                    disabled={phase.busy !== null}
                    placeholder={t('agentForm.importDialog.pastePlaceholder')}
                    data-testid="agent-import-textarea"
                  />
                </Field>
              )}
            </div>

            <Card className="agent-import__note">
              <strong>{t('agentForm.importDialog.draftOnlyTitle')}</strong>
              <span>{t('agentForm.importDialog.draftOnlyHint')}</span>
            </Card>
          </section>
        )}

        {phase.kind === 'review' && reviewState !== null && (
          <section className="agent-import__phase" aria-live="polite">
            <div className="agent-import__phase-heading">
              <h3 ref={reviewHeadingRef} tabIndex={-1} data-testid="agent-import-review-heading">
                {t('agentForm.importDialog.reviewTitle')}
              </h3>
              <p>{reviewSourceLabel(phase.source)}</p>
            </div>

            <div
              className="agent-import__summary"
              aria-label={t('agentForm.importDialog.reviewTitle')}
            >
              <StatusChip kind="info" size="sm">
                {t('agentForm.importDialog.itemCount', { count: phase.preview.itemCount })}
              </StatusChip>
              <StatusChip kind="neutral" size="sm">
                {t('agentForm.importDialog.sectionCount', { count: phase.preview.sectionCount })}
              </StatusChip>
              {reviewState.nonBlockingWarnings.length > 0 && (
                <StatusChip kind="warn" size="sm">
                  {t('agentForm.importDialog.warningCount', {
                    count: reviewState.nonBlockingWarnings.length,
                  })}
                </StatusChip>
              )}
            </div>

            {reviewState.blockingWarning !== undefined && (
              <div data-testid="agent-import-warning">
                <ErrorBanner error={null} message={reviewState.blockingWarning.message} />
              </div>
            )}
            {phase.resolveError !== null && (
              <ErrorBanner error={null} message={phase.resolveError} />
            )}
            {phase.ambiguities.length > 0 && (
              <Card
                className="agent-import__notice"
                data-testid="agent-import-reference-mapping"
                header={<strong>{t('agentForm.importDialog.resolveReferences')}</strong>}
              >
                <ImportRefMappingFields
                  ambiguities={phase.ambiguities}
                  selections={phase.selections}
                  disabled={phase.resolving}
                  testidPrefix="agent-import"
                  onChange={(selections) =>
                    setPhase((current) =>
                      current.kind === 'review'
                        ? { ...current, selections, resolveError: null }
                        : current,
                    )
                  }
                />
              </Card>
            )}
            {reviewState.blockingWarning === undefined &&
              reviewState.orphanConflicts.length > 0 && (
                <div data-testid="agent-import-port-conflict">
                  <ErrorBanner
                    error={null}
                    message={t('agentForm.importDialog.orphanConflict', {
                      mappings: reviewState.orphanConflicts
                        .map((conflict) => `${conflict.source}:${conflict.key}`)
                        .join(', '),
                    })}
                    action={
                      <button
                        type="button"
                        className="btn btn--sm"
                        data-testid="agent-import-fix-ports"
                        onClick={() => viewForm('ports')}
                      >
                        {t('agentForm.importDialog.fixPortsButton')}
                      </button>
                    }
                  />
                </div>
              )}

            {reviewState.willOverwrite.length > 0 && (
              <Card
                className="agent-import__notice agent-import__notice--overwrite"
                data-testid="agent-import-overwrite"
                header={
                  <>
                    <strong>{t('agentForm.importDialog.overwriteTitle')}</strong>
                    <StatusChip kind="warn" size="sm">
                      {reviewState.willOverwrite.length}
                    </StatusChip>
                  </>
                }
              >
                <p>
                  {t('agentForm.importDialog.overwriteDescription', {
                    count: reviewState.willOverwrite.length,
                  })}
                </p>
                <div className="agent-import__field-chips">
                  {reviewState.willOverwrite.map((field) => (
                    <code key={field}>{field}</code>
                  ))}
                </div>
              </Card>
            )}

            {reviewState.nonBlockingWarnings.length > 0 && (
              <Card
                className="agent-import__notice"
                data-testid="agent-import-warnings"
                header={
                  <>
                    <strong>{t('agentForm.importDialog.warningTitle')}</strong>
                    <StatusChip kind="warn" size="sm">
                      {reviewState.nonBlockingWarnings.length}
                    </StatusChip>
                  </>
                }
              >
                <ul className="agent-import__warning-list">
                  {reviewState.nonBlockingWarnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>{warning.message}</li>
                  ))}
                </ul>
              </Card>
            )}

            {phase.preview.itemCount === 0 ? (
              <EmptyState
                title={t('agentForm.importDialog.previewEmptyTitle')}
                description={t('agentForm.importDialog.previewEmptyDescription')}
                icon="∅"
                data-testid="agent-import-empty"
              />
            ) : (
              <div className="agent-import__sections">
                {phase.preview.sections.map((section) => (
                  <Card
                    key={section.tab}
                    className="agent-import__section"
                    data-testid={`agent-import-section-${section.tab}`}
                    header={
                      <>
                        <h4>{sectionLabel(section.tab)}</h4>
                        <StatusChip kind="neutral" size="sm">
                          {section.items.length}
                        </StatusChip>
                      </>
                    }
                  >
                    <ul className="agent-import__items">
                      {section.items.map((item) => (
                        <li
                          key={item.id}
                          className="agent-import__item"
                          data-testid={`agent-import-item-${item.id}`}
                        >
                          <code className="agent-import__field">{item.field}</code>
                          <div className="agent-import__item-value">{renderPreviewValue(item)}</div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </div>
            )}
          </section>
        )}

        {phase.kind === 'result' && (
          <section
            className="agent-import__phase agent-import__result"
            data-testid="agent-import-result"
          >
            <div className="agent-import__result-heading">
              <span className="agent-import__result-icon" aria-hidden="true">
                ✓
              </span>
              <div>
                <h3 ref={resultHeadingRef} tabIndex={-1} data-testid="agent-import-result-heading">
                  {t('agentForm.importDialog.resultTitle')}
                </h3>
                <p>
                  {t('agentForm.importDialog.resultDescription', {
                    source: phase.sourceLabel,
                    items: phase.appliedItemCount,
                    sections: phase.affectedSections.length,
                  })}
                </p>
              </div>
            </div>
            <div className="agent-import__result-sections">
              <StatusChip kind="success" size="sm">
                {t('agentForm.importDialog.itemCount', { count: phase.appliedItemCount })}
              </StatusChip>
              {phase.affectedSections.map((section) => (
                <StatusChip key={section.tab} kind="neutral" size="sm">
                  {sectionLabel(section.tab)} · {section.count}
                </StatusChip>
              ))}
            </div>
            <Card className="agent-import__next-step">
              <strong data-testid="agent-import-not-created">
                {t('agentForm.importDialog.notCreated')}
              </strong>
              <span>{t('agentForm.importDialog.resultNextStep')}</span>
            </Card>
          </section>
        )}
      </div>
    </Dialog>
  )
}
