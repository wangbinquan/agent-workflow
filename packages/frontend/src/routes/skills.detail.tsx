// Skill detail / edit page — route owner for RFC-201's composite Skill draft.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileNode, Skill, SkillContent } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import {
  useRegisterSplitDiscard,
  useReportSplitDirty,
  useSplitDirty,
  type SplitBusyRelease,
} from '@/components/split/splitDirty'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { FuseDialog } from '@/components/fusion/FuseDialog'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownEditor } from '@/components/MarkdownEditor'
import { NoticeBanner } from '@/components/NoticeBanner'
import { SkillFileTree } from '@/components/SkillFileTree'
import { SkillVersionHistory } from '@/components/skill/SkillVersionHistory'
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import {
  aggregateSkillCompositeDraft,
  captureSkillSavePlan,
  createSkillCompositeDraft,
  discardSkillCompositeDraft,
  editSkillFile,
  editSkillMetadata,
  editSkillNewPath,
  getSkillCompositeScope,
  readStableSkillSnapshot,
  receiveSkillFile,
  receiveSkillMetadata,
  reduceSkillCompositeScope,
  skillFileEqual,
  skillMetadataEqual,
  stageSkillFileCreate,
  stageSkillFileDelete,
  undoSkillFile,
  type SkillCompositeDraftState,
  type SkillFileDraft,
  type SkillSaveStep,
  type StableSkillSnapshot,
} from '@/lib/skill-composite-draft'
import { classifyWriteOutcome } from '@/lib/write-outcome'
import { Route as skillsRoute } from './skills'

export const Route = createRoute({
  getParentRoute: () => skillsRoute,
  path: '/$name',
  component: SkillDetailPage,
  remountDeps: ({ params }) => params,
})

type SkillTab = 'edit' | 'files' | 'history'

let skillRequestSequence = 0

function nextSkillRequestId(step: SkillSaveStep): string {
  skillRequestSequence += 1
  const suffix = step.kind === 'metadata' ? 'metadata' : `${step.op}:${step.path}`
  return `skill:${suffix}:${Date.now()}:${skillRequestSequence}`
}

function dirtyPersistedScopeCount(state: SkillCompositeDraftState): number {
  return (
    Number(state.metadata.dirty) + Object.values(state.files).filter((scope) => scope.dirty).length
  )
}

class MissingSkillWriteReceiptError extends Error {
  constructor() {
    super('skill write completed without a fresh composite token receipt')
    this.name = 'MissingSkillWriteReceiptError'
  }
}

function SkillDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { beginBusy, report } = useSplitDirty()
  const remoteReadEpochRef = useRef(0)
  const contentResponseEpochsRef = useRef(new WeakMap<SkillContent, number>())
  const contentReadIgnoreThroughEpochRef = useRef(0)

  const meta = useQuery<Skill>({
    queryKey: ['skills', name],
    queryFn: ({ signal }) => api.get(`/api/skills/${encodeURIComponent(name)}`, undefined, signal),
  })
  const content = useQuery<SkillContent>({
    queryKey: ['skills', name, 'content'],
    queryFn: async ({ signal }) => {
      const issuedEpoch = ++remoteReadEpochRef.current
      const response = await api.get<SkillContent>(
        `/api/skills/${encodeURIComponent(name)}/content`,
        undefined,
        signal,
      )
      contentResponseEpochsRef.current.set(response, issuedEpoch)
      return response
    },
  })

  const [tab, setTab] = useState<SkillTab>('edit')
  const [fuseOpen, setFuseOpen] = useState(false)
  const [restorePending, setRestorePending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saveSummary, setSaveSummary] = useState<{ saved: number; remaining: number } | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [composite, setComposite] = useState<SkillCompositeDraftState | null>(null)

  const compositeRef = useRef<SkillCompositeDraftState | null>(null)
  const tokenRef = useRef<string | undefined>(undefined)
  const saveBusyReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  const recheckBusyReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  const restoreBusyReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  const restoreMutationPendingRef = useRef(false)
  const restoreReconcilePendingRef = useRef(false)
  const outcomeBusyReleaseRef = useRef<SplitBusyRelease | undefined>(undefined)
  const ambiguousStepRef = useRef<
    | {
        step: SkillSaveStep
        requestId: string
        submittedRevision: number
      }
    | undefined
  >(undefined)

  const replaceComposite = useCallback(
    (next: SkillCompositeDraftState) => {
      // Outcome-unknown is not truthfully discardable. Acquire its persistent
      // token in the same synchronous reducer handoff that publishes the state,
      // and release only after a stable reconciliation clears it.
      const outcomeUnknown = aggregateSkillCompositeDraft(next).outcomeUnknown
      if (outcomeUnknown && outcomeBusyReleaseRef.current === undefined) {
        outcomeBusyReleaseRef.current = beginBusy(name)
      } else if (!outcomeUnknown && outcomeBusyReleaseRef.current !== undefined) {
        outcomeBusyReleaseRef.current()
        outcomeBusyReleaseRef.current = undefined
      }
      compositeRef.current = next
      setComposite(next)
    },
    [beginBusy, name],
  )

  const updateComposite = useCallback(
    (update: (current: SkillCompositeDraftState) => SkillCompositeDraftState) => {
      const current = compositeRef.current
      if (current === null) return undefined
      const next = update(current)
      replaceComposite(next)
      return next
    },
    [replaceComposite],
  )

  // Every content GET carries its route-owned issue epoch. Clean metadata/body
  // follows an accepted authoritative response; dirty metadata/body stays local
  // and records a visible stale remote. Exact write receipts placed in the query
  // cache have no GET epoch, so they receive a new local publication epoch here.
  // A GET issued before a later write receipt is rejected by the global token
  // floor even if it completes last.
  useEffect(() => {
    if (content.data === undefined || meta.data === undefined) return
    const issuedEpoch =
      contentResponseEpochsRef.current.get(content.data) ?? ++remoteReadEpochRef.current
    if (issuedEpoch <= contentReadIgnoreThroughEpochRef.current) return

    const current = compositeRef.current ?? createSkillCompositeDraft(content.data)
    const next = receiveSkillMetadata(
      current,
      { description: content.data.description, bodyMd: content.data.bodyMd },
      issuedEpoch,
    )
    // An out-of-order older GET is ignored by the scope reducer. Keep the
    // canonical composite token aligned with the exact response it accepted.
    if (next.metadata.lastAcceptedReadEpoch !== issuedEpoch) return
    tokenRef.current = content.data.token
    replaceComposite(next)
  }, [content.data, content.dataUpdatedAt, meta.data, replaceComposite])

  const aggregate = useMemo(
    () =>
      composite === null
        ? {
            dirty: false,
            busy: false,
            valid: true,
            stale: false,
            outcomeUnknown: false,
          }
        : aggregateSkillCompositeDraft(composite),
    [composite],
  )
  const operationBusy = saving || restorePending || rechecking || aggregate.busy
  const metadataScope = composite?.metadata
  const fileScopes =
    composite === null ? [] : [composite.newPath, ...Object.values(composite.files)]
  const metadataError = metadataScope?.submitError !== undefined
  const metadataOutcomeUnknown = metadataScope?.ambiguousSubmit !== undefined
  const metadataStale = metadataScope?.staleRemote !== undefined
  const metadataDirty = metadataScope?.dirty === true
  const filesError = fileScopes.some((scope) => scope.submitError !== undefined)
  const filesOutcomeUnknown = fileScopes.some((scope) => scope.ambiguousSubmit !== undefined)
  const filesStale = fileScopes.some((scope) => scope.staleRemote !== undefined)
  const filesDirty = fileScopes.some((scope) => scope.dirty)
  const historyBlockedForNav =
    aggregate.dirty || saving || rechecking || aggregate.busy || aggregate.outcomeUnknown
  const historyTab: TabDef<SkillTab> = historyBlockedForNav
    ? {
        key: 'history',
        label: t('skills.detailTabHistory'),
        testid: 'skill-tab-history',
        badge: '!',
        badgeTone: aggregate.outcomeUnknown ? 'danger' : 'attention',
        badgeAriaLabel: t(
          aggregate.outcomeUnknown
            ? 'skills.historyBlockedOutcomeUnknown'
            : operationBusy
              ? 'skills.historyBlockedBusy'
              : 'skills.historyBlockedDirty',
        ),
      }
    : {
        key: 'history',
        label: t('skills.detailTabHistory'),
        testid: 'skill-tab-history',
      }
  const tabs: Array<TabDef<SkillTab>> = [
    {
      key: 'edit',
      label: t('skills.detailTabEdit'),
      testid: 'skill-tab-edit',
      ...(metadataError || metadataOutcomeUnknown
        ? {
            badge: '!',
            badgeTone: 'danger' as const,
            badgeAriaLabel: metadataOutcomeUnknown
              ? t('skills.saveOutcomeUnknown')
              : t('editor.draftStatus.phase.error'),
          }
        : metadataStale
          ? {
              badge: '!',
              badgeTone: 'attention' as const,
              badgeAriaLabel: t('skills.saveStaleWarning'),
            }
          : metadataDirty
            ? {
                badge: '•',
                badgeTone: 'neutral' as const,
                badgeAriaLabel: t('editor.statusUnsaved'),
              }
            : {}),
    },
    {
      key: 'files',
      label: t('skills.detailTabFiles'),
      testid: 'skill-tab-files',
      ...(filesError || filesOutcomeUnknown
        ? {
            badge: '!',
            badgeTone: 'danger' as const,
            badgeAriaLabel: filesOutcomeUnknown
              ? t('skills.saveOutcomeUnknown')
              : t('editor.draftStatus.phase.error'),
          }
        : filesStale
          ? {
              badge: '!',
              badgeTone: 'attention' as const,
              badgeAriaLabel: t('skills.saveStaleWarning'),
            }
          : filesDirty
            ? {
                badge: '•',
                badgeTone: 'neutral' as const,
                badgeAriaLabel: t('editor.statusUnsaved'),
              }
            : {}),
    },
    historyTab,
  ]
  useReportSplitDirty(name, aggregate.dirty || operationBusy || aggregate.outcomeUnknown)

  const snapshotReader = useMemo(
    () => ({
      readContent: () => api.get<SkillContent>(`/api/skills/${encodeURIComponent(name)}/content`),
      readTree: () => api.get<FileNode[]>(`/api/skills/${encodeURIComponent(name)}/files`),
      readFile: (path: string) =>
        api.get<{ content: string }>(`/api/skills/${encodeURIComponent(name)}/file`, { path }),
    }),
    [name],
  )

  const publishStableSnapshot = useCallback(
    (
      step: SkillSaveStep,
      snapshot: StableSkillSnapshot,
      reconciliation?: { requestId: string; submittedRevision: number },
    ): boolean => {
      // The stable snapshot is authoritative after every content GET that had
      // already been issued. Those older responses may still complete later,
      // but may no longer roll back this token or baseline.
      contentReadIgnoreThroughEpochRef.current = Math.max(
        contentReadIgnoreThroughEpochRef.current,
        remoteReadEpochRef.current,
      )
      tokenRef.current = snapshot.token
      const previous = qc.getQueryData<SkillContent>(['skills', name, 'content'])
      if (previous !== undefined) {
        qc.setQueryData<SkillContent>(['skills', name, 'content'], {
          ...previous,
          ...snapshot.metadata,
          token: snapshot.token,
        })
      }
      qc.setQueryData(['skill-files', name], [...snapshot.tree])

      remoteReadEpochRef.current += 1
      const issuedEpoch = remoteReadEpochRef.current
      if (step.kind === 'metadata') {
        updateComposite((current) =>
          receiveSkillMetadata(current, snapshot.metadata, issuedEpoch, reconciliation),
        )
        return skillMetadataEqual(snapshot.metadata, step.submitted)
      }

      const remote = snapshot.files[step.path]
      if (remote === undefined) throw new Error(`stable snapshot omitted '${step.path}'`)
      if (remote.exists) {
        qc.setQueryData(['skill-file', name, step.path], { content: remote.content })
      } else {
        qc.removeQueries({ queryKey: ['skill-file', name, step.path], exact: true })
      }
      updateComposite((current) =>
        reduceSkillCompositeScope(
          current,
          { kind: 'file', path: step.path },
          {
            type: 'remote-read',
            remote,
            issuedEpoch,
            ...(reconciliation === undefined ? {} : { reconciliation }),
          },
        ),
      )
      return skillFileEqual(remote, step.submitted)
    },
    [name, qc, updateComposite],
  )

  const reconcileStep = useCallback(
    async (
      step: SkillSaveStep,
      reconciliation?: { requestId: string; submittedRevision: number },
    ): Promise<'matched' | 'different' | 'unknown'> => {
      try {
        const snapshot = await readStableSkillSnapshot(
          snapshotReader,
          step.kind === 'file' ? [step.path] : [],
        )
        if (snapshot.kind !== 'stable') {
          setSaveError(new Error(t('skills.saveOutcomeStillUnknown')))
          return 'unknown'
        }
        const matched = publishStableSnapshot(step, snapshot, reconciliation)
        if (reconciliation !== undefined) ambiguousStepRef.current = undefined
        setSaveError(matched ? null : new Error(t('skills.saveRemoteDifferent')))
        return matched ? 'matched' : 'different'
      } catch (error) {
        setSaveError(error)
        return 'unknown'
      }
    },
    [publishStableSnapshot, snapshotReader, t],
  )

  const beginStep = useCallback(
    (step: SkillSaveStep, requestId: string): boolean => {
      const current = compositeRef.current
      if (current === null) return false
      const scope = getSkillCompositeScope(current, step.scope)
      if (
        scope === undefined ||
        !scope.dirty ||
        scope.validity !== 'valid' ||
        scope.inFlight !== undefined ||
        scope.ambiguousSubmit !== undefined ||
        scope.revision !== step.submittedRevision
      ) {
        return false
      }
      if (step.kind === 'metadata') {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'metadata' },
            {
              type: 'begin-submit',
              requestId,
              submittedRevision: step.submittedRevision,
            },
          ),
        )
      } else {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'file', path: step.path },
            {
              type: 'begin-submit',
              requestId,
              submittedRevision: step.submittedRevision,
            },
          ),
        )
      }
      return true
    },
    [updateComposite],
  )

  const settleStepSuccess = useCallback(
    (
      step: SkillSaveStep,
      requestId: string,
      persisted: SkillFileDraft | SkillSaveStep['submitted'],
      ignoreContentReadsThroughEpoch: number,
    ) => {
      if (step.kind === 'metadata') {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'metadata' },
            {
              type: 'submit-success',
              requestId,
              submittedRevision: step.submittedRevision,
              persisted: persisted as typeof step.submitted,
              ignoreReadsThroughEpoch: ignoreContentReadsThroughEpoch,
            },
          ),
        )
      } else {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'file', path: step.path },
            {
              type: 'submit-success',
              requestId,
              submittedRevision: step.submittedRevision,
              persisted: persisted as SkillFileDraft,
            },
          ),
        )
      }
    },
    [updateComposite],
  )

  const settleStepError = useCallback(
    (
      step: SkillSaveStep,
      requestId: string,
      error: unknown,
      outcome: 'definitive' | 'ambiguous',
    ) => {
      if (step.kind === 'metadata') {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'metadata' },
            {
              type: 'submit-error',
              requestId,
              submittedRevision: step.submittedRevision,
              error,
              outcome,
            },
          ),
        )
      } else {
        updateComposite((state) =>
          reduceSkillCompositeScope(
            state,
            { kind: 'file', path: step.path },
            {
              type: 'submit-error',
              requestId,
              submittedRevision: step.submittedRevision,
              error,
              outcome,
            },
          ),
        )
      }
    },
    [updateComposite],
  )

  const writeStep = useCallback(
    async (step: SkillSaveStep, expectedToken: string, requestId: string): Promise<string> => {
      if (step.kind === 'metadata') {
        const receipt = await api.post<SkillContent>(
          `/api/skills/${encodeURIComponent(name)}/save`,
          { ...step.submitted, expectedToken },
        )
        if (
          typeof receipt.token !== 'string' ||
          receipt.name !== name ||
          typeof receipt.description !== 'string' ||
          typeof receipt.bodyMd !== 'string'
        ) {
          throw new MissingSkillWriteReceiptError()
        }
        const ignoreContentReadsThroughEpoch = remoteReadEpochRef.current
        contentReadIgnoreThroughEpochRef.current = Math.max(
          contentReadIgnoreThroughEpochRef.current,
          ignoreContentReadsThroughEpoch,
        )
        tokenRef.current = receipt.token
        qc.setQueryData(['skills', name, 'content'], receipt)
        settleStepSuccess(
          step,
          requestId,
          {
            description: receipt.description,
            bodyMd: receipt.bodyMd,
          },
          ignoreContentReadsThroughEpoch,
        )
        return receipt.token
      }

      let freshToken: string
      if (step.op === 'put') {
        const receipt = await api.put<{ ok?: boolean; path?: string; token?: string }>(
          `/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(step.path)}`,
          { content: step.submitted.content, expectedToken },
        )
        if (
          typeof receipt.token !== 'string' ||
          receipt.ok !== true ||
          receipt.path !== step.path
        ) {
          throw new MissingSkillWriteReceiptError()
        }
        freshToken = receipt.token
      } else {
        const receipt = await api.delete<{ token?: string }>(
          `/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(step.path)}&expectedToken=${encodeURIComponent(expectedToken)}`,
        )
        if (typeof receipt.token !== 'string') throw new MissingSkillWriteReceiptError()
        freshToken = receipt.token
      }
      const ignoreContentReadsThroughEpoch = remoteReadEpochRef.current
      contentReadIgnoreThroughEpochRef.current = Math.max(
        contentReadIgnoreThroughEpochRef.current,
        ignoreContentReadsThroughEpoch,
      )
      tokenRef.current = freshToken
      settleStepSuccess(step, requestId, step.submitted, ignoreContentReadsThroughEpoch)
      if (step.op === 'put') {
        qc.setQueryData(['skill-file', name, step.path], { content: step.submitted.content })
      } else {
        qc.removeQueries({ queryKey: ['skill-file', name, step.path], exact: true })
        setSelectedFile((current) => (current === step.path ? null : current))
      }
      return freshToken
    },
    [name, qc, settleStepSuccess],
  )

  const handleSave = useCallback(async () => {
    const current = compositeRef.current
    const startingToken = tokenRef.current
    if (current === null || startingToken === undefined || saveBusyReleaseRef.current !== undefined)
      return
    const plan = captureSkillSavePlan(current)
    if (plan.length === 0) return

    const releaseBusy = beginBusy(name)
    saveBusyReleaseRef.current = releaseBusy
    setSaving(true)
    setSaveError(null)
    setSaveSummary(null)
    let token = startingToken
    let saved = 0

    try {
      for (const step of plan) {
        const requestId = nextSkillRequestId(step)
        if (!beginStep(step, requestId)) continue
        try {
          token = await writeStep(step, token, requestId)
          saved += 1
        } catch (error) {
          // RFC-208: skill writes are token-fenced but NOT idempotent — an OCC
          // fence makes a stale replay detectable (409), it does not make the
          // write replayable. So a transport failure/timeout here is genuinely
          // unknown and must go through reconciliation, never be optimistically
          // treated as "never applied".
          const outcome =
            classifyWriteOutcome(error, { idempotent: false }) === 'definitive'
              ? 'definitive'
              : 'ambiguous'
          settleStepError(step, requestId, error, outcome)
          setSaveError(error)

          if (outcome === 'ambiguous') {
            ambiguousStepRef.current = {
              step,
              requestId,
              submittedRevision: step.submittedRevision,
            }
            const reconciled = await reconcileStep(step, {
              requestId,
              submittedRevision: step.submittedRevision,
            })
            if (reconciled === 'matched') saved += 1
          } else if (error instanceof ApiError && error.status === 409) {
            // The write was rejected, but the old token is unusable.  Refresh a
            // stable baseline/token before enabling a genuinely new request.
            await reconcileStep(step)
          }
          break
        }
      }
    } finally {
      setSaving(false)
      const latest = compositeRef.current
      const remaining = latest === null ? 0 : dirtyPersistedScopeCount(latest)
      if (saved > 0 || remaining > 0) setSaveSummary({ saved, remaining })
      void qc.invalidateQueries({ queryKey: ['skills', name] })
      void qc.invalidateQueries({ queryKey: ['skills', name, 'versions'] })
      void qc.invalidateQueries({ queryKey: ['skill-files', name] })
      void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
      if (saveBusyReleaseRef.current === releaseBusy) saveBusyReleaseRef.current = undefined
      releaseBusy()
    }
  }, [beginBusy, beginStep, name, qc, reconcileStep, settleStepError, writeStep])

  const handleRecheck = useCallback(async () => {
    const pending = ambiguousStepRef.current
    if (pending === undefined || rechecking || recheckBusyReleaseRef.current !== undefined) return
    const releaseBusy = beginBusy(name)
    recheckBusyReleaseRef.current = releaseBusy
    setRechecking(true)
    try {
      const result = await reconcileStep(pending.step, {
        requestId: pending.requestId,
        submittedRevision: pending.submittedRevision,
      })
      if (result !== 'unknown') {
        const latest = compositeRef.current
        setSaveSummary({
          saved: result === 'matched' ? 1 : 0,
          remaining: latest === null ? 0 : dirtyPersistedScopeCount(latest),
        })
      }
    } finally {
      setRechecking(false)
      if (recheckBusyReleaseRef.current === releaseBusy) recheckBusyReleaseRef.current = undefined
      releaseBusy()
    }
  }, [beginBusy, name, rechecking, reconcileStep])

  const discardAll = useCallback(() => {
    const current = compositeRef.current
    if (current === null) return false
    const next = discardSkillCompositeDraft(current)
    replaceComposite(next)
    setSaveError(null)
    setSaveSummary(null)
    return true
  }, [replaceComposite])
  useRegisterSplitDiscard(name, discardAll)

  const finishRestoreIfIdle = useCallback(() => {
    if (restoreMutationPendingRef.current || restoreReconcilePendingRef.current) return
    setRestorePending(false)
    restoreBusyReleaseRef.current?.()
    restoreBusyReleaseRef.current = undefined
  }, [])

  const handleRestorePendingChange = useCallback(
    (pending: boolean) => {
      restoreMutationPendingRef.current = pending
      if (pending) {
        if (restoreBusyReleaseRef.current === undefined) {
          restoreBusyReleaseRef.current = beginBusy(name)
        }
        setRestorePending(true)
      } else {
        finishRestoreIfIdle()
      }
    },
    [beginBusy, finishRestoreIfIdle, name],
  )
  const handleRestoreStart = useCallback(
    () => handleRestorePendingChange(true),
    [handleRestorePendingChange],
  )

  const handleRestored = useCallback(() => {
    restoreReconcilePendingRef.current = true
    if (restoreBusyReleaseRef.current === undefined) {
      restoreBusyReleaseRef.current = beginBusy(name)
    }
    setRestorePending(true)
    contentReadIgnoreThroughEpochRef.current = Math.max(
      contentReadIgnoreThroughEpochRef.current,
      remoteReadEpochRef.current,
    )
    void content
      .refetch()
      .then((result) => {
        if (result.data === undefined) return
        const issuedEpoch =
          contentResponseEpochsRef.current.get(result.data) ?? ++remoteReadEpochRef.current
        const next = receiveSkillMetadata(
          createSkillCompositeDraft(result.data),
          { description: result.data.description, bodyMd: result.data.bodyMd },
          issuedEpoch,
        )
        tokenRef.current = result.data.token
        replaceComposite(next)
        setSelectedFile(null)
        setSaveError(null)
        setSaveSummary(null)
      })
      .finally(() => {
        restoreReconcilePendingRef.current = false
        finishRestoreIfIdle()
      })
  }, [beginBusy, content, finishRestoreIfIdle, name, replaceComposite])

  const del = useMutation({
    mutationFn: (_variables: { release: SplitBusyRelease }) =>
      api.delete(`/api/skills/${encodeURIComponent(name)}`),
    onSuccess: async (_deleted, { release }) => {
      report(name, false)
      await qc.cancelQueries({ queryKey: ['skills'], exact: true })
      qc.setQueryData<Skill[]>(['skills'], (rows) =>
        rows === undefined ? rows : rows.filter((row) => row.name !== name),
      )
      void qc.invalidateQueries({ queryKey: ['skills'], exact: true })
      release()
      navigate({ to: '/skills' })
    },
    onSettled: (_deleted, _error, { release }) => release(),
  })

  const retryDetailAction = (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => void Promise.all([meta.refetch(), content.refetch()])}
    >
      {t('common.retry')}
    </button>
  )

  if (composite === null) {
    if (meta.error !== null && meta.error !== undefined)
      return <ErrorBanner error={meta.error} action={retryDetailAction} />
    if (content.error !== null && content.error !== undefined)
      return <ErrorBanner error={content.error} action={retryDetailAction} />
    if (meta.isLoading || content.isLoading || meta.data !== undefined)
      return <LoadingState data-testid="skill-detail-loading" />
    return null
  }

  const description = composite.metadata.draft.description
  const bodyMd = composite.metadata.draft.bodyMd
  const setDescription = (description: string) =>
    updateComposite((state) => editSkillMetadata(state, { ...state.metadata.draft, description }))
  const setBodyMd = (bodyMd: string) =>
    updateComposite((state) => editSkillMetadata(state, { ...state.metadata.draft, bodyMd }))

  const saveDisabled =
    !aggregate.dirty ||
    !aggregate.valid ||
    operationBusy ||
    aggregate.outcomeUnknown ||
    tokenRef.current === undefined
  const saveDisabledTitle = !aggregate.dirty
    ? t('skills.saveNothingToSave')
    : aggregate.outcomeUnknown
      ? t('skills.saveOutcomeUnknown')
      : !aggregate.valid
        ? t('skills.saveStageNewPathFirst')
        : operationBusy
          ? t('skills.saveBusy')
          : tokenRef.current === undefined
            ? t('skills.saveTokenMissing')
            : undefined

  const editPanel = (
    <div className="skill-detail__edit">
      <Field label={t('skills.fieldDescription')} hint={t('skills.descHintManaged')}>
        <TextInput
          value={description}
          onChange={setDescription}
          data-testid="skill-description-input"
        />
      </Field>
      <div className="skill-detail__body">
        <MarkdownEditor value={bodyMd} onChange={setBodyMd} fill />
      </div>
      <details className="skill-detail__technical">
        <summary>{t('skills.technicalInformation')}</summary>
        <dl>
          <dt>{t('skills.managedPath')}</dt>
          <dd>
            <code>{meta.data?.managedPath ?? ''}</code>
          </dd>
        </dl>
      </details>
    </div>
  )

  // Keep SkillVersionHistory mounted during its own restore mutation; unmounting
  // it after onPendingChange(true) would strand the route in a permanent busy
  // state before the child's onSuccess/onSettled callbacks can report completion.
  const historyBlocked = historyBlockedForNav
  const historyPanel = historyBlocked ? (
    <EmptyState
      title={t('skills.historyBlockedTitle')}
      description={t(
        aggregate.outcomeUnknown
          ? 'skills.historyBlockedOutcomeUnknown'
          : operationBusy
            ? 'skills.historyBlockedBusy'
            : 'skills.historyBlockedDirty',
      )}
      action={
        aggregate.dirty && !operationBusy && !aggregate.outcomeUnknown ? (
          <button type="button" className="btn btn--sm" onClick={discardAll}>
            {t('skills.discardAllChanges')}
          </button>
        ) : aggregate.outcomeUnknown ? (
          <button type="button" className="btn btn--sm" onClick={() => void handleRecheck()}>
            {t('skills.recheckOutcome')}
          </button>
        ) : undefined
      }
    />
  ) : (
    <SkillVersionHistory
      skillName={name}
      currentVersion={meta.data?.contentVersion ?? 0}
      busy={operationBusy}
      onRestoreStart={handleRestoreStart}
      onPendingChange={handleRestorePendingChange}
      onRestored={handleRestored}
    />
  )

  return (
    <fieldset className="detail-freeze skill-detail" disabled={del.isPending}>
      <DetailHeaderActions
        title={name}
        headingLevel={2}
        acl={{
          resourceBaseUrl: `/api/skills/${encodeURIComponent(name)}`,
          invalidateKey: ['skills'],
          canTransferOwner: true,
        }}
        save={{
          label: saving ? t('common.saving') : t('skills.saveAllChanges'),
          onClick: () => void handleSave(),
          disabled: saveDisabled,
          title: saveDisabledTitle,
          testid: 'skill-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync({ release: beginBusy(name) }),
          disabled: del.isPending || aggregate.dirty || operationBusy || aggregate.outcomeUnknown,
        }}
        extra={
          <button
            type="button"
            className="btn"
            onClick={() => setFuseOpen(true)}
            disabled={aggregate.dirty || operationBusy || aggregate.outcomeUnknown}
          >
            {t('fusion.launchFromSkillButton')}
          </button>
        }
        errors={[saveError, del.error]}
      />

      {(meta.error !== null && meta.error !== undefined) ||
      (content.error !== null && content.error !== undefined) ? (
        <ErrorBanner error={meta.error ?? content.error} action={retryDetailAction} />
      ) : null}

      {aggregate.outcomeUnknown && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('skills.saveOutcomeUnknown')}
          action={
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? t('skills.recheckingOutcome') : t('skills.recheckOutcome')}
            </button>
          }
        >
          {t('skills.saveOutcomeUnknownDescription')}
        </NoticeBanner>
      )}
      {!aggregate.outcomeUnknown && aggregate.stale && (
        <NoticeBanner tone="warning" size="compact">
          {t('skills.saveStaleWarning')}
        </NoticeBanner>
      )}
      {saveSummary !== null && (
        <NoticeBanner tone={saveSummary.remaining === 0 ? 'success' : 'warning'} size="compact">
          {saveSummary.remaining === 0
            ? t('skills.saveAllComplete', { count: saveSummary.saved })
            : t('skills.savePartial', saveSummary)}
        </NoticeBanner>
      )}

      <div className="agent-form">
        <TabBar
          tabs={tabs}
          active={tab}
          onSelect={setTab}
          ariaLabel={t('skills.title')}
          idPrefix="skills-detail"
        />
        <TabPanels
          active={tab}
          idPrefix="skills-detail"
          className="split__detail-body agent-form__panel"
          panels={[
            {
              key: 'edit',
              testid: 'skill-panel-edit',
              className: 'agent-form__panel--prompt',
              content: editPanel,
            },
            {
              key: 'files',
              testid: 'skill-panel-files',
              content: (
                <SkillFileTree
                  skillName={name}
                  readonlyPaths={['SKILL.md']}
                  selected={selectedFile}
                  onSelectedChange={setSelectedFile}
                  newPath={composite.newPath.draft}
                  onNewPathChange={(path) =>
                    updateComposite((state) => editSkillNewPath(state, path))
                  }
                  fileScopes={composite.files}
                  onFileLoaded={(path, fileContent, issuedEpoch) =>
                    updateComposite((state) =>
                      receiveSkillFile(state, path, fileContent, issuedEpoch),
                    )
                  }
                  onFileChange={(path, fileContent) =>
                    updateComposite((state) => editSkillFile(state, path, fileContent))
                  }
                  onStageCreate={(path) =>
                    updateComposite((state) => stageSkillFileCreate(state, path))
                  }
                  onStageDelete={(path) =>
                    updateComposite((state) => stageSkillFileDelete(state, path))
                  }
                  onUndo={(path) => updateComposite((state) => undoSkillFile(state, path))}
                  busy={restorePending || rechecking}
                />
              ),
            },
            {
              key: 'history',
              testid: 'skill-panel-history',
              content: historyPanel,
            },
          ]}
        />
      </div>

      <FuseDialog
        open={fuseOpen}
        onClose={() => setFuseOpen(false)}
        entry={{ kind: 'from-skill', skillName: name }}
      />
    </fieldset>
  )
}
