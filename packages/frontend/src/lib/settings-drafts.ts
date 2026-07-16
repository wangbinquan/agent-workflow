// RFC-201 PR-A/T2 — route-owned Settings Config draft registry.
//
// Settings renders only its active panel. Keeping the seven Config-backed
// section drafts here (rather than in panel-local React state) makes unmount a
// presentation detail and gives every GET/PUT receipt one causal reducer path.
// Runtime writes through its own immediate resource owner; Authentication is
// an independent resource and intentionally has no fake Config scope.

import type { Config, ConfigPatch } from '@agent-workflow/shared'
import {
  aggregateEditScopeStates,
  createEditScopeState,
  defaultEditScopeSemanticEqual,
  editScopeReducer,
  type EditScopeAggregateState,
  type EditScopeState,
  type EditScopeSubmitOutcome,
} from '@/lib/edit-scope'
import {
  shouldAcceptConfigReadReceipt,
  type ConfigReadReceipt,
  type ConfigWriteReceipt,
} from '@/lib/config-receipts'

/** Stable leaf -> scope ids. System Agents' Agent-row draft is a separate owner. */
export const SETTINGS_CONFIG_SCOPE_IDS = {
  systemAgents: 'settings.systemAgents.config',
  limits: 'settings.limits',
  recovery: 'settings.recovery',
  gc: 'settings.gc',
  network: 'settings.network',
  appearance: 'settings.appearance',
  rendering: 'settings.rendering',
} as const

/** Exact ConfigPatch ownership; also serves as the minimal-write allowlist. */
export const SETTINGS_CONFIG_SCOPE_KEYS = {
  systemAgents: [
    'commitPushRuntime',
    'commitPushModel',
    'commitPushMaxRepairRetries',
    'commitPushDiffMaxBytes',
    'commitPushLang',
    'memoryDistillRuntime',
    'memoryDistillModel',
    'memoryDistillLang',
    'mergeAgentRuntime',
    'mergeAgentModel',
  ],
  limits: [
    'defaultPerTaskMaxDurationMs',
    'defaultPerTaskMaxTotalTokens',
    'defaultPerNodeTimeoutMs',
    'defaultNodeRetries',
    'largeOutputThresholdBytes',
    'maxConcurrentNodes',
    'multiProcessSubprocessConcurrency',
    'logLevel',
  ],
  recovery: [
    'autoResumeOnBoot',
    'autoRepair',
    'autoKillStalledChild',
    'heartbeatStallMs',
    'maxAutoRecoveriesPerWindow',
    'autoRecoveryWindowMs',
    'periodicOrphanReconcileMs',
  ],
  gc: ['worktreeAutoGc', 'eventsArchiveThresholds'],
  network: ['bindHost', 'bindPort'],
  appearance: ['theme', 'language'],
  rendering: ['plantumlEndpoint', 'plantumlAuthHeader'],
} as const satisfies Record<keyof typeof SETTINGS_CONFIG_SCOPE_IDS, readonly (keyof ConfigPatch)[]>

export type SettingsConfigSection = keyof typeof SETTINGS_CONFIG_SCOPE_IDS
export type SettingsConfigScopeId = (typeof SETTINGS_CONFIG_SCOPE_IDS)[SettingsConfigSection]
export type SettingsConfigScopeState = EditScopeState<ConfigPatch>

export type SettingsConfigScopeStates = {
  [ScopeId in SettingsConfigScopeId]: SettingsConfigScopeState
}

export interface SettingsDraftRegistryState {
  /** ConfigReceiptCoordinator auth/base-url generation owned by this route. */
  generation: number
  /** Stable daemon resource identity; credential-only rotations keep this key. */
  resourceIdentity: string
  /** Global resource fence: a write response covers every Config projection. */
  ignoreReadsThroughEpoch?: number
  lastAcceptedReadEpoch?: number
  lastAcceptedWriteEpoch?: number
  /** Latest full Config accepted by issue/write order, used to replay late own callbacks. */
  latestAuthoritativeConfig: Config
  scopes: SettingsConfigScopeStates
}

