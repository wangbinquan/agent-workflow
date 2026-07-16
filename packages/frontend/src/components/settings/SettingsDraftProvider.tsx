// RFC-201 PR-A — React owner for Settings' Config-backed section drafts.
//
// Settings mounts only the active section.  The provider deliberately lives
// above that presentation boundary so changing `?tab=` cannot reconstruct a
// draft, lose an in-flight receipt, or weaken the route-level navigation guard.

import { useQueryClient } from '@tanstack/react-query'
import { ConfigPatchSchema, type Config, type ConfigPatch } from '@agent-workflow/shared'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import {
  allowSameResourceSectionChange,
  defaultEditScopeSemanticEqual,
  editScopeReducer,
} from '@/lib/edit-scope'
import {
  cacheConfigWriteReceipt,
  configReceiptCoordinator,
  ensureConfigReceiptGeneration,
  getConfigQueryKey,
  getConfigResourceIdentity,
  readConfigReceipt,
  writeConfigPatch,
} from '@/lib/config-resource'
import {
  ConfigAmbiguousWriteError,
  ConfigReceiptGenerationError,
  type ConfigReadReceipt,
} from '@/lib/config-receipts'
import {
  aggregateSettingsDraftRegistry,
  createSettingsDraftRegistry,
  createSettingsDraftRegistryFromReadReceipt,
  projectSettingsConfigScope,
  rebaseSettingsDraftRegistryGeneration,
  selectSettingsConfigPatch,
  settingsDraftRegistryReducer,
  type SettingsConfigScopeId,
  type SettingsDraftRegistryEvent,
  type SettingsDraftRegistryState,
} from '@/lib/settings-drafts'

interface SettingsDraftOwner {
  registry: SettingsDraftRegistryState
  getRegistry: () => SettingsDraftRegistryState
  dispatch: (event: SettingsDraftRegistryEvent) => void
  replace: (registry: SettingsDraftRegistryState) => void
  reconcileAmbiguousRead: (
    scope: SettingsConfigScopeId,
    receipt: ConfigReadReceipt,
    requestId: string,
    submittedRevision: number,
  ) => boolean
}

const SettingsDraftContext = createContext<SettingsDraftOwner | null>(null)

/** Read-only registry projection for route navigation status markers. */
export function useSettingsDraftRegistry(): SettingsDraftRegistryState | null {
  return useContext(SettingsDraftContext)?.registry ?? null
}

function registryFromCurrentResource(config: Config): SettingsDraftRegistryState {
  const generation = ensureConfigReceiptGeneration()
  const resourceIdentity = getConfigResourceIdentity()
  const snapshot = configReceiptCoordinator.getSnapshot()
  if (snapshot?.generation !== generation) {
    return createSettingsDraftRegistry(config, { generation, resourceIdentity })
  }
  if (snapshot.type === 'read') {
    return createSettingsDraftRegistryFromReadReceipt(snapshot, resourceIdentity)
  }
  return settingsDraftRegistryReducer(
    createSettingsDraftRegistry(config, { generation, resourceIdentity }),
    {
      type: 'config-write',
      receipt: snapshot,
    },
  )
}

function hashFromRouterLocation(location: unknown): string {
  const candidate = location as { hash?: unknown; href?: unknown }
  if (typeof candidate.hash === 'string') return candidate.hash
  if (typeof candidate.href !== 'string') return ''
  const index = candidate.href.indexOf('#')
  return index === -1 ? '' : candidate.href.slice(index)
}

function reconcileAmbiguousReceipt(
  registry: SettingsDraftRegistryState,
  scope: SettingsConfigScopeId,
  receipt: ConfigReadReceipt,
  requestId: string,
  submittedRevision: number,
): { registry: SettingsDraftRegistryState; confirmed: boolean } {
  const afterRead = settingsDraftRegistryReducer(registry, { type: 'config-read', receipt })
  if (
    receipt.generation !== registry.generation ||
    afterRead.lastAcceptedReadEpoch !== receipt.issuedEpoch
  ) {
    return { registry: afterRead, confirmed: false }
  }

  const state = afterRead.scopes[scope]
  const attempt = state.ambiguousSubmit
  if (attempt?.requestId !== requestId || attempt.submittedRevision !== submittedRevision) {
    return { registry: afterRead, confirmed: false }
  }

  const remote = projectSettingsConfigScope(scope, receipt.config)
  const confirmed = defaultEditScopeSemanticEqual(remote, attempt.submitted)
  const reconciled = editScopeReducer(state, {
    type: 'remote-read',
    remote,
    issuedEpoch: receipt.issuedEpoch,
    reconciliation: { requestId, submittedRevision },
  })
  return {
    registry: {
      ...afterRead,
      scopes: { ...afterRead.scopes, [scope]: reconciled },
    },
    confirmed,
  }
}

