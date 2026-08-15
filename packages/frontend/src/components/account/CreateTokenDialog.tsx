// RFC-247 D1 / D2 / D4 / D8 / C10 — issue a personal access token.
//
// Two phases in one dialog, GitHub's shape: pick what the token may do, then
// see the token exactly once. The reveal is a phase rather than a second dialog
// because the raw secret exists only in this response — a dismissable toast or
// a re-mounted dialog risks losing it to a stray click.
//
// The permission picker is a template row plus an optional grid. Most tokens
// are one of three shapes and want the template; the grid exists for the ones
// that are not, and for anything involving delete — which no template selects
// (D4-2), so reaching a delete grant requires opening the grid and ticking the
// individual box.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DELETE_POINTS,
  type PatPublic,
  type PatPurpose,
  type Permission,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { TokenPermissionMatrix } from '@/components/account/TokenPermissionMatrix'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { copyText } from '@/lib/clipboard'
import {
  PatReconciliationStorageError,
  clearPatReconciliationMarker,
  createPatReconciliationMarker,
  findPatReconciliationCandidates,
  readPatReconciliationMarker,
  writePatReconciliationMarker,
  type PatReconciliationMarkerRead,
  type PatReconciliationMarkerV1,
} from '@/lib/pat-reconciliation'
import {
  matchingTemplate,
  selectionHasDelete,
  templatePoints,
  type TemplateId,
} from '@/lib/token-matrix'
import { classifyWriteOutcome } from '@/lib/write-outcome'

interface CreateTokenDialogProps {
  open: boolean
  onClose: () => void
  actorId: string
  permissions: ReadonlyArray<Permission>
  /** Invalidate the actor query so the new token appears in the list. */
  onCreated: () => Promise<void> | void
  /** Inventory visible when the attempt starts, used to distinguish new ids. */
  visiblePats: readonly PatPublic[]
  /** Refetch and return the latest inventory for unknown-outcome reconciliation. */
  onRefreshInventory: () => Promise<readonly PatPublic[]>
  triggerRef?: RefObject<HTMLElement | null>
}

/** RFC-247 D8 — expiry presets. `never` is offered but is not the default. */
const EXPIRY_DAYS: Record<string, number | null> = {
  '30d': 30,
  '90d': 90,
  '365d': 365,
  never: null,
}
type ExpiryChoice = keyof typeof EXPIRY_DAYS

/**
 * The template row's own value space. `custom` is a READOUT, not a template:
 * it is what the control shows once the grid no longer matches any preset, and
 * it is never selectable — picking it would have no defined meaning.
 */
type TemplateChoice = TemplateId | 'custom'

interface CreatedToken {
  token: string
  pat: PatPublic
}

type TokenDialogState =
  | { phase: 'closed' }
  | { phase: 'recovery-unavailable'; error: unknown }
  | { phase: 'editing'; error: unknown | null }
  | { phase: 'creating'; marker: PatReconciliationMarkerV1 }
  | {
      phase: 'revealed'
      created: CreatedToken
      refreshing: boolean
      refreshError: unknown | null
      markerClearFailed: boolean
    }
  | {
      phase: 'outcome-unknown'
      marker: PatReconciliationMarkerV1 | null
      invalidMarker: boolean
      candidates: PatPublic[]
      refreshing: boolean
      reconciled: boolean
      inventoryError: unknown | null
      clearError: unknown | null
    }

interface ActiveAttempt {
  controller: AbortController
  marker: PatReconciliationMarkerV1
  abandoned: boolean
}

function recoveryState(read: PatReconciliationMarkerRead): TokenDialogState | null {
  if (read.kind === 'valid') {
    return {
      phase: 'outcome-unknown',
      marker: read.marker,
      invalidMarker: false,
      candidates: [],
      refreshing: false,
      reconciled: false,
      inventoryError: null,
      clearError: null,
    }
  }
  if (read.kind === 'invalid') {
    return {
      phase: 'outcome-unknown',
      marker: null,
      invalidMarker: true,
      candidates: [],
      refreshing: false,
      reconciled: false,
      inventoryError: null,
      clearError: null,
    }
  }
  return null
}