export interface CreateSettingsDraftRegistryOptions {
  generation?: number
  resourceIdentity?: string
  /** Set when the initial Config came from an already-issued read receipt. */
  issuedEpoch?: number
}

export type SettingsConfigWriteReceipt = Pick<
  ConfigWriteReceipt,
  'config' | 'generation' | 'writeEpoch' | 'ignoreReadsThroughEpoch'
>

export type SettingsDraftRegistryEvent =
  | { type: 'edit'; scope: SettingsConfigScopeId; draft: ConfigPatch }
  | {
      type: 'validity'
      scope: SettingsConfigScopeId
      validity: 'valid' | 'invalid'
      firstInvalidTarget?: string
    }
  | {
      type: 'begin-submit'
      scope: SettingsConfigScopeId
      requestId: string
      submittedRevision: number
    }
  | {
      type: 'submit-success'
      scope: SettingsConfigScopeId
      requestId: string
      submittedRevision: number
      receipt: SettingsConfigWriteReceipt
    }
  | { type: 'config-write'; receipt: SettingsConfigWriteReceipt }
  | {
      type: 'submit-error'
      scope: SettingsConfigScopeId
      requestId: string
      submittedRevision: number
      error: unknown
      outcome: EditScopeSubmitOutcome
    }
  | {
      type: 'discard'
      scope: SettingsConfigScopeId
      /** Required by edit-scope when abandoning an outcome-unknown submit. */
      baseline?: ConfigPatch
    }
  | { type: 'discard-all' }
  | { type: 'config-read'; receipt: ConfigReadReceipt }

const SETTINGS_CONFIG_SECTIONS = Object.keys(SETTINGS_CONFIG_SCOPE_IDS) as SettingsConfigSection[]

const SECTION_BY_SCOPE: Record<SettingsConfigScopeId, SettingsConfigSection> = {
  [SETTINGS_CONFIG_SCOPE_IDS.systemAgents]: 'systemAgents',
  [SETTINGS_CONFIG_SCOPE_IDS.limits]: 'limits',
  [SETTINGS_CONFIG_SCOPE_IDS.recovery]: 'recovery',
  [SETTINGS_CONFIG_SCOPE_IDS.gc]: 'gc',
  [SETTINGS_CONFIG_SCOPE_IDS.network]: 'network',
  [SETTINGS_CONFIG_SCOPE_IDS.appearance]: 'appearance',
  [SETTINGS_CONFIG_SCOPE_IDS.rendering]: 'rendering',
}

/** Project a full Config (or a section draft) onto one exact owned patch. */
export function projectSettingsConfigScope(
  scope: SettingsConfigScopeId,
  config: Config | ConfigPatch,
): ConfigPatch {
  const source = config as unknown as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const key of settingsConfigScopeKeys(scope)) projected[key] = source[key]
  return projected as ConfigPatch
}

export function settingsConfigScopeKeys(
  scope: SettingsConfigScopeId,
): readonly (keyof ConfigPatch)[] {
  return SETTINGS_CONFIG_SCOPE_KEYS[SECTION_BY_SCOPE[scope]]
}