function useRegistryOwner(
  createInitial: () => SettingsDraftRegistryState,
  onChange?: (registry: SettingsDraftRegistryState) => void,
): SettingsDraftOwner {
  const [registry, setRegistry] = useState(createInitial)
  const registryRef = useRef(registry)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  registryRef.current = registry

  const replace = useCallback((next: SettingsDraftRegistryState) => {
    registryRef.current = next
    onChangeRef.current?.(next)
    setRegistry(next)
  }, [])
  const getRegistry = useCallback(() => registryRef.current, [])

  const dispatch = useCallback(
    (event: SettingsDraftRegistryEvent) => {
      replace(settingsDraftRegistryReducer(registryRef.current, event))
    },
    [replace],
  )

  const reconcileAmbiguousRead = useCallback(
    (
      scope: SettingsConfigScopeId,
      receipt: ConfigReadReceipt,
      requestId: string,
      submittedRevision: number,
    ) => {
      const result = reconcileAmbiguousReceipt(
        registryRef.current,
        scope,
        receipt,
        requestId,
        submittedRevision,
      )
      replace(result.registry)
      return result.confirmed
    },
    [replace],
  )

  return useMemo(
    () => ({
      registry,
      getRegistry,
      dispatch,
      replace,
      reconcileAmbiguousRead,
    }),
    [dispatch, getRegistry, reconcileAmbiguousRead, registry, replace],
  )
}

export interface SettingsDraftProviderProps {
  config: Config
  /** Independent Settings resources (currently the fusion Agent row). */
  externalDirty?: boolean
  externalBusy?: boolean
  externalOutcomeUnknown?: boolean
  externalDiscard?: () => void
  children: ReactNode
}

export function SettingsDraftProvider({
  config,
  externalDirty = false,
  externalBusy = false,
  externalOutcomeUnknown = false,
  externalDiscard,
  children,
}: SettingsDraftProviderProps) {
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const syncGuardRefs = useCallback(
    (registry: SettingsDraftRegistryState) => {
      const aggregate = aggregateSettingsDraftRegistry(registry)
      dirtyRef.current = aggregate.dirty || externalDirty ? 'settings' : null
      busyRef.current =
        aggregate.busy || aggregate.outcomeUnknown || externalBusy || externalOutcomeUnknown
    },
    [externalBusy, externalDirty, externalOutcomeUnknown],
  )
  const owner = useRegistryOwner(() => registryFromCurrentResource(config), syncGuardRefs)
  const { dispatch, getRegistry, replace } = owner
  const processedReceiptRef = useRef(configReceiptCoordinator.getSnapshot())

  // Keep refs correct on the first render as well as in synchronous dispatches.
  syncGuardRefs(owner.registry)

  useEffect(() => {
    const syncAcceptedSnapshot = () => {
      syncGuardRefs(getRegistry())
      const generation = ensureConfigReceiptGeneration()
      const resourceIdentity = getConfigResourceIdentity()
      if (getRegistry().resourceIdentity !== resourceIdentity) {
        // A daemon switch is a new resource, not an auth rebase. Never carry
        // daemon A's baseline/draft/in-flight state into daemon B.
        processedReceiptRef.current = undefined
        replace(createSettingsDraftRegistry(config, { generation, resourceIdentity }))
      } else if (getRegistry().generation !== generation) {
        // A credential-only rotation still targets the same daemon. Preserve
        // local drafts while fencing every old-token transport receipt.
        processedReceiptRef.current = undefined
        replace(rebaseSettingsDraftRegistryGeneration(getRegistry(), generation))
      }

      const receipt = configReceiptCoordinator.getSnapshot()
      if (receipt === undefined || receipt === processedReceiptRef.current) return
      processedReceiptRef.current = receipt
      if (receipt.generation !== getRegistry().generation) return
      dispatch(
        receipt.type === 'read'
          ? { type: 'config-read', receipt }
          : { type: 'config-write', receipt },
      )
    }

    syncAcceptedSnapshot()
    return configReceiptCoordinator.subscribe(syncAcceptedSnapshot)
  }, [config, dispatch, getRegistry, replace, syncGuardRefs])

  const discardAll = useCallback(() => {
    const aggregate = aggregateSettingsDraftRegistry(getRegistry())
    if (aggregate.busy || aggregate.outcomeUnknown || externalBusy || externalOutcomeUnknown) {
      return false
    }
    dispatch({ type: 'discard-all' })
    externalDiscard?.()
    return true
  }, [dispatch, externalBusy, externalDiscard, externalOutcomeUnknown, getRegistry])

  return (
    <SettingsDraftContext.Provider value={owner}>
      {children}
      <UnsavedChangesGuard
        dirtyRef={dirtyRef}
        busyRef={busyRef}
        shouldBlockNavigation={({ current, next }) =>
          !allowSameResourceSectionChange(
            {
              pathname: current.pathname,
              search: current.search as unknown as Readonly<Record<string, unknown>>,
              hash: hashFromRouterLocation(current),
            },
            {
              pathname: next.pathname,
              search: next.search as unknown as Readonly<Record<string, unknown>>,
              hash: hashFromRouterLocation(next),
            },
            {
              sectionKeys: ['tab'],
              resourceIdentity: (location) =>
                location.pathname === '/settings' ? 'settings' : null,
            },
          )
        }
        onDiscard={discardAll}
      />
    </SettingsDraftContext.Provider>
  )
}

