// RFC-196: a three-stage ZIP import task — select, review, result.
// RFC-223 AC19: overwrite targets are explicit previewed skill ids with
// owner/ACL/content fences; names remain display/candidate labels only.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SKILL_ZIP_LIMITS,
  type CommitSkillZipResponse,
  type ParseSkillZipResponse,
  type Skill,
  type SkillZipOverwriteCandidate,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FileDropzone, formatShortBytes } from '@/components/FileDropzone'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { getBaseUrl, getToken } from '@/stores/auth'
import {
  availableActionsFor,
  buildDecisionMap,
  deriveReviewSummary,
  deriveSubmitState,
  resultKind,
  rowsFromParseResponse,
  validateRenameTarget,
  validateSkillZipFile,
  type DecisionAction,
  type RowState,
} from '@/lib/skill-zip-import'

interface ZipUiError {
  code?: string
  message: string
}

type ZipImportPhase =
  | {
      kind: 'select'
      file: File | null
      selectionError: string | null
      parseError: ZipUiError | null
    }
  | {
      kind: 'review'
      file: File
      parse: ParseSkillZipResponse
      rows: RowState[]
      commitError: ZipUiError | null
    }
  | {
      kind: 'result'
      fileName: string
      summary: CommitSkillZipResponse
    }

type Busy = 'parse' | 'commit' | null

type PendingReset = { kind: 'file'; file: File | null } | { kind: 'review' } | null

export interface ImportZipPanelHandle {
  /** Discard every staged ZIP selection/decision before a guarded navigation. */
  discard: () => boolean
}

export interface ImportZipPanelProps {
  /** select-with-file and review are unsafe to leave; a stable result is clean. */
  onDirtyChange?: (dirty: boolean) => void
  /** Commit writes are globally non-discardable until the request settles. */
  beginCommitBusy?: () => () => void
}

const ACCEPT_ZIP = '.zip,application/zip,application/x-zip-compressed'

function freshSelect(file: File | null = null): ZipImportPhase {
  return { kind: 'select', file, selectionError: null, parseError: null }
}