export function createSettingsDraftRegistry(
  config: Config,
  options: CreateSettingsDraftRegistryOptions = {},
): SettingsDraftRegistryState {
  const generation = options.generation ?? 1
  const create = (scope: SettingsConfigScopeId): SettingsConfigScopeState => {
    const state = createEditScopeState(projectSettingsConfigScope(scope, config))
    return options.issuedEpoch === undefined
      ? state
      : { ...state, lastAcceptedReadEpoch: options.issuedEpoch }
  }

  return {
    generation,
    resourceIdentity: options.resourceIdentity ?? 'config-resource:default',
    lastAcceptedReadEpoch: options.issuedEpoch,
    latestAuthoritativeConfig: config,
    scopes: {
      [SETTINGS_CONFIG_SCOPE_IDS.systemAgents]: create(SETTINGS_CONFIG_SCOPE_IDS.systemAgents),
      [SETTINGS_CONFIG_SCOPE_IDS.limits]: create(SETTINGS_CONFIG_SCOPE_IDS.limits),
      [SETTINGS_CONFIG_SCOPE_IDS.recovery]: create(SETTINGS_CONFIG_SCOPE_IDS.recovery),
      [SETTINGS_CONFIG_SCOPE_IDS.gc]: create(SETTINGS_CONFIG_SCOPE_IDS.gc),
      [SETTINGS_CONFIG_SCOPE_IDS.network]: create(SETTINGS_CONFIG_SCOPE_IDS.network),
      [SETTINGS_CONFIG_SCOPE_IDS.appearance]: create(SETTINGS_CONFIG_SCOPE_IDS.appearance),
      [SETTINGS_CONFIG_SCOPE_IDS.rendering]: create(SETTINGS_CONFIG_SCOPE_IDS.rendering),
    },
  }
}

export function createSettingsDraftRegistryFromReadReceipt(
  receipt: ConfigReadReceipt,
  resourceIdentity?: string,
): SettingsDraftRegistryState {
  return createSettingsDraftRegistry(receipt.config, {
    generation: receipt.generation,
    issuedEpoch: receipt.issuedEpoch,
    resourceIdentity,
  })
}

/** Credential rotation keeps the same daemon resource and every local draft. */
export function rebaseSettingsDraftRegistryGeneration(
  registry: SettingsDraftRegistryState,
  generation: number,
): SettingsDraftRegistryState {
  return registry.generation === generation ? registry : { ...registry, generation }
}

export function getSettingsDraftScope(
  registry: SettingsDraftRegistryState,
  scope: SettingsConfigScopeId,
): SettingsConfigScopeState {
  return registry.scopes[scope]
}

/** The exact minimal ConfigPatch owned by a section, ready for coordinator.write. */
export function selectSettingsConfigPatch(
  registry: SettingsDraftRegistryState,
  scope: SettingsConfigScopeId,
): ConfigPatch {
  const state = registry.scopes[scope]
  const baseline = state.baseline as Record<string, unknown>
  const draft = state.draft as Record<string, unknown>
  const changed: Record<string, unknown> = {}
  for (const key of settingsConfigScopeKeys(scope)) {
    if (!defaultEditScopeSemanticEqual(baseline[key], draft[key])) changed[key] = draft[key]
  }
  return changed as ConfigPatch
}

export function aggregateSettingsDraftRegistry(
  registry: SettingsDraftRegistryState,
): EditScopeAggregateState {
  return aggregateEditScopeStates(Object.values(registry.scopes))
}

export function settingsDraftRegistryReducer(
  registry: SettingsDraftRegistryState,
  event: SettingsDraftRegistryEvent,
): SettingsDraftRegistryState {
  switch (event.type) {
    case 'config-read':
      return applyConfigRead(registry, event.receipt)

    case 'config-write':
      return applyConfigWrite(registry, event.receipt)

    case 'submit-success':
      return applySubmitSuccess(registry, event)

    case 'edit':
      return replaceScope(
        registry,
        event.scope,
        editScopeReducer(registry.scopes[event.scope], {
          type: 'edit',
          draft: projectSettingsConfigScope(event.scope, event.draft),
        }),
      )

    case 'validity':
      return replaceScope(
        registry,
        event.scope,
        editScopeReducer(registry.scopes[event.scope], {
          type: 'validity',
          validity: event.validity,
          firstInvalidTarget: event.firstInvalidTarget,
        }),
      )

    case 'begin-submit':
      return replaceScope(
        registry,
        event.scope,
        editScopeReducer(registry.scopes[event.scope], {
          type: 'begin-submit',
          requestId: event.requestId,
          submittedRevision: event.submittedRevision,
        }),
      )

    case 'submit-error':
      return replaceScope(
        registry,
        event.scope,
        editScopeReducer(registry.scopes[event.scope], {
          type: 'submit-error',
          requestId: event.requestId,
          submittedRevision: event.submittedRevision,
          error: event.error,
          outcome: event.outcome,
        }),
      )

    case 'discard':
      return replaceScope(
        registry,
        event.scope,
        editScopeReducer(registry.scopes[event.scope], {
          type: 'discard',
          baseline:
            event.baseline === undefined
              ? undefined
              : projectSettingsConfigScope(event.scope, event.baseline),
        }),
      )

    case 'discard-all':
      return {
        ...registry,
        scopes: mapScopes(registry.scopes, (scope, state) =>
          editScopeReducer(state, {
            type: 'discard',
            baseline: projectSettingsConfigScope(scope, registry.latestAuthoritativeConfig),
          }),
        ),
      }
  }
}