export interface UseSettingsConfigDraftOptions {
  onSaved?: (config: Config, submitted: ConfigPatch, baseline: ConfigPatch) => void
}

export interface SettingsConfigDraftMutateOptions {
  onSuccess?: (config: Config) => void
  onError?: (error: unknown) => void
  onSettled?: (config: Config | undefined, error: unknown | null) => void
}

export interface SettingsConfigDraftSaveController {
  /** Mirrors the mutation call shape used by existing Settings leaves. */
  mutate: (variables?: undefined, options?: SettingsConfigDraftMutateOptions) => void
  isPending: boolean
  isSuccess: boolean
  error: unknown
}

export interface SettingsConfigDraftController {
  state: ConfigPatch
  baseline: ConfigPatch
  setState: Dispatch<SetStateAction<ConfigPatch>>
  dirty: boolean
  validity: 'valid' | 'invalid' | 'unknown'
  firstInvalidTarget?: string
  stale: boolean
  outcomeUnknown: boolean
  writeBlocked: boolean
  reconcile: () => void
  discard: () => void
  save: SettingsConfigDraftSaveController
}

let requestSequence = 0

function nextRequestId(scope: SettingsConfigScopeId): string {
  requestSequence += 1
  return `${scope}:${Date.now()}:${requestSequence}`
}

function firstInvalidTarget(error: { issues: readonly { path: PropertyKey[] }[] }): string {
  const path = error.issues[0]?.path
  return path === undefined || path.length === 0 ? 'settings' : path.map(String).join('.')
}

/**
 * Config-backed Settings leaf adapter.  The fallback owner is intentional:
 * exported leaf components remain independently renderable in focused tests,
 * while the real route transparently uses the provider's persistent owner.
 */