export const ImportZipPanel = forwardRef<ImportZipPanelHandle, ImportZipPanelProps>(
  function ImportZipPanel({ onDirtyChange, beginCommitBusy }, ref) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const qc = useQueryClient()
    const chooseButtonRef = useRef<HTMLButtonElement | null>(null)
    const resetTriggerRef = useRef<HTMLElement | null>(null)
    const resultHeadingRef = useRef<HTMLHeadingElement | null>(null)
    const parseAttemptRef = useRef(0)
    const parseAbortRef = useRef<AbortController | null>(null)
    const [phase, setPhase] = useState<ZipImportPhase>(() => freshSelect())
    const [busy, setBusy] = useState<Busy>(null)
    const [pendingReset, setPendingReset] = useState<PendingReset>(null)

    const skillsList = useQuery<Skill[]>({
      queryKey: ['skills'],
      queryFn: async () => {
        const res = await authedFetch('/api/skills', { method: 'GET' })
        if (!res.ok) throw new Error(`failed to list skills: ${res.status}`)
        return (await res.json()) as Skill[]
      },
    })
    const existingNames = useMemo(
      () => new Set((skillsList.data ?? []).map((skill) => skill.name)),
      [skillsList.data],
    )

    useEffect(() => {
      if (phase.kind === 'result') resultHeadingRef.current?.focus()
    }, [phase.kind])

    const dirty = phase.kind === 'review' || (phase.kind === 'select' && phase.file !== null)
    useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

    useImperativeHandle(
      ref,
      () => ({
        discard: () => {
          if (busy === 'commit') return false
          parseAttemptRef.current += 1
          parseAbortRef.current?.abort()
          parseAbortRef.current = null
          setBusy(null)
          setPendingReset(null)
          setPhase(freshSelect())
          onDirtyChange?.(false)
          return true
        },
      }),
      [busy, onDirtyChange],
    )

    function applyFileChange(next: File | null) {
      if (busy !== null) return
      if (next === null) {
        setPhase(freshSelect())
        onDirtyChange?.(false)
        return
      }
      const checked = validateSkillZipFile(next)
      if (!checked.ok) {
        setPhase({
          kind: 'select',
          file: null,
          selectionError:
            checked.reason === 'type'
              ? t('skills.zipWrongType')
              : t('skills.zipTooLarge', { limit: formatShortBytes(SKILL_ZIP_LIMITS.totalBytes) }),
          parseError: null,
        })
        onDirtyChange?.(false)
        return
      }
      setPhase(freshSelect(checked.file))
      onDirtyChange?.(true)
    }

    function onFileChange(next: File | null) {
      if (busy !== null || phase.kind !== 'select') return
      if (phase.file !== null) {
        resetTriggerRef.current = chooseButtonRef.current
        setPendingReset({ kind: 'file', file: next })
        return
      }
      applyFileChange(next)
    }

    async function onParse() {
      if (phase.kind !== 'select' || phase.file === null || busy !== null) return
      const file = phase.file
      const attempt = ++parseAttemptRef.current
      const controller = new AbortController()
      parseAbortRef.current = controller
      setBusy('parse')
      setPhase({ ...phase, selectionError: null, parseError: null })
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await authedFetch('/api/skills/import-zip/parse', {
          method: 'POST',
          body: fd,
          signal: controller.signal,
        })
        if (parseAttemptRef.current !== attempt) return
        if (!res.ok) {
          setPhase({
            kind: 'select',
            file,
            selectionError: null,
            parseError: await readResponseError(res, t('skills.zipParseFailedFallback')),
          })
          return
        }
        const parse = (await res.json()) as ParseSkillZipResponse
        setPhase({
          kind: 'review',
          file,
          parse,
          rows: rowsFromParseResponse(parse),
          commitError: null,
        })
      } catch (error) {
        if (parseAttemptRef.current !== attempt) return
        setPhase({
          kind: 'select',
          file,
          selectionError: null,
          parseError: errorFromUnknown(error, t('skills.zipParseFailedFallback')),
        })
      } finally {
        if (parseAttemptRef.current === attempt) {
          parseAbortRef.current = null
          setBusy(null)
        }
      }
    }

    async function onCommit() {
      if (phase.kind !== 'review' || busy !== null) return
      const review = phase
      const releaseBusy = beginCommitBusy?.() ?? (() => {})
      setBusy('commit')
      setPhase({ ...review, commitError: null })
      try {
        const fd = new FormData()
        fd.append('file', review.file)
        fd.append('decisions', JSON.stringify(buildDecisionMap(review.rows)))
        const res = await authedFetch('/api/skills/import-zip/commit', {
          method: 'POST',
          body: fd,
        })
        if (!res.ok) {
          setPhase({
            ...review,
            commitError: await readResponseError(
              res,
              t('skills.zipCommitFailedFallback', { status: res.status }),
            ),
          })
          return
        }
        const summary = (await res.json()) as CommitSkillZipResponse
        await qc.invalidateQueries({ queryKey: ['skills'] }).catch(() => undefined)
        setPhase({ kind: 'result', fileName: review.file.name, summary })
        onDirtyChange?.(false)
      } catch (error) {
        setPhase({
          ...review,
          commitError: errorFromUnknown(
            error,
            t('skills.zipCommitFailedFallback', { status: '—' }),
          ),
        })
      } finally {
        setBusy(null)
        releaseBusy()
      }
    }

    function updateRow(idx: number, patch: Partial<RowState['decision']>) {
      if (phase.kind !== 'review' || busy !== null) return
      setPhase({
        ...phase,
        rows: phase.rows.map((row, i) =>
          i === idx ? { ...row, decision: { ...row.decision, ...patch } } : row,
        ),
        commitError: null,
      })
    }

    function returnToSelect(trigger: HTMLButtonElement) {
      if (phase.kind !== 'review' || busy !== null) return
      resetTriggerRef.current = trigger
      setPendingReset({ kind: 'review' })
    }

    function importAnother() {
      setPhase(freshSelect())
      window.setTimeout(() => chooseButtonRef.current?.focus(), 0)
    }

    return (
      <div className="skill-import" data-testid="skill-import">
        {phase.kind === 'select' && (
          <SelectPhase
            phase={phase}
            busy={busy === 'parse'}
            chooseButtonRef={chooseButtonRef}
            onFileChange={onFileChange}
            onParse={onParse}
          />
        )}
        {phase.kind === 'review' && (
          <ReviewPhase
            phase={phase}
            busy={busy === 'commit'}
            existingNames={existingNames}
            namesAvailable={skillsList.data !== undefined}
            namesLoading={skillsList.isPending}
            namesError={skillsList.isError ? skillsList.error : null}
            onRetryNames={() => void skillsList.refetch()}
            onUpdate={updateRow}
            onBack={returnToSelect}
            onCommit={onCommit}
          />
        )}
        {phase.kind === 'result' && (
          <ResultPhase
            phase={phase}
            headingRef={resultHeadingRef}
            onContinue={importAnother}
            onReturn={() => navigate({ to: '/skills' })}
          />
        )}
        <ConfirmDialog
          open={pendingReset !== null}
          title={t('splitPage.unsavedTitle')}
          description={t('splitPage.unsavedBody')}
          confirmLabel={t('splitPage.unsavedDiscard')}
          tone="danger"
          triggerRef={resetTriggerRef}
          restoreFocusFallbackRef={chooseButtonRef}
          onClose={() => setPendingReset(null)}
          onConfirm={() => {
            const action = pendingReset
            if (action === null) return
            if (action.kind === 'review') {
              if (phase.kind === 'review') setPhase(freshSelect(phase.file))
            } else {
              applyFileChange(action.file)
            }
          }}
        />
      </div>
    )
  },
)

