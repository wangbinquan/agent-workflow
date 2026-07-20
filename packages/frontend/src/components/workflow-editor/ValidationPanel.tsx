import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import type {
  WorkflowDefinition,
  WorkflowValidationIssue,
  WorkflowValidationTarget,
} from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { NoticeBanner } from '@/components/NoticeBanner'
import { describeValidationIssue } from '@/i18n/errors'
import { resolveWorkflowIssueTarget } from '@/lib/workflow-validation-target'

const COMPACT_VALIDATION_QUERY = '(max-width: 720px), (max-height: 520px)'

function compactValidationSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(COMPACT_VALIDATION_QUERY).matches
}

function subscribeCompactValidation(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(COMPACT_VALIDATION_QUERY)
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }
  media.addListener(onChange)
  return () => media.removeListener(onChange)
}

export function useCompactValidationSurface(): boolean {
  return useSyncExternalStore(subscribeCompactValidation, compactValidationSnapshot, () => false)
}

export type ValidationPanelStaleReason = 'draft' | 'inventory' | null

export function partitionValidationIssues(issues: readonly WorkflowValidationIssue[]): {
  errors: WorkflowValidationIssue[]
  warnings: WorkflowValidationIssue[]
} {
  const errors: WorkflowValidationIssue[] = []
  const warnings: WorkflowValidationIssue[] = []
  for (const issue of issues) {
    if (issue.severity === 'warning') warnings.push(issue)
    else errors.push(issue)
  }
  return { errors, warnings }
}