export function useSettingsConfigDraft(
  scope: SettingsConfigScopeId,
  fallbackConfig: Config,
  options: UseSettingsConfigDraftOptions = {},
): SettingsConfigDraftController {
  const contextOwner = useContext(SettingsDraftContext)
  // Isolated leaf tests pass their own authoritative fixture; do not let a
  // singleton receipt left by an unrelated mounted surface replace it.
  const fallbackOwner = useRegistryOwner(() =>
    createSettingsDraftRegistry(fallbackConfig, {
      generation: ensureConfigReceiptGeneration(),
      resourceIdentity: getConfigResourceIdentity(),
    }),
  )
  const owner = contextOwner ?? fallbackOwner
  const queryClient = useQueryClient()
  const onSavedRef = useRef(options.onSaved)
  onSavedRef.current = options.onSaved
  const [isSuccess, setIsSuccess] = useState(false)
  const [localError, setLocalError] = useState<unknown>(null)
  const writeBlock = useSyncExternalStore(
    configReceiptCoordinator.subscribe,
    configReceiptCoordinator.getWriteBlock,
    configReceiptCoordinator.getWriteBlock,
  )
  const scopeState = owner.registry.scopes[scope]

  const setState = useCallback<Dispatch<SetStateAction<ConfigPatch>>>(
    (update) => {
      const previous = owner.getRegistry().scopes[scope].draft
      const draft =
        typeof update === 'function'
          ? (update as (previous: ConfigPatch) => ConfigPatch)(previous)
          : update
      owner.dispatch({ type: 'edit', scope, draft })
      const parsed = ConfigPatchSchema.safeParse(projectSettingsConfigScope(scope, draft))
      owner.dispatch(
        parsed.success
          ? { type: 'validity', scope, validity: 'valid' }
          : {
              type: 'validity',
              scope,
              validity: 'invalid',
              firstInvalidTarget: firstInvalidTarget(parsed.error),
            },
      )
      setIsSuccess(false)
      setLocalError(null)
    },
    [owner, scope],
  )

  const mutate = useCallback(
    (_variables?: undefined, mutateOptions?: SettingsConfigDraftMutateOptions) => {
      void (async () => {
        const initial = owner.getRegistry().scopes[scope]
        if (initial.inFlight !== undefined || initial.ambiguousSubmit !== undefined) return

        const submitted = selectSettingsConfigPatch(owner.getRegistry(), scope)
        const parsed = ConfigPatchSchema.safeParse(submitted)
        if (!parsed.success) {
          owner.dispatch({
            type: 'validity',
            scope,
            validity: 'invalid',
            firstInvalidTarget: firstInvalidTarget(parsed.error),
          })
          setIsSuccess(false)
          setLocalError(parsed.error)
          return
        }

        owner.dispatch({ type: 'validity', scope, validity: 'valid' })
        const ready = owner.getRegistry().scopes[scope]
        if (!ready.dirty) {
          setLocalError(null)
          setIsSuccess(true)
          // A fusion-only System Agents save must not manufacture a Config PUT,
          // but its caller still needs to continue the config-first sequence.
          mutateOptions?.onSuccess?.(fallbackConfig)
          mutateOptions?.onSettled?.(fallbackConfig, null)
          return
        }

        const requestId = nextRequestId(scope)
        const submittedRevision = ready.revision
        const submittedBaseline = ready.baseline
        owner.dispatch({ type: 'begin-submit', scope, requestId, submittedRevision })
        setIsSuccess(false)
        setLocalError(null)

        try {
          const receipt = await writeConfigPatch(parsed.data)
          cacheConfigWriteReceipt(queryClient, receipt)
          const beforeSettle = owner.getRegistry().scopes[scope]
          const callbackGeneration = owner.getRegistry().generation
          const ownsReceipt =
            beforeSettle.inFlight?.requestId === requestId &&
            beforeSettle.inFlight.submittedRevision === submittedRevision
          owner.dispatch({
            type: 'submit-success',
            scope,
            requestId,
            submittedRevision,
            receipt,
          })
          const settledRegistry = owner.getRegistry()
          const settled = settledRegistry.scopes[scope]
          const latestConfig = settledRegistry.latestAuthoritativeConfig
          const sameGeneration = receipt.generation === callbackGeneration
          const exactSettled = ownsReceipt && settled.inFlight === undefined
          setIsSuccess(exactSettled && sameGeneration && !settled.dirty)
          if (exactSettled) {
            onSavedRef.current?.(latestConfig, parsed.data, submittedBaseline)
            if (sameGeneration) {
              mutateOptions?.onSuccess?.(latestConfig)
              mutateOptions?.onSettled?.(latestConfig, null)
            } else {
              // The Config receipt was accepted before a credential rotation,
              // so settle its local in-flight state but do not continue a
              // multi-resource save under a different transport identity.
              const generationError = new ConfigReceiptGenerationError(
                receipt.generation,
                callbackGeneration,
              )
              setLocalError(generationError)
              mutateOptions?.onError?.(generationError)
              mutateOptions?.onSettled?.(undefined, generationError)
            }
          }
        } catch (error) {
          const beforeError = owner.getRegistry().scopes[scope]
          const ownsError =
            beforeError.inFlight?.requestId === requestId &&
            beforeError.inFlight.submittedRevision === submittedRevision
          if (!ownsError) return

          const outcome = error instanceof ConfigAmbiguousWriteError ? 'ambiguous' : 'definitive'
          owner.dispatch({
            type: 'submit-error',
            scope,
            requestId,
            submittedRevision,
            error,
            outcome,
          })
          setLocalError(error)
          setIsSuccess(false)
          if (outcome === 'definitive') {
            mutateOptions?.onError?.(error)
            mutateOptions?.onSettled?.(undefined, error)
            return
          }

          try {
            const receipt = await readConfigReceipt()
            if (configReceiptCoordinator.getSnapshot() === receipt) {
              queryClient.setQueryData<Config>(getConfigQueryKey(), receipt.config)
            }
            const activeWriteBlock = configReceiptCoordinator.getWriteBlock()
            if (activeWriteBlock !== undefined) {
              // The GET is advisory while the lost PUT can still commit later.
              // Keep the exact scope ambiguous so guard/UI remain truthful and
              // never unlock a second write from one racing read.
              setLocalError(activeWriteBlock)
              setIsSuccess(false)
              mutateOptions?.onError?.(activeWriteBlock)
              mutateOptions?.onSettled?.(undefined, activeWriteBlock)
              return
            }
            const confirmed = owner.reconcileAmbiguousRead(
              scope,
              receipt,
              requestId,
              submittedRevision,
            )
            const settled = owner.getRegistry().scopes[scope]
            if (confirmed) {
              const latestConfig = owner.getRegistry().latestAuthoritativeConfig
              setLocalError(null)
              setIsSuccess(!settled.dirty)
              onSavedRef.current?.(latestConfig, parsed.data, submittedBaseline)
              mutateOptions?.onSuccess?.(latestConfig)
              mutateOptions?.onSettled?.(latestConfig, null)
            } else {
              setLocalError(error)
              setIsSuccess(false)
              mutateOptions?.onError?.(error)
              mutateOptions?.onSettled?.(undefined, error)
            }
          } catch (reconcileError) {
            setLocalError(reconcileError)
            mutateOptions?.onError?.(error)
            mutateOptions?.onSettled?.(undefined, error)
          }
        }
      })()
    },
    [fallbackConfig, owner, queryClient, scope],
  )

  const reconcile = useCallback(() => {
    const current = owner.getRegistry().scopes[scope]
    const attempt = current.ambiguousSubmit
    if (attempt === undefined || current.inFlight !== undefined) return

    void readConfigReceipt().then(
      (receipt) => {
        if (configReceiptCoordinator.getSnapshot() !== receipt) {
          setLocalError(new Error('server settings changed while reconciling the draft'))
          return
        }
        const writeBlock = configReceiptCoordinator.getWriteBlock()
        if (writeBlock !== undefined) {
          setIsSuccess(false)
          setLocalError(writeBlock)
          return
        }
        const confirmed = owner.reconcileAmbiguousRead(
          scope,
          receipt,
          attempt.requestId,
          attempt.submittedRevision,
        )
        const settled = owner.getRegistry().scopes[scope]
        setIsSuccess(confirmed && !settled.dirty)
        setLocalError(null)
      },
      (error: unknown) => {
        setIsSuccess(false)
        setLocalError(error)
      },
    )
  }, [owner, scope])

  const discard = useCallback(() => {
    const current = owner.getRegistry().scopes[scope]
    if (current.inFlight !== undefined) return
    if (current.ambiguousSubmit === undefined) {
      // Once a causally accepted foreign read has marked this scope stale, the
      // warning's "use server settings" action must adopt that exact remote
      // projection. Falling back to the pre-conflict baseline would clear the
      // warning while silently restoring an older value that is no longer on
      // the server.
      owner.dispatch({
        type: 'discard',
        scope,
        ...(current.staleRemote === undefined ? {} : { baseline: current.staleRemote }),
      })
      setIsSuccess(false)
      setLocalError(null)
      return
    }

    const attempt = current.ambiguousSubmit
    if (attempt !== undefined && writeBlock !== undefined) {
      setLocalError(writeBlock)
      return
    }
    void readConfigReceipt().then(
      (receipt) => {
        if (configReceiptCoordinator.getSnapshot() !== receipt) {
          setLocalError(new Error('server settings changed while reconciling the draft'))
          return
        }
        owner.reconcileAmbiguousRead(scope, receipt, attempt.requestId, attempt.submittedRevision)
        owner.dispatch({
          type: 'discard',
          scope,
          baseline: projectSettingsConfigScope(scope, receipt.config),
        })
        setIsSuccess(false)
        setLocalError(null)
      },
      (error: unknown) => setLocalError(error),
    )
  }, [owner, scope, writeBlock])

  return {
    state: scopeState.draft,
    baseline: scopeState.baseline,
    setState,
    dirty: scopeState.dirty,
    validity: scopeState.validity,
    firstInvalidTarget: scopeState.firstInvalidTarget,
    stale: scopeState.staleRemote !== undefined,
    outcomeUnknown: scopeState.ambiguousSubmit !== undefined || writeBlock !== undefined,
    writeBlocked: writeBlock !== undefined,
    reconcile,
    discard,
    save: {
      mutate,
      isPending: scopeState.inFlight !== undefined,
      isSuccess,
      error: localError ?? scopeState.submitError?.error ?? null,
    },
  }
}