function SelectPhase({
  phase,
  busy,
  chooseButtonRef,
  onFileChange,
  onParse,
}: {
  phase: Extract<ZipImportPhase, { kind: 'select' }>
  busy: boolean
  chooseButtonRef: React.Ref<HTMLButtonElement>
  onFileChange: (file: File | null) => void
  onParse: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="skill-import__phase" data-testid="zip-select-phase">
      <FileDropzone
        file={phase.file}
        onFileChange={onFileChange}
        accept={ACCEPT_ZIP}
        disabled={busy}
        title={t('skills.zipDropTitle')}
        description={t('skills.zipDropHint', {
          limit: formatShortBytes(SKILL_ZIP_LIMITS.totalBytes),
        })}
        chooseLabel={t('skills.zipChoose')}
        replaceLabel={t('skills.zipReplace')}
        removeLabel={t('skills.zipRemove')}
        error={phase.selectionError ?? undefined}
        icon={<ZipIcon />}
        buttonRef={chooseButtonRef}
        data-testid="zip-file-input"
      />

      {phase.parseError !== null && (
        <ErrorBanner
          error={phase.parseError}
          message={formatUiError(phase.parseError)}
          action={
            <button type="button" className="btn btn--sm" disabled={busy} onClick={onParse}>
              {t('skills.zipRetry')}
            </button>
          }
        />
      )}

      <Card className="skill-import__structure">
        <div className="skill-import__structure-copy">
          <strong>{t('skills.zipStructureTitle')}</strong>
          <span>{t('skills.zipManagedHint')}</span>
        </div>
        <pre aria-label={t('skills.zipStructureTitle')}>
          {'pack.zip\n└── my-skill/\n    ├── SKILL.md\n    └── references/…'}
        </pre>
      </Card>

      <div className="skill-import__select-action">
        <button
          type="button"
          className="btn btn--primary"
          disabled={phase.file === null || busy}
          aria-busy={busy || undefined}
          onClick={onParse}
          data-testid="zip-parse-button"
        >
          {busy ? t('skills.zipChecking') : t('skills.zipCheck')}
        </button>
        {busy && (
          <span className="skill-import__pending" role="status" aria-live="polite">
            {t('skills.zipCheckingStatus')}
          </span>
        )}
      </div>
    </div>
  )
}

