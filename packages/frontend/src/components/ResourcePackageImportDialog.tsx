import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { commitResourcePackage, previewResourcePackage } from '@/api/resourcePackages'
import type {
  HumanMemberMapping,
  HumanMemberSlot,
  ImportAction,
  ImportDecision,
  PackageImportReceipt,
  PackagePreview,
  PackagePreviewEntry,
  PackageRequirements,
  PackageSecretInput,
  PackageSecretRef,
  ResourcePackageType,
} from '@/api/resourcePackages'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { FileDropzone } from '@/components/FileDropzone'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { UserPicker } from '@/components/UserPicker'

const RESOURCE_PACKAGE_COLLECTION_KEYS = [
  ['agents'],
  ['skills'],
  ['mcps'],
  ['plugins'],
  ['workflows'],
  ['workgroups'],
] as const

type Phase = 'pick' | 'previewing' | 'decide' | 'committing' | 'done'
type CommitRecovery = 'retry' | 'repreview' | null
type HumanMappingDraft = { action: 'map' | 'skip'; picked: UserPublic[]; touched: boolean }
interface HumanMappingSlot {
  workgroupSlug: string
  username: string
  displayNames: string[]
  suggestedUserId: string | null
  required: boolean
}
interface DecisionDraft extends ImportDecision {
  targetByAction?: Partial<Record<'reuse' | 'overwrite', string>>
}

const PREVIEW_EXPIRING_WINDOW_MS = 5 * 60_000
const REPREVIEW_ERROR_CODES = new Set([
  'package-preview-expired',
  'package-selected-target-gone',
  'package-selected-target-changed',
  'package-write-forbidden',
])

function commitRecoveryFor(error: unknown): CommitRecovery {
  if (!(error instanceof ApiError)) return 'retry'
  if (REPREVIEW_ERROR_CODES.has(error.code)) return 'repreview'
  if (error.status === 0 || error.status >= 500) return 'retry'
  return null
}

function humanSlotKey(slot: Pick<HumanMemberSlot, 'workgroupSlug' | 'username'>): string {
  return `${slot.workgroupSlug}\u0000${slot.username}`
}

function secretRefKey(ref: PackageSecretRef): string {
  return JSON.stringify([ref.resourceType, ref.resourceName, ref.field])
}

function secretIsRequired(ref: PackageSecretRef): boolean {
  return ref.field === 'config.url' || ref.field === 'spec'
}

function openImportedRoot(
  navigate: ReturnType<typeof useNavigate>,
  root: NonNullable<PackageImportReceipt['root']>,
): void {
  switch (root.resourceType) {
    case 'agent':
      void navigate({ to: '/agents/$id', params: { id: root.resourceId } })
      break
    case 'skill':
      void navigate({ to: '/skills/$id', params: { id: root.resourceId } })
      break
    case 'mcp':
      void navigate({ to: '/mcps/$id', params: { id: root.resourceId } })
      break
    case 'plugin':
      void navigate({ to: '/plugins/$id', params: { id: root.resourceId } })
      break
    case 'workflow':
      void navigate({ to: '/workflows/$id', params: { id: root.resourceId } })
      break
    case 'workgroup':
      void navigate({ to: '/workgroups/$id', params: { id: root.resourceId } })
      break
  }
}

/**
 * Mapping identity is the source account within one workgroup. A valid group can
 * use the same human in several member roles (distinct display names), so the UI
 * must ask once and apply that answer to every role instead of sending duplicate
 * decisions the commit contract rejects.
 */
function normalizeHumanSlots(slots: readonly HumanMemberSlot[]): HumanMappingSlot[] {
  const merged = new Map<string, HumanMappingSlot>()
  for (const slot of slots) {
    const key = humanSlotKey(slot)
    const current = merged.get(key)
    if (current === undefined) {
      merged.set(key, {
        workgroupSlug: slot.workgroupSlug,
        username: slot.username,
        displayNames: [slot.displayName],
        suggestedUserId: slot.suggestedUserId,
        required: slot.required,
      })
      continue
    }
    if (!current.displayNames.includes(slot.displayName))
      current.displayNames.push(slot.displayName)
    current.required ||= slot.required
    current.suggestedUserId ??= slot.suggestedUserId
  }
  return [...merged.values()]
}

function emptyHumanMappings(slots: readonly HumanMappingSlot[]): Record<string, HumanMappingDraft> {
  return Object.fromEntries(
    slots.map((slot) => [
      humanSlotKey(slot),
      { action: 'map' as const, picked: [], touched: false },
    ]),
  )
}