function applyConfigRead(
  registry: SettingsDraftRegistryState,
  receipt: ConfigReadReceipt,
): SettingsDraftRegistryState {
  if (
    !shouldAcceptConfigReadReceipt(receipt, {
      generation: registry.generation,
      ignoreReadsThroughEpoch: registry.ignoreReadsThroughEpoch,
      lastAcceptedReadEpoch: registry.lastAcceptedReadEpoch,
    })
  ) {
    return registry
  }

  return {
    ...registry,
    lastAcceptedReadEpoch: receipt.issuedEpoch,
    latestAuthoritativeConfig: receipt.config,
    scopes: mapScopes(registry.scopes, (scope, state) =>
      editScopeReducer(state, {
        type: 'remote-read',
        remote: projectSettingsConfigScope(scope, receipt.config),
        issuedEpoch: receipt.issuedEpoch,
      }),
    ),
  }
}

function applySubmitSuccess(
  registry: SettingsDraftRegistryState,
  event: Extract<SettingsDraftRegistryEvent, { type: 'submit-success' }>,
): SettingsDraftRegistryState {
  const target = registry.scopes[event.scope]
  if (
    target.inFlight?.requestId !== event.requestId ||
    target.inFlight.submittedRevision !== event.submittedRevision
  ) {
    // A late/mismatched write may not advance any projection or the resource
    // read fence; only the exact current submission owns this receipt.
    return registry
  }

  if (event.receipt.generation !== registry.generation) {
    // Credential-only rotation can occur synchronously after the coordinator
    // publishes this exact write but before the awaiting mutation continuation
    // runs. Settle only a receipt the registry already accepted by writeEpoch;
    // an unobserved old-generation callback remains fenced.
    if (
      registry.lastAcceptedWriteEpoch === undefined ||
      event.receipt.writeEpoch > registry.lastAcceptedWriteEpoch
    ) {
      return registry
    }
    return settleMatchingSubmitAgainstLatest(registry, event.receipt, {
      scope: event.scope,
      requestId: event.requestId,
      submittedRevision: event.submittedRevision,
    })
  }

  return applyConfigWrite(registry, event.receipt, {
    scope: event.scope,
    requestId: event.requestId,
    submittedRevision: event.submittedRevision,
  })
}

interface MatchingSettingsSubmission {
  scope: SettingsConfigScopeId
  requestId: string
  submittedRevision: number
}