function ReviewPhase({
  phase,
  busy,
  existingNames,
  namesAvailable,
  namesLoading,
  namesError,
  onRetryNames,
  onUpdate,
  onBack,
  onCommit,
}: {
  phase: Extract<ZipImportPhase, { kind: 'review' }>
  busy: boolean
  existingNames: ReadonlySet<string>
  namesAvailable: boolean
  namesLoading: boolean
  namesError: unknown
  onRetryNames: () => void
  onUpdate: (idx: number, patch: Partial<RowState['decision']>) => void
  onBack: (trigger: HTMLButtonElement) => void
  onCommit: () => void
}) {
  const { t } = useTranslation()
  const reviewSummary = deriveReviewSummary(phase.parse)
  const submit = deriveSubmitState(
    phase.rows,
    { available: namesAvailable, names: existingNames },
    busy,
  )
  const selected = submit.counts.importing + submit.counts.overwriting + submit.counts.renaming
  const needsNames = submit.reason === 'names-unavailable'

  return (
    <div className="skill-import__phase" data-testid="zip-review-phase">
      <div className="skill-import__archive">
        <div className="skill-import__archive-copy">
          <strong title={phase.file.name}>{phase.file.name}</strong>
          <span>{formatShortBytes(phase.file.size)}</span>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={(event) => onBack(event.currentTarget)}
        >
          {t('skills.zipReplace')}
        </button>
      </div>

      <div className="skill-import__review-summary" aria-label={t('skills.zipReviewSummary')}>
        <StatusChip kind="info" size="sm">
          {t('skills.zipCandidatesCount', { count: reviewSummary.candidates })}
        </StatusChip>
        <StatusChip kind={reviewSummary.conflicts > 0 ? 'warn' : 'neutral'} size="sm">
          {t('skills.zipConflictsCount', { count: reviewSummary.conflicts })}
        </StatusChip>
        {reviewSummary.archiveErrors > 0 && (
          <StatusChip kind="warn" size="sm">
            {t('skills.zipArchiveErrorsCount', { count: reviewSummary.archiveErrors })}
          </StatusChip>
        )}
      </div>

      {phase.parse.errors.length > 0 && <ArchiveErrors parse={phase.parse} />}

      {phase.rows.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('skills.zipNoCandidatesTitle')}
          description={t('skills.zipNoCandidates')}
          action={
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={(event) => onBack(event.currentTarget)}
            >
              {t('skills.zipReplace')}
            </button>
          }
        />
      ) : (
        <div className="skill-import__candidates" data-testid="zip-candidate-list">
          {phase.rows.map((row, idx) => (
            <CandidateCard
              key={row.candidate.name}
              row={row}
              idx={idx}
              allRows={phase.rows}
              existingNames={existingNames}
              disabled={busy}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}

      {needsNames &&
        (namesLoading ? (
          <LoadingState size="compact" label={t('skills.zipNamesLoading')} />
        ) : (
          <ErrorBanner
            error={namesError}
            message={t('skills.zipNamesUnavailable')}
            action={
              <button type="button" className="btn btn--sm" onClick={onRetryNames}>
                {t('skills.zipRetry')}
              </button>
            }
          />
        ))}

      {!needsNames && namesError !== null && namesAvailable && (
        <ErrorBanner
          error={namesError}
          message={t('skills.zipNamesStale')}
          action={
            <button type="button" className="btn btn--sm" onClick={onRetryNames}>
              {t('skills.zipRetry')}
            </button>
          }
        />
      )}

      {phase.commitError !== null && (
        <ErrorBanner error={phase.commitError} message={formatUiError(phase.commitError)} />
      )}

      {phase.rows.length > 0 && (
        <div className="skill-import__actions" data-testid="zip-review-actions">
          <div className="skill-import__action-copy" aria-live="polite">
            <strong>
              {t('skills.zipActionSummary', {
                creating: submit.counts.importing + submit.counts.renaming,
                updating: submit.counts.overwriting,
                skipping: submit.counts.skipping,
              })}
            </strong>
            {submit.counts.overwriting > 0 && (
              <span>{t('skills.zipOverwriteWarning', { count: submit.counts.overwriting })}</span>
            )}
          </div>
          <div className="skill-import__action-buttons">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={(event) => onBack(event.currentTarget)}
            >
              {t('skills.zipBack')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!submit.enabled}
              aria-busy={busy || undefined}
              onClick={onCommit}
              data-testid="zip-commit-button"
            >
              {busy
                ? t('skills.zipImporting')
                : t('skills.zipImportButton', { n: selected, s: submit.counts.skipping })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ArchiveErrors({ parse }: { parse: ParseSkillZipResponse }) {
  const { t } = useTranslation()
  return (
    <Card
      className="skill-import__archive-errors"
      header={<strong>{t('skills.zipArchiveErrorsTitle', { count: parse.errors.length })}</strong>}
    >
      <ul>
        {parse.errors.map((error, index) => (
          <li key={`${error.path}-${error.code}-${index}`}>
            <code>{error.path === '' ? t('skills.zipErrorWholeArchiveLabel') : error.path}</code>
            <span>
              <strong>{error.code}</strong>: {error.message}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function CandidateCard({
  row,
  idx,
  allRows,
  existingNames,
  disabled,
  onUpdate,
}: {
  row: RowState
  idx: number
  allRows: RowState[]
  existingNames: ReadonlySet<string>
  disabled: boolean
  onUpdate: (idx: number, patch: Partial<RowState['decision']>) => void
}) {
  const { t } = useTranslation()
  const availableActions = availableActionsFor(row.candidate)
  const renameStatus =
    row.decision.action === 'rename'
      ? validateRenameTarget(row.decision.newName, row.candidate.name, allRows, existingNames)
      : null
  const status = candidateStatus(row, t)
  const renameError =
    renameStatus !== null && !renameStatus.ok
      ? labelForRenameError(t, renameStatus.reason!)
      : undefined
  const errorId = `zip-rename-error-${row.candidate.name}`

  return (
    <Card
      className="zip-candidate"
      data-testid={`zip-row-${row.candidate.name}`}
      header={
        <div className="zip-candidate__header">
          <code title={row.candidate.name}>{row.candidate.name}</code>
          <StatusChip kind={status.kind} size="sm">
            {status.label}
          </StatusChip>
        </div>
      }
      footer={
        <div className="zip-candidate__decision">
          <Field label={t('skills.zipActionFor', { name: row.candidate.name })} group>
            <Select<DecisionAction>
              value={row.decision.action}
              onChange={(action) => onUpdate(idx, { action })}
              disabled={disabled || availableActions.length <= 1}
              ariaLabel={t('skills.zipActionFor', { name: row.candidate.name })}
              data-testid={`zip-action-${row.candidate.name}`}
              options={availableActions.map((action) => ({
                value: action,
                label: labelForAction(t, action),
              }))}
            />
          </Field>
          {row.decision.action === 'overwrite' && (
            <Field label={t('skills.zipOverwriteTargetFor', { name: row.candidate.name })} required>
              <Select<string>
                value={row.decision.overwriteSkillId}
                onChange={(overwriteSkillId) => onUpdate(idx, { overwriteSkillId })}
                disabled={disabled}
                ariaLabel={t('skills.zipOverwriteTargetFor', { name: row.candidate.name })}
                data-testid={`zip-overwrite-target-${row.candidate.name}`}
                options={[
                  ...(row.candidate.overwriteCandidates.length > 1
                    ? [
                        {
                          value: '',
                          label: t('skills.zipOverwriteTargetPlaceholder'),
                        },
                      ]
                    : []),
                  ...row.candidate.overwriteCandidates.map((target) => ({
                    value: target.skillId,
                    label: overwriteTargetLabel(row.candidate.name, target, t),
                  })),
                ]}
              />
            </Field>
          )}
          {row.decision.action === 'rename' && (
            <Field
              label={t('skills.zipRenameFor', { name: row.candidate.name })}
              error={renameError}
              errorId={errorId}
            >
              <TextInput
                value={row.decision.newName}
                onChange={(newName) => onUpdate(idx, { newName })}
                placeholder={t('skills.zipRenameTo')}
                disabled={disabled}
                aria-label={t('skills.zipRenameFor', { name: row.candidate.name })}
                aria-invalid={renameError === undefined ? undefined : true}
                aria-describedby={renameError === undefined ? undefined : errorId}
                data-testid={`zip-rename-${row.candidate.name}`}
              />
            </Field>
          )}
        </div>
      }
    >
      <p className="zip-candidate__description" title={row.candidate.description || undefined}>
        {row.candidate.description || t('skills.zipDescriptionEmpty')}
      </p>
      <p className="zip-candidate__facts">
        {t('skills.zipCandidateFacts', {
          files: row.candidate.fileCount,
          size: formatShortBytes(row.candidate.totalBytes),
        })}
      </p>
      {row.candidate.warnings.length > 0 && (
        <ul className="zip-candidate__warnings">
          {row.candidate.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ResultPhase({
  phase,
  headingRef,
  onContinue,
  onReturn,
}: {
  phase: Extract<ZipImportPhase, { kind: 'result' }>
  headingRef: React.Ref<HTMLHeadingElement>
  onContinue: () => void
  onReturn: () => void
}) {
  const { t } = useTranslation()
  const kind = resultKind(phase.summary)
  const headingKey =
    kind === 'success'
      ? 'skills.zipResultSuccess'
      : kind === 'partial'
        ? 'skills.zipResultPartial'
        : 'skills.zipResultNoWrite'

  return (
    <div
      className={`skill-import__result skill-import__result--${kind}`}
      data-testid="zip-import-summary"
    >
      <div className="skill-import__result-heading">
        <span className="skill-import__result-icon" aria-hidden="true">
          {kind === 'success' ? '✓' : kind === 'partial' ? '!' : '×'}
        </span>
        <div>
          <h3 ref={headingRef} tabIndex={-1}>
            {t(headingKey)}
          </h3>
          <p>{t('skills.zipResultFile', { name: phase.fileName })}</p>
        </div>
      </div>

      <div className="skill-import__result-counts">
        <StatusChip kind="success" size="sm">
          {t('skills.zipResultCreatedCount', { count: phase.summary.created.length })}
        </StatusChip>
        <StatusChip kind="info" size="sm">
          {t('skills.zipResultUpdatedCount', { count: phase.summary.updated.length })}
        </StatusChip>
        <StatusChip kind="neutral" size="sm">
          {t('skills.zipResultSkippedCount', { count: phase.summary.skipped.length })}
        </StatusChip>
        <StatusChip kind={phase.summary.failed.length > 0 ? 'danger' : 'neutral'} size="sm">
          {t('skills.zipResultFailedCount', { count: phase.summary.failed.length })}
        </StatusChip>
      </div>

      {phase.summary.failed.length > 0 && (
        <ErrorBanner
          error={phase.summary.failed}
          message={t('skills.zipResultFailures', { count: phase.summary.failed.length })}
        />
      )}

      <div className="skill-import__result-groups">
        {phase.summary.created.length > 0 && (
          <ResultWrittenGroup
            title={t('skills.zipResultCreated')}
            chip={t('skills.zipResultCreatedChip')}
            kind="success"
            items={phase.summary.created}
          />
        )}
        {phase.summary.updated.length > 0 && (
          <ResultWrittenGroup
            title={t('skills.zipResultUpdated')}
            chip={t('skills.zipResultUpdatedChip')}
            kind="info"
            items={phase.summary.updated}
          />
        )}
        {phase.summary.skipped.length > 0 && (
          <section className="skill-import__result-group">
            <h4>{t('skills.zipResultSkipped')}</h4>
            <ul>
              {phase.summary.skipped.map((item) => (
                <li key={item.name}>
                  <code>{item.name}</code>
                  <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {phase.summary.failed.length > 0 && (
          <section className="skill-import__result-group skill-import__result-group--failed">
            <h4>{t('skills.zipResultFailed')}</h4>
            <ul>
              {phase.summary.failed.map((item) => (
                <li key={`${item.name}-${item.code}`}>
                  <code>{item.name}</code>
                  <span>
                    <strong>{item.code}</strong>: {item.message}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="skill-import__result-actions">
        <button type="button" className="btn btn--primary" onClick={onContinue}>
          {t('skills.zipContinue')}
        </button>
        <button type="button" className="btn" onClick={onReturn}>
          {t('skills.zipReturnList')}
        </button>
      </div>
    </div>
  )
}

function ResultWrittenGroup({
  title,
  chip,
  kind,
  items,
}: {
  title: string
  chip: string
  kind: StatusChipKind
  items: Skill[]
}) {
  const { t } = useTranslation()
  return (
    <section className="skill-import__result-group">
      <h4>{title}</h4>
      <ul>
        {items.map((skill) => (
          <li key={skill.id}>
            <StatusChip kind={kind} size="sm">
              {chip}
            </StatusChip>
            <Link
              to="/skills/$id"
              params={{ id: skill.id }}
              aria-label={t('skills.zipOpenSkill', { name: skill.name })}
            >
              {skill.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function candidateStatus(row: RowState, t: TFunction): { kind: StatusChipKind; label: string } {
  if (row.candidate.conflict === undefined) {
    return { kind: 'success', label: t('skills.zipStatusReady') }
  }
  if (row.candidate.overwriteCandidates.length > 0) {
    return { kind: 'warn', label: t('skills.zipConflictManaged') }
  }
  return { kind: 'neutral', label: t('skills.zipConflictManagedReadonly') }
}

function overwriteTargetLabel(
  name: string,
  target: SkillZipOverwriteCandidate,
  t: TFunction,
): string {
  return t('skills.zipOverwriteTargetOption', {
    name,
    owner: shortIdentity(target.ownerUserId ?? t('acl.systemOwner')),
    visibility:
      target.visibility === 'private'
        ? t('skills.zipVisibilityPrivate')
        : t('skills.zipVisibilityPublic'),
    id: shortIdentity(target.skillId),
  })
}

function shortIdentity(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`
}

function labelForAction(t: TFunction, action: DecisionAction): string {
  switch (action) {
    case 'import':
      return t('skills.zipActionImport')
    case 'skip':
      return t('skills.zipActionSkip')
    case 'overwrite':
      return t('skills.zipActionOverwrite')
    case 'rename':
      return t('skills.zipActionRename')
  }
}

function labelForRenameError(
  t: TFunction,
  reason: NonNullable<ReturnType<typeof validateRenameTarget>['reason']>,
): string {
  switch (reason) {
    case 'empty':
      return t('skills.zipRenameEmpty')
    case 'invalid':
      return t('skills.zipRenameInvalid')
    case 'duplicate-in-batch':
      return t('skills.zipRenameDup')
    case 'conflict-with-db':
      return t('skills.zipRenameConflict')
  }
}

function ZipIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M8 3.5h10l6 6V27a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 7 27V5A1.5 1.5 0 0 1 8.5 3.5Z" />
      <path d="M18 3.5V10h6M14 7h4M14 11h4M14 15h4M14 19h4M14 23h4" />
    </svg>
  )
}

function formatUiError(error: ZipUiError): string {
  return error.code === undefined ? error.message : `${error.code}: ${error.message}`
}

async function readResponseError(response: Response, fallback: string): Promise<ZipUiError> {
  const parsed: unknown = await response.json().catch(() => ({}))
  const body =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  return {
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
    message: typeof body.message === 'string' ? body.message : fallback,
  }
}

function errorFromUnknown(error: unknown, fallback: string): ZipUiError {
  return { message: error instanceof Error && error.message !== '' ? error.message : fallback }
}

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const url = new URL(path.startsWith('/') ? path : `/${path}`, getBaseUrl()).toString()
  return fetch(url, { ...init, headers })
}
