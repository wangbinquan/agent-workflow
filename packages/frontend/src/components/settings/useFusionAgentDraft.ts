// RFC-201 PR-A — route-owned draft for the Settings field backed by the
// aw-skill-merger Agent row. Drafts, receipts, and write barriers are scoped to
// one stable daemon resource; credential generations only fence transport.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Agent } from '@agent-workflow/shared'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, api } from '@/api/client'
import {
  createEditScopeState,
  editScopeReducer,
  type EditScopeState,
  type EditScopeSubmission,
} from '@/lib/edit-scope'
import { ensureConfigReceiptGeneration, getConfigResourceIdentity } from '@/lib/config-resource'
import { subscribeAuth } from '@/stores/auth'

export const SKILL_MERGER_AGENT_ID = '00000000000000000000000001'

/** Prefixes only; every actual cache key appends a stable daemon identity. */
export const FUSION_AGENT_QUERY_KEY = ['agents', SKILL_MERGER_AGENT_ID, 'resource'] as const
export const FUSION_AGENT_DRAFT_QUERY_KEY = [
  'agents',
  SKILL_MERGER_AGENT_ID,
  'settings-draft-receipt',
  'resource',
] as const

export function getFusionAgentQueryKey(
  resourceIdentity = getConfigResourceIdentity(),
): readonly [...typeof FUSION_AGENT_QUERY_KEY, string] {
  return [...FUSION_AGENT_QUERY_KEY, resourceIdentity]
}

export function getFusionAgentDraftQueryKey(
  resourceIdentity = getConfigResourceIdentity(),
): readonly [...typeof FUSION_AGENT_DRAFT_QUERY_KEY, string] {
  return [...FUSION_AGENT_DRAFT_QUERY_KEY, resourceIdentity]
}

interface FusionAgentReadReceipt {
  readonly agent: Agent
  readonly resourceIdentity: string
  readonly generation: number
  readonly issuedEpoch: number
}

export class FusionAgentGenerationError extends Error {
  readonly code = 'fusion-agent-generation-changed'

  constructor(
    readonly resourceIdentity: string,
    readonly expectedGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `fusion Agent transport generation changed from ${expectedGeneration} to ${currentGeneration}`,
    )
    this.name = 'FusionAgentGenerationError'
  }
}

export interface FusionAgentSaveOptions {
  onSuccess?: (agent: Agent) => void
  onError?: (error: unknown) => void
  onSettled?: (agent: Agent | undefined, error: unknown | null) => void
}

type SaveAttemptPhase = 'prepared' | 'queued' | 'dispatched' | 'cancelled' | 'fenced' | 'settled'

interface FusionAgentSaveAttempt {
  readonly requestId: string
  readonly submittedRevision: number
  readonly runtime: string | null
  readonly resourceIdentity: string
  readonly generation: number
  readonly expectedUpdatedAt: number
  readonly expectedAclRevision: number
  phase: SaveAttemptPhase
  options?: FusionAgentSaveOptions
  notified: boolean
}

export interface FusionAgentPreparedSave {
  readonly requestId: string
  readonly submittedRevision: number
  readonly runtime: string | null
  readonly resourceIdentity: string
  readonly generation: number
  commit: (options?: FusionAgentSaveOptions) => void
  cancel: () => void
}

type SaveViewState =
  | { status: 'idle'; error: null }
  | { status: 'pending'; error: null }
  | { status: 'success'; error: null }
  | { status: 'error'; error: unknown }

interface FusionResourceSession {
  readonly resourceIdentity: string
  generation: number
  readEpoch: number
  acceptedReceipt?: FusionAgentReadReceipt
  scope: EditScopeState<string | null> | null
  saveView: SaveViewState
  activeAttempt?: FusionAgentSaveAttempt
  reconciliationPromise: Promise<boolean> | null
  reconciliationToken?: symbol
}

export interface UseFusionAgentDraftOptions {
  enabled: boolean
}