export interface ValidationPanelProps {
  result: { ok: boolean; issues: readonly WorkflowValidationIssue[] }
  stale: ValidationPanelStaleReason
  definition: WorkflowDefinition
  /** Optional route-owned state keeps this surface mutually exclusive with other editor dialogs. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  validating?: boolean
  onRevalidate?: () => void
  onNavigate: (target: WorkflowValidationTarget) => void
  onAutoFitWrapper?: (wrapperId: string) => void
}

export function ValidationPanel(props: ValidationPanelProps) {
  const { t } = useTranslation()
  const { onOpenChange } = props
  const compact = useCompactValidationSurface()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = props.open ?? internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  const [targetChanged, setTargetChanged] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstIssueRef = useRef<HTMLButtonElement | null>(null)
  const { errors, warnings } = partitionValidationIssues(props.result.issues)

  useEffect(() => setTargetChanged(false), [props.result, props.stale])
  useEffect(() => {
    if (!open || compact) return
    firstIssueRef.current?.focus()
  }, [compact, open])
  useEffect(() => {
    if (!open || compact) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [compact, open, setOpen])

  const summary =
    props.stale !== null
      ? t('editor.validationSummaryStale')
      : errors.length > 0
        ? t('editor.validationSummaryErrors', { n: errors.length })
        : warnings.length > 0
          ? t('editor.validationSummaryWarnings', { n: warnings.length })
          : t('editor.validationSummaryOk')

  const close = () => {
    setOpen(false)
    if (!compact) triggerRef.current?.focus()
  }

  const body = (
    <ValidationDetails
      {...props}
      errors={errors}
      warnings={warnings}
      targetChanged={targetChanged}
      firstIssueRef={firstIssueRef}
      onTargetChanged={() => setTargetChanged(true)}
      onNavigate={(target) => {
        setOpen(false)
        props.onNavigate(target)
      }}
    />
  )

  return (
    <div className="workflow-validation" data-state={props.stale !== null ? 'stale' : 'current'}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--sm workflow-validation__summary"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="workflow-validation-summary"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">
          {props.stale !== null || warnings.length > 0 ? '⚠' : errors.length > 0 ? '!' : '✓'}
        </span>{' '}
        {summary}
      </button>
      {compact ? (
        <Dialog
          open={open}
          onClose={close}
          title={t('editor.validationDetailsTitle')}
          size="md"
          panelClassName="workflow-validation-dialog"
          triggerRef={triggerRef}
          initialFocusRef={firstIssueRef}
          bodyTabIndex={0}
          data-testid="workflow-validation-dialog"
        >
          {body}
        </Dialog>
      ) : open ? (
        <section
          className="workflow-validation__overlay"
          role="dialog"
          aria-label={t('editor.validationDetailsTitle')}
          data-testid="workflow-validation-overlay"
        >
          <header className="workflow-validation__header">
            <strong>{t('editor.validationDetailsTitle')}</strong>
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              aria-label={t('common.close')}
              onClick={close}
            >
              ×
            </button>
          </header>
          {body}
        </section>
      ) : null}
    </div>
  )
}

function ValidationDetails({
  stale,
  definition,
  validating,
  onRevalidate,
  onNavigate,
  onAutoFitWrapper,
  errors,
  warnings,
  targetChanged,
  onTargetChanged,
  firstIssueRef,
}: ValidationPanelProps & {
  errors: WorkflowValidationIssue[]
  warnings: WorkflowValidationIssue[]
  targetChanged: boolean
  onTargetChanged: () => void
  firstIssueRef: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation()
  if (stale !== null) {
    return (
      <ValidationAdvisory
        message={t(
          stale === 'draft' ? 'editor.validationStaleDraft' : 'editor.validationStaleInventory',
        )}
        validating={validating}
        onRevalidate={onRevalidate}
      />
    )
  }

  return (
    <div className="workflow-validation__details">
      {targetChanged ? (
        <ValidationAdvisory
          message={t('editor.validationTargetChanged')}
          validating={validating}
          onRevalidate={onRevalidate}
        />
      ) : null}
      {errors.length === 0 && warnings.length === 0 ? (
        <div className="workflow-validation__empty">{t('editor.validationOk')}</div>
      ) : null}
      {errors.length > 0 ? (
        <IssueGroup
          title={t('editor.validationIssues', { n: errors.length })}
          issues={errors}
          definition={definition}
          firstIssueRef={firstIssueRef}
          onNavigate={onNavigate}
          onTargetChanged={onTargetChanged}
          onAutoFitWrapper={onAutoFitWrapper}
        />
      ) : null}
      {warnings.length > 0 ? (
        <IssueGroup
          title={t('editor.validationWarnings', { n: warnings.length })}
          issues={warnings}
          definition={definition}
          firstIssueRef={errors.length === 0 ? firstIssueRef : undefined}
          onNavigate={onNavigate}
          onTargetChanged={onTargetChanged}
          onAutoFitWrapper={onAutoFitWrapper}
        />
      ) : null}
    </div>
  )
}

function ValidationAdvisory({
  message,
  validating,
  onRevalidate,
}: {
  message: string
  validating?: boolean
  onRevalidate?: () => void
}) {
  const { t } = useTranslation()
  return (
    <NoticeBanner
      tone="warning"
      size="compact"
      action={
        onRevalidate === undefined ? undefined : (
          <button
            type="button"
            className="btn btn--xs"
            disabled={validating}
            onClick={onRevalidate}
          >
            {validating ? t('editor.validating') : t('editor.validationRevalidate')}
          </button>
        )
      }
    >
      {message}
    </NoticeBanner>
  )
}

function IssueGroup({
  title,
  issues,
  definition,
  firstIssueRef,
  onNavigate,
  onTargetChanged,
  onAutoFitWrapper,
}: {
  title: string
  issues: readonly WorkflowValidationIssue[]
  definition: WorkflowDefinition
  firstIssueRef?: RefObject<HTMLButtonElement | null>
  onNavigate: (target: WorkflowValidationTarget) => void
  onTargetChanged: () => void
  onAutoFitWrapper?: (wrapperId: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="workflow-validation__group">
      <h3>{title}</h3>
      <ul>
        {issues.map((issue, index) => {
          const described = describeValidationIssue(issue)
          const target = resolveWorkflowIssueTarget(issue, definition)
          const wrapperId =
            issue.code === 'wrapper-children-outside-bounds' && target.kind === 'node'
              ? target.nodeId
              : undefined
          return (
            <li key={`${issue.code}-${issue.pointer ?? ''}-${index}`}>
              <button
                ref={index === 0 ? firstIssueRef : undefined}
                type="button"
                className="workflow-validation__issue"
                onClick={() => {
                  if (target.kind === 'unknown') onTargetChanged()
                  else onNavigate(target)
                }}
              >
                <span className="workflow-validation__issue-icon" aria-hidden="true">
                  {issue.severity === 'warning' ? '⚠' : '!'}
                </span>
                <span>
                  <code>{issue.code}</code>
                  <span>{described.title}</span>
                </span>
                <span className="workflow-validation__issue-action">
                  {target.kind === 'unknown'
                    ? t('editor.validationTargetUnavailable')
                    : t('editor.validationGoToIssue')}
                </span>
              </button>
              {wrapperId !== undefined && onAutoFitWrapper !== undefined ? (
                <button
                  type="button"
                  className="btn btn--xs workflow-validation__autofit"
                  onClick={() => onAutoFitWrapper(wrapperId)}
                >
                  {t('editor.validationAutoFitWrapper')}
                </button>
              ) : null}
              <details className="error-details__raw">
                <summary>{t('errorDetails.rawSummary')}</summary>
                <pre>{described.raw}</pre>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