async function initialHumanMappings(
  slots: readonly HumanMappingSlot[],
  signal: AbortSignal,
): Promise<Record<string, HumanMappingDraft>> {
  const suggested = new Map<string, UserPublic>()
  const suggestedIds = [
    ...new Set(slots.map((slot) => slot.suggestedUserId).filter((id): id is string => id !== null)),
  ]
  const batches = Array.from({ length: Math.ceil(suggestedIds.length / 200) }, (_, index) =>
    suggestedIds.slice(index * 200, (index + 1) * 200),
  )
  await Promise.all(
    batches.map(async (ids) => {
      try {
        const users = await api.post<UserPublic[]>('/api/users/lookup', { ids }, signal)
        for (const user of users) {
          if (user.status === 'active') suggested.set(user.id, user)
        }
      } catch {
        // Suggestion hydration is convenience only. The picker remains usable.
      }
    }),
  )
  return Object.fromEntries(
    slots.map((slot) => {
      const match = slot.suggestedUserId === null ? undefined : suggested.get(slot.suggestedUserId)
      return [
        humanSlotKey(slot),
        {
          action: 'map' as const,
          picked: match === undefined ? [] : [match],
          touched: false,
        },
      ]
    }),
  )
}

export interface ResourcePackageImportPanelHandle {
  /** Returns false while commit owns an in-flight transaction. */
  discard: () => boolean
}

export interface ResourcePackageImportPanelProps {
  onImported?: (receipt: PackageImportReceipt) => void
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  /** Outcome-unknown retries must keep the same idempotency session mounted. */
  onOutcomeUnknownChange?: (outcomeUnknown: boolean) => void
  beginCommitBusy?: () => () => void
  /**
   * Runs after the commit busy token has been released and immediately before
   * an expected-root mismatch is opened. Split routes use this synchronous hook
   * to clear their package dirty ref; returning false keeps the receipt visible
   * when another creation draft is still dirty.
   */
  prepareAutoOpen?: () => boolean
  expectedRootType?: ResourcePackageType
}

function candidateOptions(entry: PackagePreviewEntry, action: ImportAction) {
  return action === 'overwrite'
    ? entry.candidates.filter((candidate) => candidate.owned)
    : entry.candidates
}

function initialDecision(entry: PackagePreviewEntry): DecisionDraft {
  const action =
    entry.defaultAction !== null && entry.allowedActions.includes(entry.defaultAction)
      ? entry.defaultAction
      : entry.allowedActions.includes('reuse')
        ? 'reuse'
        : entry.allowedActions.includes('new')
          ? 'new'
          : entry.allowedActions[0]
  if (action === 'reuse' || action === 'overwrite') {
    const targets = candidateOptions(entry, action)
    const targetId = targets.length === 1 ? targets[0]!.id : undefined
    return {
      localSlug: entry.localSlug,
      action,
      ...(targetId === undefined ? {} : { targetId, targetByAction: { [action]: targetId } }),
    }
  }
  return {
    localSlug: entry.localSlug,
    action: 'new',
    finalName: entry.suggestedName,
  }
}

function reconcileDecision(
  entry: PackagePreviewEntry,
  previous: DecisionDraft | undefined,
): DecisionDraft {
  if (previous === undefined || !entry.allowedActions.includes(previous.action)) {
    return initialDecision(entry)
  }
  if (previous.action === 'new') {
    return {
      ...previous,
      localSlug: entry.localSlug,
      finalName: previous.finalName ?? entry.suggestedName,
      targetId: undefined,
    }
  }
  const targetId = candidateOptions(entry, previous.action).some(
    (candidate) => candidate.id === previous.targetId,
  )
    ? previous.targetId
    : undefined
  return { ...previous, localSlug: entry.localSlug, targetId }
}

function decisionComplete(
  entry: PackagePreviewEntry,
  decision: ImportDecision | undefined,
): boolean {
  if (decision === undefined || !entry.allowedActions.includes(decision.action)) return false
  if (decision.action === 'new') return (decision.finalName ?? '').trim() !== ''
  return candidateOptions(entry, decision.action).some(
    (candidate) => candidate.id === decision.targetId,
  )
}

function decisionMaterializes(
  entry: PackagePreviewEntry,
  decision: ImportDecision | undefined,
): boolean {
  return (
    decision !== undefined &&
    decision.action !== 'reuse' &&
    entry.allowedActions.includes(decision.action)
  )
}

function requirementGroups(
  requirements: PackageRequirements,
): Array<{ key: keyof PackageRequirements; values: string[] }> {
  const strings = (
    key: Exclude<keyof PackageRequirements, 'pluginSources'>,
  ): Array<{ key: keyof PackageRequirements; values: string[] }> => {
    const values = requirements[key]
    return Array.isArray(values) && values.length > 0 ? [{ key, values }] : []
  }
  const pluginSources = (requirements.pluginSources ?? []).map(
    (source) => `${source.name} · ${source.sourceKind} · ${source.spec}`,
  )
  return [
    ...strings('runtimes'),
    ...strings('codeHosts'),
    ...strings('executables'),
    ...(pluginSources.length > 0 ? [{ key: 'pluginSources' as const, values: pluginSources }] : []),
    ...strings('projectSkills'),
    ...strings('mcpKinds'),
    ...strings('humanMembers'),
  ]
}

export const ResourcePackageImportPanel = forwardRef<
  ResourcePackageImportPanelHandle,
  ResourcePackageImportPanelProps