export interface FusionAgentDraftController {
  loaded: boolean
  value: string | null
  dirty: boolean
  busy: boolean
  stale: boolean
  outcomeUnknown: boolean
  setValue: (runtime: string | null) => void
  /** Observation only; never proves that a response-loss PUT handler stopped. */
  reconcile: () => Promise<boolean>
  /** Adopt a foreign remote only when no write outcome is unknown. */
  discard: () => Promise<boolean>
  query: {
    status: 'pending' | 'error' | 'success'
    fetchStatus: 'fetching' | 'paused' | 'idle'
    isPending: boolean
    isLoading: boolean
    isFetching: boolean
    isSuccess: boolean
    isError: boolean
    error: unknown | null
    refetch: () => Promise<unknown>
  }
  save: {
    prepare: () => FusionAgentPreparedSave | null
    mutate: (options?: FusionAgentSaveOptions) => void
    isPending: boolean
    isSuccess: boolean
    error: unknown | null
  }
}

function runtimeOf(agent: Agent): string | null {
  return agent.runtime ?? null
}

function readTransportSnapshot(): string {
  const generation = ensureConfigReceiptGeneration()
  return `${generation}\u0000${getConfigResourceIdentity()}`
}

function currentTransport(): { resourceIdentity: string; generation: number } {
  const generation = ensureConfigReceiptGeneration()
  return { resourceIdentity: getConfigResourceIdentity(), generation }
}

function transportMatches(resourceIdentity: string, generation: number): boolean {
  const current = currentTransport()
  return current.resourceIdentity === resourceIdentity && current.generation === generation
}

function stateFromReceipt(receipt: FusionAgentReadReceipt): EditScopeState<string | null> {
  return editScopeReducer(createEditScopeState(runtimeOf(receipt.agent)), {
    type: 'remote-read',
    remote: runtimeOf(receipt.agent),
    issuedEpoch: receipt.issuedEpoch,
  })
}

function resetReadFence(
  state: EditScopeState<string | null> | null,
): EditScopeState<string | null> | null {
  return state === null
    ? null
    : {
        ...state,
        ignoreReadsThroughEpoch: undefined,
        lastAcceptedReadEpoch: undefined,
      }
}

function ownsSubmission(
  state: EditScopeState<string | null> | null,
  attempt: Pick<FusionAgentSaveAttempt, 'requestId' | 'submittedRevision'>,
): state is EditScopeState<string | null> & {
  inFlight: EditScopeSubmission<string | null>
} {
  return (
    state?.inFlight?.requestId === attempt.requestId &&
    state.inFlight.submittedRevision === attempt.submittedRevision
  )
}

function createResourceSession(
  resourceIdentity: string,
  generation: number,
  cached: FusionAgentReadReceipt | undefined,
): FusionResourceSession {
  const usable = cached?.resourceIdentity === resourceIdentity ? cached : undefined
  const currentReceipt = usable?.generation === generation ? usable : undefined
  return {
    resourceIdentity,
    generation,
    readEpoch: currentReceipt?.issuedEpoch ?? 0,
    acceptedReceipt: currentReceipt,
    scope:
      usable === undefined
        ? null
        : currentReceipt === undefined
          ? createEditScopeState(runtimeOf(usable.agent))
          : stateFromReceipt(currentReceipt),
    saveView: { status: 'idle', error: null },
    reconciliationPromise: null,
  }
}

function generationError(session: FusionResourceSession, nextGeneration: number) {
  return new FusionAgentGenerationError(
    session.resourceIdentity,
    session.generation,
    nextGeneration,
  )
}