function applyConfigWrite(
  registry: SettingsDraftRegistryState,
  receipt: SettingsConfigWriteReceipt,
  matchingSubmission?: MatchingSettingsSubmission,
): SettingsDraftRegistryState {
  if (receipt.generation !== registry.generation) return registry
  if (
    registry.lastAcceptedWriteEpoch !== undefined &&
    receipt.writeEpoch <= registry.lastAcceptedWriteEpoch
  ) {
    // The coordinator subscription may publish W1, then W2, before the route's
    // mutation callback for W1 runs. A matching old/equal callback still owns
    // its in-flight flag, but may not replay W1 over the already-accepted W2.
    return matchingSubmission === undefined
      ? registry
      : settleMatchingSubmitAgainstLatest(registry, receipt, matchingSubmission)
  }

  const ignoreReadsThroughEpoch = Math.max(
    registry.ignoreReadsThroughEpoch ?? 0,
    receipt.ignoreReadsThroughEpoch,
  )
  // A full PUT response is authoritative after every read <= floor and before
  // the coordinator's post-settle GET (> floor). The half-step is an internal
  // causal marker, never a fabricated transport receipt.
  const writeCausalEpoch = ignoreReadsThroughEpoch + 0.5

  return {
    ...registry,
    ignoreReadsThroughEpoch,
    lastAcceptedWriteEpoch: receipt.writeEpoch,
    latestAuthoritativeConfig: receipt.config,
    scopes: mapScopes(registry.scopes, (scope, state) => {
      const remote = projectSettingsConfigScope(scope, receipt.config)
      const reconciled =
        matchingSubmission !== undefined && scope === matchingSubmission.scope
          ? editScopeReducer(state, {
              type: 'submit-success',
              requestId: matchingSubmission.requestId,
              submittedRevision: matchingSubmission.submittedRevision,
              persisted: remote,
              ignoreReadsThroughEpoch,
            })
          : editScopeReducer(state, {
              type: 'remote-read',
              remote,
              issuedEpoch: writeCausalEpoch,
            })

      return {
        ...reconciled,
        ignoreReadsThroughEpoch: Math.max(
          reconciled.ignoreReadsThroughEpoch ?? 0,
          ignoreReadsThroughEpoch,
        ),
      }
    }),
  }
}

function settleMatchingSubmitAgainstLatest(
  registry: SettingsDraftRegistryState,
  receipt: SettingsConfigWriteReceipt,
  submission: MatchingSettingsSubmission,
): SettingsDraftRegistryState {
  const state = registry.scopes[submission.scope]
  if (
    state.inFlight?.requestId !== submission.requestId ||
    state.inFlight.submittedRevision !== submission.submittedRevision
  ) {
    return registry
  }

  const ignoreReadsThroughEpoch = Math.max(
    registry.ignoreReadsThroughEpoch ?? 0,
    receipt.ignoreReadsThroughEpoch,
  )
  const settled = editScopeReducer(state, {
    type: 'submit-success',
    requestId: submission.requestId,
    submittedRevision: submission.submittedRevision,
    persisted: projectSettingsConfigScope(submission.scope, receipt.config),
    ignoreReadsThroughEpoch,
  })
  const latestCausalEpoch =
    Math.max(
      ignoreReadsThroughEpoch,
      registry.lastAcceptedReadEpoch ?? 0,
      settled.lastAcceptedReadEpoch ?? 0,
    ) + 0.5
  const replayed = editScopeReducer(settled, {
    type: 'remote-read',
    remote: projectSettingsConfigScope(submission.scope, registry.latestAuthoritativeConfig),
    issuedEpoch: latestCausalEpoch,
  })

  return replaceScope(registry, submission.scope, {
    ...replayed,
    ignoreReadsThroughEpoch: Math.max(
      replayed.ignoreReadsThroughEpoch ?? 0,
      ignoreReadsThroughEpoch,
    ),
  })
}

function replaceScope(
  registry: SettingsDraftRegistryState,
  scope: SettingsConfigScopeId,
  next: SettingsConfigScopeState,
): SettingsDraftRegistryState {
  if (next === registry.scopes[scope]) return registry
  return { ...registry, scopes: { ...registry.scopes, [scope]: next } }
}

function mapScopes(
  scopes: SettingsConfigScopeStates,
  project: (
    scope: SettingsConfigScopeId,
    state: SettingsConfigScopeState,
  ) => SettingsConfigScopeState,
): SettingsConfigScopeStates {
  const next: SettingsConfigScopeStates = { ...scopes }
  for (const section of SETTINGS_CONFIG_SECTIONS) {
    const scope = SETTINGS_CONFIG_SCOPE_IDS[section]
    next[scope] = project(scope, scopes[scope])
  }
  return next
}