>(function ResourcePackageImportPanel(props, ref): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { onImported, onDirtyChange, onBusyChange, onOutcomeUnknownChange, beginCommitBusy } = props
  const [phase, setPhase] = useState<Phase>('pick')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, DecisionDraft>>({})
  const [humanMappings, setHumanMappings] = useState<Record<string, HumanMappingDraft>>({})
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [pendingFileChange, setPendingFileChange] = useState<{ file: File | null } | null>(null)
  const [receipt, setReceipt] = useState<PackageImportReceipt | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [commitRecovery, setCommitRecovery] = useState<CommitRecovery>(null)
  const [previewExpiring, setPreviewExpiring] = useState(false)
  const requestGenerationRef = useRef(0)
  const previewAbortRef = useRef<AbortController | null>(null)
  const commitPendingRef = useRef(false)
  const mountedRef = useRef(false)
  const phaseHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const fileChangeTriggerRef = useRef<HTMLElement | null>(null)
  const humanMappingsTitleId = useId()

  const updateCommitRecovery = useCallback(
    (next: CommitRecovery): void => {
      setCommitRecovery(next)
      // Parent surfaces must lock their own dismiss/navigation affordances in
      // the same update as the retry state; a passive effect leaves one paint
      // where an outcome-unknown import can still be unmounted.
      onOutcomeUnknownChange?.(next === 'retry')
    },
    [onOutcomeUnknownChange],
  )

  const reset = useCallback((): void => {
    requestGenerationRef.current += 1
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    commitPendingRef.current = false
    setPhase('pick')
    setFile(null)
    setFileError(null)
    setPreview(null)
    setDecisions({})
    setHumanMappings({})
    setSecretValues({})
    setPendingFileChange(null)
    setReceipt(null)
    setError(null)
    updateCommitRecovery(null)
    setPreviewExpiring(false)
  }, [updateCommitRecovery])

  useImperativeHandle(
    ref,
    () => ({
      discard: () => {
        if (commitPendingRef.current || commitRecovery === 'retry') return false
        reset()
        return true
      },
    }),
    [commitRecovery, reset],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      previewAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    // Preview is cancelable: closing/unmounting aborts it. Only commit owns a
    // transaction whose outcome must not be obscured by dismissing the surface.
    onBusyChange?.(phase === 'committing')
  }, [onBusyChange, phase])

  useEffect(() => {
    onDirtyChange?.(file !== null && phase !== 'done')
  }, [file, onDirtyChange, phase])

  useEffect(() => {
    onOutcomeUnknownChange?.(commitRecovery === 'retry')
  }, [commitRecovery, onOutcomeUnknownChange])

  useEffect(() => {
    if (phase !== 'decide' && phase !== 'done') return
    queueMicrotask(() => phaseHeadingRef.current?.focus())
  }, [phase])

  useEffect(() => {
    if (preview === null || phase !== 'decide') {
      setPreviewExpiring(false)
      return
    }
    const delay = preview.expiresAt - Date.now() - PREVIEW_EXPIRING_WINDOW_MS
    if (delay <= 0) {
      setPreviewExpiring(true)
      return
    }
    setPreviewExpiring(false)
    const timeout = window.setTimeout(() => setPreviewExpiring(true), delay)
    return () => window.clearTimeout(timeout)
  }, [phase, preview])

  const applyFileChange = (nextFile: File | null): void => {
    requestGenerationRef.current += 1
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    setPreview(null)
    setDecisions({})
    setHumanMappings({})
    setSecretValues({})
    setReceipt(null)
    setError(null)
    updateCommitRecovery(null)
    setPreviewExpiring(false)
    if (nextFile !== null && !nextFile.name.toLowerCase().endsWith('.zip')) {
      setFile(null)
      setFileError(t('resourcePackage.invalidFile'))
      setPhase('pick')
      return
    }
    setFile(nextFile)
    setFileError(null)
    setPhase('pick')
  }

  const chooseFile = (nextFile: File | null): void => {
    if (phase === 'decide') {
      fileChangeTriggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPendingFileChange({ file: nextFile })
      return
    }
    applyFileChange(nextFile)
  }

  const runPreview = async (preserveDrafts = false): Promise<void> => {
    if (file === null || fileError !== null || phase === 'previewing') return
    const previousDecisions = decisions
    const previousHumanMappings = humanMappings
    const previousSecretValues = secretValues
    const generation = ++requestGenerationRef.current
    const abort = new AbortController()
    previewAbortRef.current?.abort()
    previewAbortRef.current = abort
    setError(null)
    updateCommitRecovery(null)
    setPhase('previewing')
    try {
      const next = await previewResourcePackage(file, abort.signal)
      if (
        !mountedRef.current ||
        abort.signal.aborted ||
        requestGenerationRef.current !== generation
      )
        return
      setPreview(next)
      setDecisions(
        Object.fromEntries(
          next.entries.map((entry) => [
            entry.localSlug,
            preserveDrafts
              ? reconcileDecision(entry, previousDecisions[entry.localSlug])
              : initialDecision(entry),
          ]),
        ),
      )
      const humanSlots = normalizeHumanSlots(next.humanMembers ?? [])
      setHumanMappings(
        preserveDrafts
          ? Object.fromEntries(
              humanSlots.map((slot) => {
                const key = humanSlotKey(slot)
                const previous = previousHumanMappings[key]
                return [
                  key,
                  previous === undefined || (slot.required && previous.action === 'skip')
                    ? { action: 'map' as const, picked: [], touched: previous?.touched ?? false }
                    : previous,
                ]
              }),
            )
          : emptyHumanMappings(humanSlots),
      )
      setSecretValues(
        Object.fromEntries(
          next.secrets.map((secret) => {
            const key = secretRefKey(secret)
            return [key, preserveDrafts ? (previousSecretValues[key] ?? '') : '']
          }),
        ),
      )
      // Preview is already useful. Do not hold the dialog in a locked loading
      // state while the optional display data for suggested users is hydrated.
      setPhase('decide')
      const hydratedMappings = await initialHumanMappings(humanSlots, abort.signal)
      if (
        !mountedRef.current ||
        abort.signal.aborted ||
        requestGenerationRef.current !== generation
      )
        return
      setHumanMappings((current) =>
        Object.fromEntries(
          humanSlots.map((slot) => {
            const key = humanSlotKey(slot)
            const existing = current[key]
            const hydrated = hydratedMappings[key]
            return [
              key,
              existing?.touched === true
                ? existing
                : (hydrated ?? existing ?? { action: 'map', picked: [], touched: false }),
            ]
          }),
        ),
      )
    } catch (nextError) {
      if (
        !mountedRef.current ||
        abort.signal.aborted ||
        requestGenerationRef.current !== generation
      )
        return
      setError(nextError)
      setPhase('pick')
    } finally {
      if (previewAbortRef.current === abort) previewAbortRef.current = null
    }
  }

  const setAction = (entry: PackagePreviewEntry, action: ImportAction): void => {
    const targets = candidateOptions(entry, action)
    setDecisions((previous) => {
      const current = previous[entry.localSlug]
      const targetByAction =
        current !== undefined && current.action !== 'new' && current.targetId !== undefined
          ? { ...current.targetByAction, [current.action]: current.targetId }
          : (current?.targetByAction ?? {})
      if (action === 'new') {
        return {
          ...previous,
          [entry.localSlug]: {
            ...current,
            localSlug: entry.localSlug,
            action,
            finalName: current?.finalName ?? entry.suggestedName,
            targetId: undefined,
            targetByAction,
          },
        }
      }
      const rememberedTarget = targetByAction[action]
      const targetId = targets.some((candidate) => candidate.id === rememberedTarget)
        ? rememberedTarget
        : targets.length === 1
          ? targets[0]!.id
          : undefined
      return {
        ...previous,
        [entry.localSlug]: {
          ...current,
          localSlug: entry.localSlug,
          action,
          targetId,
          targetByAction,
        },
      }
    })
  }

  const humanSlots = normalizeHumanSlots(preview?.humanMembers ?? [])
  const visibleRequirements = requirementGroups(preview?.requirements ?? {})
  const entryBySlug = new Map(preview?.entries.map((entry) => [entry.localSlug, entry]) ?? [])
  const activeSecretKeys = new Set(
    preview?.entries.flatMap((entry) =>
      decisionMaterializes(entry, decisions[entry.localSlug])
        ? (entry.secretFields ?? []).map(secretRefKey)
        : [],
    ) ?? [],
  )
  const activeSecrets =
    preview?.secrets.filter((secret) => activeSecretKeys.has(secretRefKey(secret))) ?? []
  const activeHumanSlots = humanSlots.filter((slot) => {
    const entry = entryBySlug.get(slot.workgroupSlug)
    return entry !== undefined && decisionMaterializes(entry, decisions[slot.workgroupSlug])
  })
  const humanMappingsComplete =
    preview !== null &&
    activeHumanSlots.every((slot) => {
      const mapping = humanMappings[humanSlotKey(slot)]
      if (mapping === undefined) return false
      if (mapping.action === 'skip') return !slot.required
      return mapping.picked.length === 1 && mapping.picked[0]?.status === 'active'
    })
  const requiredSecretsComplete =
    preview !== null &&
    activeSecrets.every(
      (secret) => !secretIsRequired(secret) || (secretValues[secretRefKey(secret)] ?? '') !== '',
    )

  const canCommit =
    preview !== null &&
    preview.entries.length > 0 &&
    preview.entries.every((entry) => decisionComplete(entry, decisions[entry.localSlug])) &&
    humanMappingsComplete &&
    requiredSecretsComplete &&
    commitRecovery !== 'repreview'

  const outcomeUnknown = commitRecovery === 'retry'

  const runCommit = async (): Promise<void> => {
    if (file === null || preview === null || !canCommit || commitPendingRef.current) return
    commitPendingRef.current = true
    const generation = requestGenerationRef.current
    const releaseBusy = beginCommitBusy?.()
    let autoOpenRoot: NonNullable<PackageImportReceipt['root']> | null = null
    setError(null)
    setPhase('committing')
    try {
      const mappedHumans: HumanMemberMapping[] = activeHumanSlots.map((slot) => {
        const mapping = humanMappings[humanSlotKey(slot)]!
        return {
          workgroupSlug: slot.workgroupSlug,
          username: slot.username,
          userId: mapping.action === 'skip' ? null : mapping.picked[0]!.id,
        }
      })
      const committedDecisions: ImportDecision[] = preview.entries.map((entry) => {
        const decision = decisions[entry.localSlug]!
        return decision.action === 'new'
          ? {
              localSlug: decision.localSlug,
              action: decision.action,
              finalName: decision.finalName,
            }
          : {
              localSlug: decision.localSlug,
              action: decision.action,
              targetId: decision.targetId,
            }
      })
      const secretInputs: PackageSecretInput[] = preview.secrets.map((secret) => ({
        ...secret,
        value: secretValues[secretRefKey(secret)] ?? '',
      }))
      const out = await commitResourcePackage(
        file,
        preview,
        committedDecisions,
        mappedHumans,
        secretInputs,
      )
      if (!mountedRef.current || requestGenerationRef.current !== generation) return
      setReceipt(out)
      updateCommitRecovery(null)
      setPhase('done')
      for (const queryKey of RESOURCE_PACKAGE_COLLECTION_KEYS) {
        void qc.invalidateQueries({ queryKey: [...queryKey] })
      }
      onImported?.(out)
      if (
        props.expectedRootType !== undefined &&
        out.root !== undefined &&
        out.root.resourceType !== props.expectedRootType &&
        (out.skippedSecrets?.length ?? 0) === 0
      ) {
        autoOpenRoot = out.root
      }
    } catch (nextError) {
      if (!mountedRef.current || requestGenerationRef.current !== generation) return
      setError(nextError)
      updateCommitRecovery(commitRecoveryFor(nextError))
      setPhase('decide')
    } finally {
      commitPendingRef.current = false
      releaseBusy?.()
    }
    if (
      autoOpenRoot !== null &&
      mountedRef.current &&
      requestGenerationRef.current === generation
    ) {
      // The panel's passive dirty effect is too late for TanStack Router's
      // synchronous blocker. Give split routes a same-tick handshake after the
      // busy token is released; routes with another dirty creation draft keep
      // the receipt visible instead of discarding that draft.
      onDirtyChange?.(false)
      if (props.prepareAutoOpen?.() !== false) openImportedRoot(navigate, autoOpenRoot)
    }
  }

  const reusedCount = Object.values(decisions).filter(
    (decision) => decision.action === 'reuse',
  ).length

  return (
    <div
      className="resource-package-import-flow"
      aria-busy={phase === 'previewing' || phase === 'committing'}
    >
      {error !== null ? <ErrorBanner error={error} /> : null}

      {phase !== 'done' ? (
        <FileDropzone
          file={file}
          onFileChange={chooseFile}
          accept=".zip,application/zip"
          disabled={phase === 'previewing' || phase === 'committing' || outcomeUnknown}
          title={t('resourcePackage.dropTitle')}
          description={t('resourcePackage.fileHint')}
          chooseLabel={t('resourcePackage.chooseFile')}
          replaceLabel={t('resourcePackage.replaceFile')}
          removeLabel={t('resourcePackage.removeFile')}
          error={fileError ?? undefined}
          data-testid="package-import-file"
        />
      ) : null}

      {phase === 'pick' ? (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={file === null || fileError !== null}
            onClick={() => void runPreview()}
            data-testid="package-import-preview"
          >
            {t('resourcePackage.reviewPackage')}
          </button>
        </div>
      ) : null}

      {phase === 'previewing' || phase === 'committing' ? (
        <LoadingState
          label={t(
            phase === 'previewing' ? 'resourcePackage.previewing' : 'resourcePackage.importing',
          )}
        />
      ) : null}

      {phase === 'decide' && preview !== null ? (
        <>
          <h2 ref={phaseHeadingRef} tabIndex={-1} className="sr-only">
            {t('resourcePackage.reviewTitle')}
          </h2>
          {activeSecrets.length > 0 ? (
            <Card
              title={t('resourcePackage.secretsTitle')}
              className="resource-package-import-flow__secrets"
            >
              <NoticeBanner tone="warning" size="compact" testid="package-import-secrets">
                {t('resourcePackage.secretsNotice', { count: activeSecrets.length })}
              </NoticeBanner>
              <div className="resource-package-import-flow__secret-fields">
                {activeSecrets.map((secret, index) => {
                  const key = secretRefKey(secret)
                  const required = secretIsRequired(secret)
                  return (
                    <Field
                      key={key}
                      label={t('resourcePackage.secretFieldLabel', {
                        type: t(`resourcePackage.type.${secret.resourceType}`),
                        name: secret.resourceName,
                        field: secret.field,
                      })}
                      required={required}
                      hint={t(
                        required
                          ? 'resourcePackage.secretRequiredHint'
                          : 'resourcePackage.secretOptionalHint',
                      )}
                    >
                      <TextInput
                        type="password"
                        autoComplete="new-password"
                        required={required}
                        disabled={outcomeUnknown}
                        value={secretValues[key] ?? ''}
                        onChange={(value) =>
                          setSecretValues((current) => ({ ...current, [key]: value }))
                        }
                        data-testid={`package-secret-${index}`}
                      />
                    </Field>
                  )
                })}
              </div>
            </Card>
          ) : null}
          {props.expectedRootType !== undefined && preview.root.type !== props.expectedRootType ? (
            <NoticeBanner
              tone="info"
              title={t('resourcePackage.rootMismatchTitle')}
              testid="package-import-root-mismatch"
            >
              {t('resourcePackage.rootMismatchBody', {
                expected: t(`resourcePackage.type.${props.expectedRootType}`),
                actual: t(`resourcePackage.type.${preview.root.type}`),
                name: preview.root.name,
              })}
            </NoticeBanner>
          ) : null}
          {visibleRequirements.length > 0 ? (
            <Card
              title={t('resourcePackage.requirementsTitle')}
              className="resource-package-import-flow__requirements"
            >
              <p className="page__hint">{t('resourcePackage.requirementsHint')}</p>
              <dl>
                {visibleRequirements.map((group) => (
                  <div key={group.key}>
                    <dt>{t(`resourcePackage.requirement.${group.key}`)}</dt>
                    <dd>{group.values.join(', ')}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ) : null}
          {commitRecovery === 'retry' ? (
            <NoticeBanner
              tone="warning"
              title={t('resourcePackage.retryCurrentTitle')}
              testid="package-import-retry-notice"
            >
              {t('resourcePackage.retryCurrentBody')}
            </NoticeBanner>
          ) : null}
          {commitRecovery !== 'retry' && (commitRecovery === 'repreview' || previewExpiring) ? (
            <NoticeBanner
              tone="warning"
              title={t(
                commitRecovery === 'repreview'
                  ? 'resourcePackage.repreviewRequiredTitle'
                  : 'resourcePackage.previewExpiringTitle',
              )}
              testid="package-import-repreview-notice"
            >
              <p>
                {t(
                  commitRecovery === 'repreview'
                    ? 'resourcePackage.repreviewRequiredBody'
                    : 'resourcePackage.previewExpiringBody',
                )}
              </p>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runPreview(true)}
                data-testid="package-import-repreview"
              >
                {t('resourcePackage.repreviewAction')}
              </button>
            </NoticeBanner>
          ) : null}
          {activeHumanSlots.length > 0 ? (
            <section
              className="resource-package-import-flow__human-mappings"
              aria-labelledby={humanMappingsTitleId}
            >
              <h3 id={humanMappingsTitleId}>{t('resourcePackage.humanMappingsTitle')}</h3>
              <NoticeBanner tone="info" size="compact">
                {t('resourcePackage.humanMappingsHint')}
              </NoticeBanner>
              <div className="resource-package-import-flow__entries">
                {activeHumanSlots.map((slot, index) => {
                  const key = humanSlotKey(slot)
                  const mapping = humanMappings[key] ?? {
                    action: 'map',
                    picked: [],
                    touched: false,
                  }
                  const selected = mapping.picked[0]
                  const targetLabelId = `${humanMappingsTitleId}-target-${index}`
                  const targetErrorId = `${humanMappingsTitleId}-target-error-${index}`
                  const targetInvalid = selected === undefined || selected.status !== 'active'
                  const workgroupEntry = preview.entries.find(
                    (entry) => entry.type === 'workgroup' && entry.localSlug === slot.workgroupSlug,
                  )
                  const workgroupDecision = decisions[slot.workgroupSlug]
                  const workgroupName =
                    workgroupDecision?.action === 'new'
                      ? (workgroupDecision.finalName ?? workgroupEntry?.suggestedName)
                      : workgroupEntry?.candidates.find(
                          (candidate) => candidate.id === workgroupDecision?.targetId,
                        )?.name
                  return (
                    <Card
                      key={key}
                      title={`@${slot.username}`}
                      actions={
                        <StatusChip kind={slot.required ? 'warn' : 'neutral'} size="sm">
                          {t(
                            slot.required
                              ? 'resourcePackage.humanRequired'
                              : 'resourcePackage.humanOptional',
                          )}
                        </StatusChip>
                      }
                      className="resource-package-import-flow__entry"
                    >
                      <div className="resource-package-import-flow__entry-fields">
                        <p className="muted resource-package-import-flow__human-source">
                          {t('resourcePackage.humanSource', {
                            workgroup: workgroupName ?? workgroupEntry?.name ?? slot.workgroupSlug,
                            names: slot.displayNames.join(', '),
                          })}
                        </p>
                        {!slot.required ? (
                          <Segmented<'map' | 'skip'>
                            value={mapping.action}
                            onChange={(action) =>
                              setHumanMappings((previous) => ({
                                ...previous,
                                [key]: { ...mapping, action, touched: true },
                              }))
                            }
                            options={[
                              { value: 'map', label: t('resourcePackage.humanMap') },
                              { value: 'skip', label: t('resourcePackage.humanSkip') },
                            ]}
                            ariaLabel={t('resourcePackage.humanActionLabel', {
                              username: slot.username,
                            })}
                            testidPrefix={`package-human-action-${index}`}
                            disabled={outcomeUnknown}
                          />
                        ) : null}
                        {mapping.action === 'map' ? (
                          <Field
                            label={t('resourcePackage.humanTarget', { username: slot.username })}
                            required
                            group
                            labelId={targetLabelId}
                            error={
                              targetInvalid
                                ? t('resourcePackage.humanTargetRequired', {
                                    username: slot.username,
                                  })
                                : undefined
                            }
                            errorId={targetErrorId}
                            errorLive={false}
                          >
                            <UserPicker
                              value={mapping.picked}
                              single
                              activeOnly
                              disabled={outcomeUnknown}
                              aria-labelledby={targetLabelId}
                              aria-describedby={targetInvalid ? targetErrorId : undefined}
                              aria-required
                              aria-invalid={targetInvalid}
                              placeholder={t('resourcePackage.humanTargetPlaceholder')}
                              testidPrefix={`package-human-target-${index}`}
                              onChange={(picked) =>
                                setHumanMappings((previous) => ({
                                  ...previous,
                                  [key]: { action: 'map', picked, touched: true },
                                }))
                              }
                            />
                            {selected !== undefined ? (
                              <span className="page__hint">
                                {selected.displayName} · @{selected.username}
                              </span>
                            ) : null}
                          </Field>
                        ) : (
                          <NoticeBanner tone="warning" size="compact">
                            {t('resourcePackage.humanSkipped', { username: slot.username })}
                          </NoticeBanner>
                        )}
                      </div>
                    </Card>
                  )
                })}
              </div>
            </section>
          ) : null}
          {preview.entries.length === 0 ? (
            <EmptyState title={t('resourcePackage.emptyPackage')} />
          ) : (
            <div className="resource-package-import-flow__entries">
              {preview.entries.map((entry) => {
                const decision = decisions[entry.localSlug]
                const targets =
                  decision === undefined ? [] : candidateOptions(entry, decision.action)
                return (
                  <Card
                    key={entry.localSlug}
                    title={entry.name}
                    actions={
                      <StatusChip kind="neutral" size="sm">
                        {t(`resourcePackage.type.${entry.type}`)}
                      </StatusChip>
                    }
                    className="resource-package-import-flow__entry"
                  >
                    <div className="resource-package-import-flow__entry-fields">
                      {entry.allowedActions.length === 0 ? (
                        <NoticeBanner
                          tone="error"
                          size="compact"
                          title={t('resourcePackage.permissionBlockedTitle')}
                          testid={`package-permission-blocked-${entry.localSlug}`}
                        >
                          {t('resourcePackage.permissionBlockedBody', {
                            permissions: entry.missingPermissions.join(', '),
                          })}
                        </NoticeBanner>
                      ) : (
                        <Segmented<ImportAction>
                          value={
                            decision?.action ??
                            entry.defaultAction ??
                            entry.allowedActions[0] ??
                            'new'
                          }
                          onChange={(action) => setAction(entry, action)}
                          options={entry.allowedActions.map((action) => ({
                            value: action,
                            label: t(`resourcePackage.action.${action}`),
                            testid: `package-action-${entry.localSlug}-${action}`,
                          }))}
                          ariaLabel={t('resourcePackage.actionLabel', { name: entry.name })}
                          disabled={outcomeUnknown}
                        />
                      )}
                      {entry.allowedActions.length > 0 && decision?.action === 'new' ? (
                        <Field label={t('resourcePackage.finalName')} required>
                          <TextInput
                            value={decision.finalName ?? ''}
                            disabled={outcomeUnknown}
                            data-testid={`package-name-${entry.localSlug}`}
                            onChange={(finalName) =>
                              setDecisions((previous) => ({
                                ...previous,
                                [entry.localSlug]: { ...previous[entry.localSlug]!, finalName },
                              }))
                            }
                          />
                        </Field>
                      ) : entry.allowedActions.length > 0 ? (
                        <Field
                          label={t('resourcePackage.target')}
                          required
                          hint={
                            targets.length > 1 ? t('resourcePackage.chooseTargetHint') : undefined
                          }
                        >
                          <Select
                            value={decision?.targetId ?? ''}
                            disabled={outcomeUnknown}
                            placeholder={t('resourcePackage.chooseTarget')}
                            data-testid={`package-target-${entry.localSlug}`}
                            options={targets.map((candidate) => ({
                              value: candidate.id,
                              label: `${candidate.name} · ${candidate.id}${
                                candidate.owned ? '' : ` (${t('resourcePackage.notYours')})`
                              }`,
                            }))}
                            onChange={(targetId) =>
                              setDecisions((previous) => {
                                const current = previous[entry.localSlug]!
                                return {
                                  ...previous,
                                  [entry.localSlug]: {
                                    ...current,
                                    targetId,
                                    ...(current.action === 'new'
                                      ? {}
                                      : {
                                          targetByAction: {
                                            ...current.targetByAction,
                                            [current.action]: targetId,
                                          },
                                        }),
                                  },
                                }
                              })
                            }
                          />
                        </Field>
                      ) : null}
                    </div>
                  </Card>
                )
              })}
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canCommit}
              onClick={() => void runCommit()}
              data-testid="package-import-commit"
            >
              {t('resourcePackage.commit')}
            </button>
          </div>
        </>
      ) : null}

      {phase === 'done' && receipt !== null ? (
        <div data-testid="package-import-report">
          <h2 ref={phaseHeadingRef} tabIndex={-1}>
            {t('resourcePackage.completeTitle')}
          </h2>
          <NoticeBanner tone="success">
            {t('resourcePackage.completeSummary', {
              applied: receipt.applied.length,
              reused: reusedCount,
            })}
          </NoticeBanner>
          {receipt.applied.length > 0 ? (
            <ul className="resource-package-import-flow__summary">
              {receipt.applied.map((applied) => (
                <li key={applied.opId}>
                  {t(`resourcePackage.type.${applied.resourceType}`)} · {applied.name} ·{' '}
                  {t(`resourcePackage.appliedAction.${applied.action}`)}
                </li>
              ))}
            </ul>
          ) : null}
          {(receipt.skippedSecrets?.length ?? 0) > 0 ? (
            <NoticeBanner
              tone="warning"
              title={t('resourcePackage.skippedSecretsTitle')}
              testid="package-import-skipped-secrets"
            >
              <ul>
                {receipt.skippedSecrets?.map((secret) => (
                  <li key={secretRefKey(secret)}>
                    {t('resourcePackage.secretFieldLabel', {
                      type: t(`resourcePackage.type.${secret.resourceType}`),
                      name: secret.resourceName,
                      field: secret.field,
                    })}
                  </li>
                ))}
              </ul>
            </NoticeBanner>
          ) : null}
          <div className="form-actions">
            {receipt.root !== undefined ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => openImportedRoot(navigate, receipt.root!)}
                data-testid="package-import-open-root"
              >
                {t('resourcePackage.openImportedRoot', { name: receipt.root.name })}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={reset}>
              {t('resourcePackage.importAnother')}
            </button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={pendingFileChange !== null}
        title={t('resourcePackage.replaceConfirmTitle')}
        description={t(
          pendingFileChange?.file === null
            ? commitRecovery === 'retry'
              ? 'resourcePackage.removeAfterCommitConfirmBody'
              : 'resourcePackage.removeConfirmBody'
            : commitRecovery === 'retry'
              ? 'resourcePackage.replaceAfterCommitConfirmBody'
              : 'resourcePackage.replaceConfirmBody',
        )}
        confirmLabel={t('resourcePackage.replaceConfirmAction')}
        tone="danger"
        triggerRef={fileChangeTriggerRef}
        restoreFocusFallbackRef={phaseHeadingRef}
        onClose={() => setPendingFileChange(null)}
        onConfirm={() => {
          const pending = pendingFileChange
          if (pending !== null) applyFileChange(pending.file)
        }}
      />
    </div>
  )
})

export interface ResourcePackageImportDialogProps {
  open: boolean
  onClose: () => void
  onImported?: (receipt: PackageImportReceipt) => void
  triggerRef?: RefObject<HTMLElement | null>
  expectedRootType?: ResourcePackageType
}

export function ResourcePackageImportDialog(
  props: ResourcePackageImportDialogProps,
): ReactElement | null {
  const { t } = useTranslation()
  const { onClose } = props
  const [busy, setBusy] = useState(false)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const dismissLockedRef = useRef(false)
  dismissLockedRef.current = busy || outcomeUnknown
  const close = useCallback(() => {
    // Dialog installs native Escape/overlay listeners in an effect. Keep the
    // lock authoritative even during the render-to-effect-cleanup handoff so a
    // stale listener cannot unmount an outcome-unknown idempotency session.
    if (!dismissLockedRef.current) onClose()
  }, [onClose])
  return (
    <Dialog
      open={props.open}
      size="full"
      title={t('resourcePackage.importTitle')}
      triggerRef={props.triggerRef}
      dismissDisabled={busy || outcomeUnknown}
      onClose={close}
      footer={
        <button type="button" className="btn" disabled={busy || outcomeUnknown} onClick={close}>
          {t('common.close')}
        </button>
      }
    >
      <ResourcePackageImportPanel
        onBusyChange={setBusy}
        onOutcomeUnknownChange={setOutcomeUnknown}
        beginCommitBusy={() => {
          setBusy(true)
          return () => setBusy(false)
        }}
        onImported={props.onImported}
        expectedRootType={props.expectedRootType}
      />
    </Dialog>
  )
}