export function useFusionAgentDraft({
  enabled,
}: UseFusionAgentDraftOptions): FusionAgentDraftController {
  const queryClient = useQueryClient()
  const transportSnapshot = useSyncExternalStore(
    subscribeAuth,
    readTransportSnapshot,
    readTransportSnapshot,
  )
  const transport = currentTransport()
  const sessionsRef = useRef(new Map<string, FusionResourceSession>())
  const activeSessionRef = useRef<FusionResourceSession | null>(null)
  const previousTransportRef = useRef(transport)
  const notificationQueueRef = useRef<Array<() => void>>([])
  const [renderVersion, setRenderVersion] = useState(0)

  const queueFailure = useCallback((attempt: FusionAgentSaveAttempt, error: unknown) => {
    if (attempt.notified) return
    attempt.notified = true
    notificationQueueRef.current.push(() => {
      attempt.options?.onError?.(error)
      attempt.options?.onSettled?.(undefined, error)
    })
  }, [])

  const fenceSession = useCallback(
    (session: FusionResourceSession, nextGeneration: number) => {
      if (session.generation === nextGeneration) return
      const error = generationError(session, nextGeneration)
      const attempt = session.activeAttempt
      let nextScope = session.scope

      if (attempt !== undefined && ownsSubmission(nextScope, attempt)) {
        if (attempt.phase === 'prepared' || attempt.phase === 'queued') {
          nextScope = editScopeReducer(nextScope, {
            type: 'cancel-submit',
            requestId: attempt.requestId,
            submittedRevision: attempt.submittedRevision,
          })
          const wasQueued = attempt.phase === 'queued'
          attempt.phase = 'cancelled'
          session.saveView = wasQueued
            ? { status: 'error', error }
            : { status: 'idle', error: null }
          if (wasQueued) queueFailure(attempt, error)
        } else if (attempt.phase === 'dispatched') {
          nextScope = editScopeReducer(nextScope, {
            type: 'submit-error',
            requestId: attempt.requestId,
            submittedRevision: attempt.submittedRevision,
            error,
            outcome: 'ambiguous',
          })
          attempt.phase = 'fenced'
          session.saveView = { status: 'error', error }
          queueFailure(attempt, error)
        }
      } else if (nextScope?.ambiguousSubmit === undefined) {
        session.saveView = { status: 'idle', error: null }
      }

      session.activeAttempt = undefined
      session.scope = resetReadFence(nextScope)
      session.generation = nextGeneration
      session.readEpoch = 0
      session.acceptedReceipt = undefined
      session.reconciliationPromise = null
      session.reconciliationToken = undefined
    },
    [queueFailure],
  )

  const previousTransport = previousTransportRef.current
  if (
    previousTransport.resourceIdentity !== transport.resourceIdentity ||
    previousTransport.generation !== transport.generation
  ) {
    const previousSession = sessionsRef.current.get(previousTransport.resourceIdentity)
    if (previousSession !== undefined) fenceSession(previousSession, transport.generation)
    previousTransportRef.current = transport
  }

  let session = sessionsRef.current.get(transport.resourceIdentity)
  if (session === undefined) {
    session = createResourceSession(
      transport.resourceIdentity,
      transport.generation,
      queryClient.getQueryData<FusionAgentReadReceipt>(
        getFusionAgentDraftQueryKey(transport.resourceIdentity),
      ),
    )
    sessionsRef.current.set(transport.resourceIdentity, session)
  } else if (session.generation !== transport.generation) {
    fenceSession(session, transport.generation)
  }
  activeSessionRef.current = session

  const resourceIdentity = transport.resourceIdentity
  const generation = transport.generation
  const queryKey = useMemo(() => getFusionAgentDraftQueryKey(resourceIdentity), [resourceIdentity])

  const bump = useCallback((target: FusionResourceSession) => {
    if (activeSessionRef.current === target) setRenderVersion((version) => version + 1)
  }, [])

  const replaceScope = useCallback(
    (target: FusionResourceSession, next: EditScopeState<string | null>) => {
      target.scope = next
      bump(target)
    },
    [bump],
  )

  const cacheAcceptedReceipt = useCallback(
    (target: FusionResourceSession, receipt: FusionAgentReadReceipt) => {
      if (
        target.resourceIdentity !== receipt.resourceIdentity ||
        target.generation !== receipt.generation ||
        !transportMatches(receipt.resourceIdentity, receipt.generation)
      ) {
        return false
      }
      target.acceptedReceipt = receipt
      queryClient.setQueryData(getFusionAgentDraftQueryKey(receipt.resourceIdentity), receipt)
      queryClient.setQueryData(getFusionAgentQueryKey(receipt.resourceIdentity), receipt.agent)
      return true
    },
    [queryClient],
  )

  const issueRead = useCallback(
    async (
      target: FusionResourceSession,
      capturedResource: string,
      capturedGeneration: number,
      signal?: AbortSignal,
    ): Promise<FusionAgentReadReceipt> => {
      const issuedEpoch = ++target.readEpoch
      if (
        target.resourceIdentity !== capturedResource ||
        target.generation !== capturedGeneration ||
        !transportMatches(capturedResource, capturedGeneration)
      ) {
        throw new FusionAgentGenerationError(
          capturedResource,
          capturedGeneration,
          ensureConfigReceiptGeneration(),
        )
      }
      const agent = await api.get<Agent>('/api/agents/builtins/skill-merger', undefined, signal)
      if (
        target.generation !== capturedGeneration ||
        !transportMatches(capturedResource, capturedGeneration)
      ) {
        throw new FusionAgentGenerationError(
          capturedResource,
          capturedGeneration,
          ensureConfigReceiptGeneration(),
        )
      }
      return {
        agent,
        resourceIdentity: capturedResource,
        generation: capturedGeneration,
        issuedEpoch,
      }
    },
    [],
  )

  const acceptRead = useCallback(
    (target: FusionResourceSession, receipt: FusionAgentReadReceipt) => {
      if (
        target.resourceIdentity !== receipt.resourceIdentity ||
        target.generation !== receipt.generation ||
        !transportMatches(receipt.resourceIdentity, receipt.generation)
      ) {
        return target.scope
      }
      const remote = runtimeOf(receipt.agent)
      const initial = target.scope ?? createEditScopeState(remote)
      const next = editScopeReducer(initial, {
        type: 'remote-read',
        remote,
        issuedEpoch: receipt.issuedEpoch,
      })
      replaceScope(target, next)
      if (next.lastAcceptedReadEpoch === receipt.issuedEpoch) {
        cacheAcceptedReceipt(target, receipt)
      } else if (target.acceptedReceipt?.generation === target.generation) {
        queryClient.setQueryData(
          getFusionAgentDraftQueryKey(target.resourceIdentity),
          target.acceptedReceipt,
        )
      }
      return next
    },
    [cacheAcceptedReceipt, queryClient, replaceScope],
  )

  const acceptWrite = useCallback(
    (target: FusionResourceSession, agent: Agent, attempt: FusionAgentSaveAttempt) => {
      const current = target.scope
      if (
        !ownsSubmission(current, attempt) ||
        target.activeAttempt !== attempt ||
        target.resourceIdentity !== attempt.resourceIdentity ||
        target.generation !== attempt.generation ||
        !transportMatches(attempt.resourceIdentity, attempt.generation)
      ) {
        return false
      }

      const ignoreReadsThroughEpoch = target.readEpoch
      const receipt: FusionAgentReadReceipt = {
        agent,
        resourceIdentity: attempt.resourceIdentity,
        generation: attempt.generation,
        issuedEpoch: ++target.readEpoch,
      }
      const settled = editScopeReducer(current, {
        type: 'submit-success',
        requestId: attempt.requestId,
        submittedRevision: attempt.submittedRevision,
        persisted: runtimeOf(agent),
        ignoreReadsThroughEpoch,
      })
      const accepted = editScopeReducer(settled, {
        type: 'remote-read',
        remote: runtimeOf(agent),
        issuedEpoch: receipt.issuedEpoch,
      })
      attempt.phase = 'settled'
      target.activeAttempt = undefined
      target.saveView = { status: 'success', error: null }
      replaceScope(target, accepted)
      cacheAcceptedReceipt(target, receipt)
      return true
    },
    [cacheAcceptedReceipt, replaceScope],
  )

  const issueAmbientRead = useCallback(
    async (
      target: FusionResourceSession,
      capturedResource: string,
      capturedGeneration: number,
      signal?: AbortSignal,
    ) => {
      const receipt = await issueRead(target, capturedResource, capturedGeneration, signal)
      const current = target.scope
      const causallyObsolete =
        (current?.ignoreReadsThroughEpoch !== undefined &&
          receipt.issuedEpoch <= current.ignoreReadsThroughEpoch) ||
        (current?.lastAcceptedReadEpoch !== undefined &&
          receipt.issuedEpoch < current.lastAcceptedReadEpoch)
      return causallyObsolete && target.acceptedReceipt?.generation === capturedGeneration
        ? target.acceptedReceipt
        : receipt
    },
    [issueRead],
  )

  const query = useQuery<FusionAgentReadReceipt>({
    queryKey,
    enabled,
    queryFn: ({ signal }) => issueAmbientRead(session, resourceIdentity, generation, signal),
  })

  useEffect(() => {
    if (query.data !== undefined) acceptRead(session, query.data)
  }, [acceptRead, query.data, session])

  const queryGenerationRef = useRef({ resourceIdentity, generation })
  useEffect(() => {
    const previous = queryGenerationRef.current
    queryGenerationRef.current = { resourceIdentity, generation }
    if (previous.resourceIdentity === resourceIdentity && previous.generation !== generation) {
      void queryClient.invalidateQueries({ queryKey, exact: true })
    }
  }, [generation, queryClient, queryKey, resourceIdentity, transportSnapshot])

  useEffect(() => {
    const notifications = notificationQueueRef.current.splice(0)
    for (const notify of notifications) notify()
  }, [renderVersion, transportSnapshot])

  const reconcileSession = useCallback(
    (
      target: FusionResourceSession,
      capturedResource: string,
      capturedGeneration: number,
    ): Promise<boolean> => {
      if (target.reconciliationPromise !== null) return target.reconciliationPromise
      if (target.scope?.ambiguousSubmit === undefined) return Promise.resolve(true)

      target.saveView = { status: 'pending', error: null }
      bump(target)
      const reconciliationToken = Symbol('fusion-agent-reconciliation')
      target.reconciliationToken = reconciliationToken
      const promise = (async () => {
        try {
          const observed = await issueRead(target, capturedResource, capturedGeneration)
          // Observation only. Even an exact value match cannot prove that the
          // response-loss PUT handler has finished.
          acceptRead(target, observed)
          if (
            target.generation === capturedGeneration &&
            target.scope?.ambiguousSubmit !== undefined
          ) {
            target.saveView = {
              status: 'error',
              error:
                target.scope.submitError?.error ??
                new Error('fusion agent write outcome remains unknown'),
            }
            bump(target)
          }
          return false
        } catch (error) {
          if (
            target.generation === capturedGeneration &&
            target.scope?.ambiguousSubmit !== undefined
          ) {
            target.saveView = { status: 'error', error }
            bump(target)
          }
          return false
        } finally {
          if (target.reconciliationToken === reconciliationToken) {
            target.reconciliationPromise = null
            target.reconciliationToken = undefined
          }
        }
      })()
      target.reconciliationPromise = promise
      return promise
    },
    [acceptRead, bump, issueRead],
  )

  const mutation = useMutation<Agent, unknown, FusionAgentSaveAttempt>({
    mutationFn: (attempt) => {
      const target = sessionsRef.current.get(attempt.resourceIdentity)
      if (
        attempt.phase !== 'queued' ||
        target === undefined ||
        target.activeAttempt !== attempt ||
        target.generation !== attempt.generation ||
        !transportMatches(attempt.resourceIdentity, attempt.generation)
      ) {
        throw new FusionAgentGenerationError(
          attempt.resourceIdentity,
          attempt.generation,
          ensureConfigReceiptGeneration(),
        )
      }
      attempt.phase = 'dispatched'
      // RFC-104 allows only the runtime content field; RFC-223 adds the exact
      // ordinary-mutation revision tuple without widening editable content.
      const runtime = attempt.runtime
      return api.put<Agent>(`/api/agents/${SKILL_MERGER_AGENT_ID}`, {
        runtime,
        expectedUpdatedAt: attempt.expectedUpdatedAt,
        expectedAclRevision: attempt.expectedAclRevision,
      })
    },
    onSuccess: (agent, attempt) => {
      const target = sessionsRef.current.get(attempt.resourceIdentity)
      if (target === undefined || attempt.phase !== 'dispatched') return
      if (!transportMatches(attempt.resourceIdentity, attempt.generation)) {
        fenceSession(target, ensureConfigReceiptGeneration())
        bump(target)
        return
      }
      if (!acceptWrite(target, agent, attempt)) return
      if (!attempt.notified) {
        attempt.notified = true
        attempt.options?.onSuccess?.(agent)
        attempt.options?.onSettled?.(agent, null)
      }
    },
    onError: async (error, attempt) => {
      const target = sessionsRef.current.get(attempt.resourceIdentity)
      if (
        target === undefined ||
        attempt.phase === 'cancelled' ||
        attempt.phase === 'fenced' ||
        attempt.phase === 'settled'
      ) {
        return
      }

      if (
        target.generation !== attempt.generation ||
        !transportMatches(attempt.resourceIdentity, attempt.generation)
      ) {
        fenceSession(target, ensureConfigReceiptGeneration())
        bump(target)
        return
      }

      const current = target.scope
      if (!ownsSubmission(current, attempt)) return
      const definitivelyRejected =
        error instanceof ApiError && error.status >= 400 && error.status < 500
      const outcome =
        attempt.phase === 'dispatched' && !definitivelyRejected ? 'ambiguous' : 'definitive'
      target.scope = editScopeReducer(current, {
        type: 'submit-error',
        requestId: attempt.requestId,
        submittedRevision: attempt.submittedRevision,
        error,
        outcome,
      })
      target.activeAttempt = undefined
      target.saveView = { status: 'error', error }
      attempt.phase = outcome === 'ambiguous' ? 'fenced' : 'settled'
      bump(target)

      if (outcome === 'ambiguous') {
        await reconcileSession(target, attempt.resourceIdentity, attempt.generation)
      }
      queueFailure(attempt, error)
      setRenderVersion((version) => version + 1)
    },
  })

  const setValue = useCallback(
    (runtime: string | null) => {
      if (!transportMatches(resourceIdentity, generation)) return
      const current = session.scope
      if (current === null) return
      const edited = editScopeReducer(current, { type: 'edit', draft: runtime })
      session.scope = editScopeReducer(edited, { type: 'validity', validity: 'valid' })
      if (session.scope.ambiguousSubmit === undefined) {
        session.saveView = { status: 'idle', error: null }
      }
      bump(session)
    },
    [bump, generation, resourceIdentity, session],
  )

  const prepare = useCallback((): FusionAgentPreparedSave | null => {
    if (!transportMatches(resourceIdentity, generation)) return null
    const current = session.scope
    if (
      current === null ||
      !current.dirty ||
      current.validity !== 'valid' ||
      current.inFlight !== undefined ||
      current.ambiguousSubmit !== undefined
    ) {
      return null
    }
    const revision = session.acceptedReceipt?.agent
    if (revision === undefined) return null

    const attempt: FusionAgentSaveAttempt = {
      requestId: `settings-fusion-${Date.now()}-${current.usedRequestIds.length + 1}`,
      submittedRevision: current.revision,
      runtime: current.draft,
      resourceIdentity,
      generation,
      expectedUpdatedAt: revision.updatedAt,
      expectedAclRevision: revision.aclRevision ?? 0,
      phase: 'prepared',
      notified: false,
    }
    session.scope = editScopeReducer(current, {
      type: 'begin-submit',
      requestId: attempt.requestId,
      submittedRevision: attempt.submittedRevision,
    })
    session.activeAttempt = attempt
    session.saveView = { status: 'idle', error: null }
    bump(session)

    return {
      requestId: attempt.requestId,
      submittedRevision: attempt.submittedRevision,
      runtime: attempt.runtime,
      resourceIdentity: attempt.resourceIdentity,
      generation: attempt.generation,
      commit: (options) => {
        if (
          attempt.phase !== 'prepared' ||
          session.activeAttempt !== attempt ||
          !ownsSubmission(session.scope, attempt)
        ) {
          return
        }
        if (!transportMatches(attempt.resourceIdentity, attempt.generation)) {
          fenceSession(session, ensureConfigReceiptGeneration())
          bump(session)
          return
        }
        attempt.phase = 'queued'
        attempt.options = options
        session.saveView = { status: 'pending', error: null }
        bump(session)
        mutation.mutate(attempt)
      },
      cancel: () => {
        if (
          attempt.phase !== 'prepared' ||
          session.activeAttempt !== attempt ||
          !ownsSubmission(session.scope, attempt)
        ) {
          return
        }
        attempt.phase = 'cancelled'
        session.scope = editScopeReducer(session.scope, {
          type: 'cancel-submit',
          requestId: attempt.requestId,
          submittedRevision: attempt.submittedRevision,
        })
        session.activeAttempt = undefined
        session.saveView = { status: 'idle', error: null }
        bump(session)
      },
    }
  }, [bump, fenceSession, generation, mutation, resourceIdentity, session])

  const mutate = useCallback(
    (options?: FusionAgentSaveOptions) => {
      prepare()?.commit(options)
    },
    [prepare],
  )

  const reconcile = useCallback(
    () => reconcileSession(session, resourceIdentity, generation),
    [generation, reconcileSession, resourceIdentity, session],
  )

  const discard = useCallback(async () => {
    if (!transportMatches(resourceIdentity, generation)) return false
    const current = session.scope
    if (
      current === null ||
      current.inFlight !== undefined ||
      current.ambiguousSubmit !== undefined
    ) {
      return false
    }
    session.scope = editScopeReducer(current, {
      type: 'discard',
      ...(current.staleRemote === undefined ? {} : { baseline: current.staleRemote }),
    })
    session.saveView = { status: 'idle', error: null }
    bump(session)
    return true
  }, [bump, generation, resourceIdentity, session])

  const scope = session.scope
  const loaded = scope !== null
  const outcomeUnknown = scope?.ambiguousSubmit !== undefined
  const busy = scope?.inFlight !== undefined || session.saveView.status === 'pending'
  const stale = scope?.staleRemote !== undefined || outcomeUnknown

  return {
    loaded,
    value: scope?.draft ?? null,
    dirty: scope?.dirty ?? false,
    busy,
    stale,
    outcomeUnknown,
    setValue,
    reconcile,
    discard,
    query: {
      status: loaded ? 'success' : query.status,
      fetchStatus: query.fetchStatus,
      isPending: !loaded && query.isPending,
      isLoading: !loaded && query.isLoading,
      isFetching: query.isFetching,
      isSuccess: loaded,
      isError: query.isError,
      error: query.error,
      refetch: async () => query.refetch(),
    },
    save: {
      prepare,
      mutate,
      isPending: session.saveView.status === 'pending',
      isSuccess: session.saveView.status === 'success',
      error: session.saveView.status === 'error' ? session.saveView.error : null,
    },
  }
}