function initialState(open: boolean, actorId: string): TokenDialogState {
  const marker = readPatReconciliationMarker(actorId)
  const recovered = recoveryState(marker)
  if (recovered !== null) return recovered
  if (!open) return { phase: 'closed' }
  return marker.kind === 'unavailable'
    ? { phase: 'recovery-unavailable', error: marker.error }
    : { phase: 'editing', error: null }
}

export function CreateTokenDialog({
  open,
  onClose,
  actorId,
  permissions,
  onCreated,
  visiblePats,
  onRefreshInventory,
  triggerRef,
}: CreateTokenDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<PatPurpose>('mcp_only')
  const [selected, setSelected] = useState<ReadonlySet<Permission>>(new Set())
  const [advanced, setAdvanced] = useState(false)
  const [expiry, setExpiry] = useState<ExpiryChoice>('90d')
  const [state, setState] = useState<TokenDialogState>(() => initialState(open, actorId))
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const mountedRef = useRef(true)
  const attemptRef = useRef<ActiveAttempt | null>(null)
  const reconcileGenerationRef = useRef(0)
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const busySinceRef = useRef<number | null>(null)

  const accountPermissions = useMemo(() => new Set(permissions), [permissions])
  const template = matchingTemplate(selected, accountPermissions)
  const hasDelete = selectionHasDelete(selected)
  const creating = state.phase === 'creating'

  dirtyRef.current =
    state.phase === 'revealed'
      ? 'pat:raw-secret'
      : state.phase === 'outcome-unknown'
        ? 'pat:outcome-unknown'
        : null
  busyRef.current = creating
  busySinceRef.current = creating ? state.marker.startedAt : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const attempt = attemptRef.current
      if (attempt !== null) {
        attempt.abandoned = true
        attempt.controller.abort()
      }
    }
  }, [])

  useEffect(() => {
    if (!open || state.phase !== 'closed') return
    setState(initialState(true, actorId))
  }, [actorId, open, state.phase])

  const resetFields = (): void => {
    setName('')
    setPurpose('mcp_only')
    setSelected(new Set())
    setAdvanced(false)
    setExpiry('90d')
    setCopied('idle')
  }

  const closeEditing = (): void => {
    if (state.phase !== 'editing') return
    resetFields()
    setState({ phase: 'closed' })
    onClose()
  }

  const closeRecoveryUnavailable = (): void => {
    if (state.phase !== 'recovery-unavailable') return
    setState({ phase: 'closed' })
    onClose()
  }

  const retryRecoveryRead = (): void => {
    if (state.phase !== 'recovery-unavailable') return
    const marker = readPatReconciliationMarker(actorId)
    const recovered = recoveryState(marker)
    if (recovered !== null) {
      setState(recovered)
      return
    }
    setState(
      marker.kind === 'unavailable'
        ? { phase: 'recovery-unavailable', error: marker.error }
        : open
          ? { phase: 'editing', error: null }
          : { phase: 'closed' },
    )
  }

  const applyTemplate = (id: TemplateId): void => {
    setSelected(new Set(templatePoints(id, accountPermissions)))
  }

  const toggle = (permission: Permission, next: boolean): void => {
    setSelected((prev) => {
      const out = new Set(prev)
      if (next) out.add(permission)
      else out.delete(permission)
      return out
    })
  }

  const reconcileInventory = useCallback(
    async (marker: PatReconciliationMarkerV1 | null): Promise<void> => {
      const generation = ++reconcileGenerationRef.current
      setState((current) =>
        current.phase === 'outcome-unknown'
          ? { ...current, refreshing: true, inventoryError: null, clearError: null }
          : current,
      )
      try {
        const inventory = await onRefreshInventory()
        if (!mountedRef.current || generation !== reconcileGenerationRef.current) return
        setState((current) =>
          current.phase === 'outcome-unknown'
            ? {
                ...current,
                candidates:
                  marker === null ? [] : findPatReconciliationCandidates(marker, inventory),
                refreshing: false,
                reconciled: true,
                inventoryError: null,
              }
            : current,
        )
      } catch (error) {
        if (!mountedRef.current || generation !== reconcileGenerationRef.current) return
        setState((current) =>
          current.phase === 'outcome-unknown'
            ? { ...current, refreshing: false, reconciled: false, inventoryError: error }
            : current,
        )
      }
    },
    [onRefreshInventory],
  )

  useEffect(() => {
    if (
      state.phase !== 'outcome-unknown' ||
      state.refreshing ||
      state.reconciled ||
      state.inventoryError !== null
    )
      return
    void reconcileInventory(state.marker)
  }, [reconcileInventory, state])

  const refreshCreatedInventory = useCallback(
    async (patId: string): Promise<void> => {
      setState((current) =>
        current.phase === 'revealed' && current.created.pat.id === patId
          ? { ...current, refreshing: true, refreshError: null }
          : current,
      )
      try {
        await onCreated()
        if (!mountedRef.current) return
        setState((current) =>
          current.phase === 'revealed' && current.created.pat.id === patId
            ? { ...current, refreshing: false, refreshError: null }
            : current,
        )
      } catch (error) {
        if (!mountedRef.current) return
        setState((current) =>
          current.phase === 'revealed' && current.created.pat.id === patId
            ? { ...current, refreshing: false, refreshError: error }
            : current,
        )
      }
    },
    [onCreated],
  )

  const submit = async (): Promise<void> => {
    if (state.phase !== 'editing' || name.trim() === '') return
    const startedAt = Date.now()
    const days = EXPIRY_DAYS[expiry] ?? null
    const expiresAt = days === null ? null : startedAt + days * 86_400_000
    const marker = createPatReconciliationMarker({
      actorId,
      startedAt,
      name,
      purpose,
      scopes: selected,
      expiresAt,
      visiblePats,
    })
    try {
      writePatReconciliationMarker(marker)
    } catch (error) {
      setState({ phase: 'editing', error })
      return
    }

    const attempt: ActiveAttempt = { controller: new AbortController(), marker, abandoned: false }
    attemptRef.current = attempt
    setState({ phase: 'creating', marker })

    let result: CreatedToken
    try {
      result = await api.post<CreatedToken>(
        '/api/auth/pats',
        {
          name: marker.name,
          scopes: marker.scopes,
          purpose: marker.purpose,
          expiresAt: marker.expiresAt,
        },
        attempt.controller.signal,
      )
    } catch (error) {
      if (!mountedRef.current || attempt.abandoned || attemptRef.current !== attempt) return
      attemptRef.current = null
      if (classifyWriteOutcome(error, { idempotent: false }) === 'definitive') {
        clearPatReconciliationMarker(actorId)
        setState({ phase: 'editing', error })
        return
      }
      setState({
        phase: 'outcome-unknown',
        marker,
        invalidMarker: false,
        candidates: [],
        refreshing: false,
        reconciled: false,
        inventoryError: null,
        clearError: null,
      })
      return
    }

    if (!mountedRef.current || attempt.abandoned || attemptRef.current !== attempt) return
    attemptRef.current = null
    const markerCleared = clearPatReconciliationMarker(actorId)
    setState({
      phase: 'revealed',
      created: result,
      refreshing: true,
      refreshError: null,
      markerClearFailed: !markerCleared,
    })
    void refreshCreatedInventory(result.pat.id)
  }

  const finishRevealed = (): boolean => {
    if (state.phase !== 'revealed') return false
    if (state.markerClearFailed && !clearPatReconciliationMarker(actorId)) return false
    resetFields()
    setState({ phase: 'closed' })
    onClose()
    return true
  }

  const finishUnknown = (): boolean => {
    if (state.phase !== 'outcome-unknown') return false
    if (!clearPatReconciliationMarker(actorId)) {
      setState({
        ...state,
        clearError: new PatReconciliationStorageError('clear'),
      })
      return false
    }
    resetFields()
    setState({ phase: 'closed' })
    onClose()
    return true
  }

  const discardRiskAndClose = (): boolean => {
    if (state.phase === 'revealed') return finishRevealed()
    if (state.phase === 'outcome-unknown') return finishUnknown()
    return false
  }

  const forceLeaveCreating = (): void => {
    const attempt = attemptRef.current
    if (attempt === null) return
    attempt.abandoned = true
    attempt.controller.abort()
  }

  if (state.phase === 'closed') return null

  if (state.phase === 'recovery-unavailable') {
    return (
      <Dialog
        open={open}
        onClose={closeRecoveryUnavailable}
        title={t('account.token.reconcileTitle')}
        size="sm"
        triggerRef={triggerRef}
        data-testid="token-recovery-unavailable-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={closeRecoveryUnavailable}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={retryRecoveryRead}
              data-testid="token-recovery-read-retry"
            >
              {t('account.token.inventoryRefreshRetry')}
            </button>
          </>
        }
      >
        <ErrorBanner
          error={state.error}
          message={t('account.token.markerUnavailable')}
          testid="token-recovery-read-error"
        />
      </Dialog>
    )
  }

  const navigationGuard = (
    <UnsavedChangesGuard
      dirtyRef={dirtyRef}
      busyRef={busyRef}
      busySinceRef={busySinceRef}
      onDiscard={discardRiskAndClose}
      onForceLeave={forceLeaveCreating}
      copyKeys={{
        title: 'account.token.leaveTitle',
        body:
          state.phase === 'revealed'
            ? 'account.token.leaveRevealBody'
            : 'account.token.leaveUnknownBody',
        busyBody: 'account.token.leaveCreatingBody',
        stay: 'account.token.leaveStay',
        discard: 'account.token.leaveDiscard',
        forceLeave: 'account.token.leaveForce',
        forceLeaveWarning: 'account.token.leaveForceWarning',
      }}
    />
  )

  if (state.phase === 'revealed') {
    const { created } = state
    return (
      <>
        <Dialog
          open={open}
          onClose={() => {}}
          title={t('account.token.createdTitle')}
          size="md"
          triggerRef={triggerRef}
          dismissDisabled
          data-testid="token-created-dialog"
          footer={
            <button
              type="button"
              className="btn btn--primary"
              onClick={finishRevealed}
              data-testid="token-created-done"
            >
              {t('common.done')}
            </button>
          }
        >
          <FeedbackStack>
            <NoticeBanner tone="warning">
              <strong>{t('account.token.shownOnceTitle')}</strong>
              <p>{t('account.token.shownOnceDescription')}</p>
            </NoticeBanner>
            {state.markerClearFailed && (
              <ErrorBanner
                error={new PatReconciliationStorageError('clear')}
                message={t('account.token.markerClearFailed')}
              />
            )}
            {state.refreshError !== null && (
              <ErrorBanner
                error={state.refreshError}
                message={t('account.token.inventoryRefreshFailed')}
                onRetry={() => void refreshCreatedInventory(created.pat.id)}
                retryLabel={t('account.token.inventoryRefreshRetry')}
                testid="token-created-refresh-error"
              />
            )}
            {state.refreshing && (
              <p role="status" data-testid="token-created-refreshing">
                {t('account.token.inventoryRefreshing')}
              </p>
            )}
          </FeedbackStack>
          {/* Selectable, not an input: manual selection remains available if
              both browser copy paths fail. lib/clipboard.ts keeps its insecure-
              context fallback inside this Dialog's focus boundary. */}
          <code className="token-reveal" data-testid="token-created-value">
            {created.token}
          </code>
          <div className="token-reveal__actions">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="token-copy"
              onClick={() => {
                void copyText(created.token).then((ok) => setCopied(ok ? 'ok' : 'failed'))
              }}
            >
              {t('account.copy')}
            </button>
            {copied === 'ok' && (
              <span className="token-reveal__status" role="status">
                {t('account.token.copied')}
              </span>
            )}
            {copied === 'failed' && (
              <span className="token-reveal__status token-reveal__status--error" role="status">
                {t('account.token.copyFailed')}
              </span>
            )}
          </div>
        </Dialog>
        {navigationGuard}
      </>
    )
  }

  if (state.phase === 'outcome-unknown') {
    const effectiveOpen = open || state.marker !== null || state.invalidMarker
    return (
      <>
        <Dialog
          open={effectiveOpen}
          onClose={() => {}}
          title={t('account.token.reconcileTitle')}
          size="md"
          triggerRef={triggerRef}
          dismissDisabled
          data-testid="token-outcome-unknown-dialog"
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void reconcileInventory(state.marker)}
                disabled={state.refreshing}
                data-testid="token-reconcile-refresh"
              >
                {t('account.token.reconcileRefresh')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={finishUnknown}
                disabled={state.refreshing || !state.reconciled || state.inventoryError !== null}
                data-testid="token-reconcile-done"
              >
                {t('account.token.reconcileDone')}
              </button>
            </>
          }
        >
          <FeedbackStack>
            <NoticeBanner tone="warning">
              <strong>{t('account.token.reconcileWarningTitle')}</strong>
              <p>{t('account.token.reconcileWarningDescription')}</p>
            </NoticeBanner>
            {state.invalidMarker && (
              <NoticeBanner tone="warning">
                {t('account.token.reconcileInvalidMarker')}
              </NoticeBanner>
            )}
            {state.refreshing && (
              <p role="status" data-testid="token-reconcile-refreshing">
                {t('account.token.inventoryRefreshing')}
              </p>
            )}
            {state.inventoryError !== null && (
              <ErrorBanner
                error={state.inventoryError}
                message={t('account.token.inventoryRefreshFailed')}
                onRetry={() => void reconcileInventory(state.marker)}
                retryLabel={t('account.token.inventoryRefreshRetry')}
                testid="token-reconcile-refresh-error"
              />
            )}
            {state.clearError !== null && (
              <ErrorBanner
                error={state.clearError}
                message={t('account.token.markerClearFailed')}
                testid="token-reconcile-clear-error"
              />
            )}
            {state.reconciled && state.inventoryError === null && (
              <NoticeBanner tone="info" title={t('account.token.reconcileCandidatesTitle')}>
                {state.candidates.length === 0 ? (
                  <p>{t('account.token.reconcileNoCandidates')}</p>
                ) : (
                  <>
                    <p>
                      {t('account.token.reconcileCandidateCount', {
                        count: state.candidates.length,
                      })}
                    </p>
                    <ul className="account-token-list">
                      {state.candidates.map((candidate) => (
                        <li
                          key={candidate.id}
                          className="account-token-list__item"
                          data-testid={`token-reconcile-candidate-${candidate.id}`}
                        >
                          <strong>{candidate.name}</strong>
                          <code>{candidate.id}</code>
                        </li>
                      ))}
                    </ul>
                    <p>{t('account.token.reconcileCandidateAction')}</p>
                  </>
                )}
              </NoticeBanner>
            )}
          </FeedbackStack>
        </Dialog>
        {navigationGuard}
      </>
    )
  }

  const editingError = state.phase === 'editing' ? state.error : null
  return (
    <>
      <Dialog
        open={open}
        onClose={closeEditing}
        title={t('account.token.createTitle')}
        size="lg"
        triggerRef={triggerRef}
        dismissDisabled={creating}
        panelClassName="token-create-dialog"
        data-testid="token-create-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={closeEditing} disabled={creating}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={hasDelete ? 'btn btn--danger' : 'btn btn--primary'}
              disabled={creating || name.trim() === ''}
              onClick={() => void submit()}
              data-testid="token-create-confirm"
            >
              {creating ? t('common.creating') : t('account.token.create')}
            </button>
          </>
        }
      >
        {editingError !== null && (
          <FeedbackStack>
            <ErrorBanner
              error={editingError}
              {...(editingError instanceof PatReconciliationStorageError
                ? { message: t('account.token.markerUnavailable') }
                : {})}
              testid="token-create-error"
            />
          </FeedbackStack>
        )}

        <Field label={t('account.patName')} hint={t('account.token.nameHint')} required>
          <TextInput
            value={name}
            onChange={setName}
            maxLength={128}
            placeholder={t('account.patNamePlaceholder')}
            disabled={creating}
            data-testid="token-create-name"
          />
        </Field>

        <Field
          label={t('account.token.purposeLabel')}
          hint={t(`account.token.purposeHint.${purpose}`)}
          group
          labelId="token-purpose-label"
        >
          <Segmented<PatPurpose>
            value={purpose}
            onChange={setPurpose}
            ariaLabel={t('account.token.purposeLabel')}
            testidPrefix="token-purpose"
            disabled={creating}
            options={[
              { value: 'mcp_only', label: t('account.token.purpose.mcp_only') },
              { value: 'general', label: t('account.token.purpose.general') },
            ]}
          />
        </Field>

        <Field
          label={t('account.token.templateLabel')}
          hint={t('account.token.templateHint')}
          group
          labelId="token-template-label"
        >
          <Segmented<TemplateChoice>
            // A selection that matches no template still has to render something.
            // Falling back to a phantom "read-only" would tick the least
            // capable option on the most capable selection; `custom` is a real
            // state and says so.
            value={template ?? 'custom'}
            onChange={(id) => {
              if (id !== 'custom') applyTemplate(id)
            }}
            allowActiveReselect
            ariaLabel={t('account.token.templateLabel')}
            testidPrefix="token-template"
            disabled={creating}
            options={[
              { value: 'read-only', label: t('account.token.template.read-only') },
              { value: 'task-automation', label: t('account.token.template.task-automation') },
              { value: 'full', label: t('account.token.template.full') },
              // Not pickable — it describes the grid rather than setting it.
              { value: 'custom', label: t('account.token.template.custom'), disabled: true },
            ]}
          />
        </Field>

        <details
          className="account-technical-details"
          open={advanced}
          onToggle={(event) => {
            if (!creating) setAdvanced((event.currentTarget as HTMLDetailsElement).open)
          }}
        >
          <summary
            data-testid="token-advanced-toggle"
            aria-disabled={creating}
            tabIndex={creating ? -1 : undefined}
            onClick={(event) => {
              if (creating) event.preventDefault()
            }}
          >
            {t('account.token.advanced')}
          </summary>
          <p className="form-field__hint">{t('account.token.advancedHint')}</p>
          <TokenPermissionMatrix
            accountPermissions={accountPermissions}
            selected={selected}
            onToggle={toggle}
            disabled={creating}
            testidPrefix="token-matrix"
          />
        </details>

        {hasDelete && (
          <NoticeBanner tone="warning" testid="token-delete-warning">
            <strong>{t('account.token.deleteWarningTitle')}</strong>
            <p>
              {t('account.token.deleteWarningDescription', {
                points: [...selected]
                  .filter((p) => DELETE_POINTS.includes(p))
                  .sort()
                  .join(', '),
              })}
            </p>
          </NoticeBanner>
        )}

        <Field label={t('account.token.expiryLabel')} hint={t('account.token.expiryHint')}>
          <Select<ExpiryChoice>
            value={expiry}
            onChange={setExpiry}
            ariaLabel={t('account.token.expiryLabel')}
            data-testid="token-expiry"
            disabled={creating}
            options={[
              { value: '30d', label: t('account.token.expiry.30d') },
              { value: '90d', label: t('account.token.expiry.90d') },
              { value: '365d', label: t('account.token.expiry.365d') },
              { value: 'never', label: t('account.token.expiry.never') },
            ]}
          />
        </Field>
      </Dialog>
      {navigationGuard}
    </>
  )
}
