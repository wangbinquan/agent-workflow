import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '@agent-workflow/shared'

import {
  ContainmentJsonValueSchema,
  PreparedChildContainmentPlanSchema,
  type ContainmentJsonValue,
  type PreparedChildContainmentPlan,
} from './containmentContract'
import { renderBwrapArgs, type SandboxPolicy } from './policy'
import type { SandboxMode, SandboxProvider, SpawnSandboxTopology } from './index'

/**
 * The closed registry of requirement bundles a consumer may demand. A profile
 * names WHAT is required, never WHO requires it: RFC-227 forbids a vendor or OS
 * name from acting as a capability criterion, and RFC-242 T5 made a second
 * runtime (Claude Code business nodes with local MCP) demand the exact same
 * model-child bundle the verified OpenCode path demands. The bundle is
 * therefore one entry with a capability name — `model-child-netless-v1`, the
 * 2026-07-31 rename of `opencode-verified-v1` — instead of two byte-identical
 * bundles that could drift apart. The id is process-local and per-run (receipt
 * → log/status/alert + the same-run verified launch manifest); no durable row,
 * session-owner identity digest or on-disk artifact survives across releases
 * keyed by it, which is why the rename needed no migration.
 *
 * Split a profile only when the demands actually diverge.
 */
export const CONTAINMENT_REQUIREMENT_PROFILES = {
  'runner-filesystem-v1': {
    id: 'runner-filesystem-v1',
    revision: '1',
    required: ['platformHomeIsolation', 'immutableArtifactView'],
    optional: ['descendantLifetimeBound'],
    childBoundary: 'none',
  },
  'model-child-netless-v1': {
    id: 'model-child-netless-v1',
    revision: '1',
    required: ['platformHomeIsolation', 'immutableArtifactView', 'modelChildNetworkDeny'],
    optional: ['descendantLifetimeBound'],
    childBoundary: 'model-controlled',
  },
  // RFC-253 — the OUTER process itself must have no network. Named for the
  // requirement, not the consumer (RFC-253's script node is the first caller,
  // but an agent-side egress control wanting the same bundle must reuse this
  // entry rather than mint a parallel one).
  //
  // `failClosed` is the deliberate exception to the mode table: for every other
  // profile a missing capability under `warn` degrades loudly and runs anyway,
  // which is the right trade when containment is defence in depth. Here the
  // capability IS the feature — a node that declared "no network" and then ran
  // WITH network has been silently escalated, so degrading is worse than
  // failing. Owning the rule here (rather than letting the caller re-read the
  // receipt and decide) keeps RFC-233's single admission authority intact.
  // RFC-253 impl-gate M1 — the read-only worktree bundle. Same required
  // capabilities as `runner-filesystem-v1`, but fail-closed, and that
  // difference is a REAL divergence in demand rather than a consumer label:
  // for an ordinary run containment is defence in depth, whereas a `readonly`
  // script node has already given up its isolated worktree on the strength of
  // this boundary. Degrading it does not reduce a safety margin, it hands the
  // node write access to the canonical tree with no merge-back discipline —
  // strictly worse than not setting the flag at all.
  'outer-readonly-v1': {
    id: 'outer-readonly-v1',
    revision: '1',
    required: ['platformHomeIsolation', 'immutableArtifactView'],
    optional: ['descendantLifetimeBound'],
    childBoundary: 'none',
    failClosed: true,
  },
  'outer-netless-v1': {
    id: 'outer-netless-v1',
    revision: '1',
    required: ['platformHomeIsolation', 'immutableArtifactView', 'outerNetworkDeny'],
    optional: ['descendantLifetimeBound'],
    childBoundary: 'none',
    failClosed: true,
  },
} as const

export type ContainmentRequirementProfileId = keyof typeof CONTAINMENT_REQUIREMENT_PROFILES
export type ContainmentDecision = 'contained' | 'degraded' | 'off' | 'blocked'
export type ContainmentCapabilityStrength = 'strong' | 'best-effort' | 'absent'
/**
 * The closed reason vocabulary, as an ARRAY so consumers that need a runtime
 * list (the verified-launch manifest's zod enum) derive it instead of hand
 * copying it. RFC-253 found the copy in verifiedManifest.ts drifting the moment
 * a code was added — the same "never re-listed" rule its neighbouring field
 * already documents.
 */
export const CONTAINMENT_REASON_CODES = [
  'platform-unsupported',
  'provider-not-found',
  'provider-path-not-canonical',
  'provider-owner-unsafe',
  'provider-mode-unsafe',
  'provider-parent-unsafe',
  'provider-trial-rejected',
  'provider-trial-timeout',
  'provider-lifecycle-unproven',
  'provider-contract-invalid',
  'provider-internal-error',
  'required-capability-missing',
  // RFC-253 — a fail-closed bundle was demanded while containment is switched
  // OFF. The capability may well be present; what is missing is any layer that
  // would APPLY it, so this is distinct from `required-capability-missing`.
  'containment-mode-off',
] as const
export type ContainmentReasonCode = (typeof CONTAINMENT_REASON_CODES)[number]

export type ContainmentTopology =
  | 'none'
  | 'runner-outer'
  | 'provider-child-only'
  | 'runner-outer-and-child'

export interface ContainmentRuntimeProjection {
  providerId: string | null
  mode: SandboxMode
  capabilities: Record<string, ContainmentCapabilityStrength>
  available: boolean
  degradedReasons: string[]
}

export interface ContainmentAdmissionReceipt {
  coordinatorBootId: string
  admissionGeneration: number
  policyGeneration: number
  probeGeneration: number | null
  probeCheckedAt: number | null
  providerId: string | null
  profileId: ContainmentRequirementProfileId
  requirementDigest: string
  mode: SandboxMode
  decision: ContainmentDecision
  requiredCapabilities: readonly string[]
  capabilities: Readonly<Record<string, ContainmentCapabilityStrength>>
  reasonCodes: readonly ContainmentReasonCode[]
  admittedAt: number
}

/**
 * Backend-only immutable result of one admission. The renderer and canonical
 * provider evidence deliberately never cross the API/DB boundary; the public
 * receipt is safe for logs, status and alerts.
 */
export interface PreparedContainmentPlan {
  readonly receipt: ContainmentAdmissionReceipt
  readonly topology: ContainmentTopology
  readonly spawnTopology: SpawnSandboxTopology
  readonly sandbox: SandboxProvider
  readonly childProvider: PreparedChildContainmentPlan
  readonly runtimeReceipt: ContainmentRuntimeProjection
}

export class ContainmentAdmissionError extends Error {
  readonly code = 'execution-identity-containment-required' as const
  readonly permanent = true
  readonly receipt: ContainmentAdmissionReceipt

  constructor(receipt: ContainmentAdmissionReceipt) {
    super('execution-identity-containment-required')
    this.name = 'ContainmentAdmissionError'
    this.receipt = receipt
  }
}

export class ContainmentProviderQualificationError extends Error {
  readonly containmentReason: ContainmentReasonCode

  constructor(reason: ContainmentReasonCode) {
    super(reason)
    this.name = 'ContainmentProviderQualificationError'
    this.containmentReason = reason
  }
}

export class ContainmentAdmissionAborted extends Error {
  constructor() {
    super('containment admission aborted')
    this.name = 'ContainmentAdmissionAborted'
  }
}

export interface QualifiedContainmentProvider {
  providerId: string
  capabilities: Readonly<Record<string, ContainmentCapabilityStrength>>
  childProvider: PreparedChildContainmentPlan
  sandbox: SandboxProvider
  /** Qualification failures that matter only to stronger profiles. */
  reasonCodes?: readonly ContainmentReasonCode[]
}

interface FailedContainmentQualification {
  providerId: string | null
  reasonCodes: readonly ContainmentReasonCode[]
}

type ContainmentQualification = QualifiedContainmentProvider | FailedContainmentQualification

export interface ContainmentCoordinatorOptions {
  provider: SandboxProvider
  /**
   * Trusted provider descriptor seam. Platform composition may supply a fully
   * qualified future provider without adding an OS/provider branch to runtime
   * consumers.
   */
  qualifyProvider?: () => Promise<QualifiedContainmentProvider>
  /**
   * Exact Linux qualification. Production injects requireRootOwnedBwrap(),
   * which proves canonical ownership, namespaces and lifecycle cleanup.
   */
  qualifyBwrap?: () => Promise<string>
  /**
   * Split Linux qualification. Filesystem-only callers stay contained when
   * the stronger model-child network topology is unavailable.
   */
  qualifyBwrapFilesystem?: () => Promise<string>
  qualifyBwrapFull?: (canonicalPath: string) => Promise<void>
  /** Exact Seatbelt trial; omitted callers use the provider's boot receipt. */
  qualifySeatbelt?: () => Promise<void>
  bootId?: string
  now?: () => number
}

function isQualified(
  qualification: ContainmentQualification,
): qualification is QualifiedContainmentProvider {
  return 'capabilities' in qualification
}

function absentCapabilities(): Record<string, ContainmentCapabilityStrength> {
  return {
    platformHomeIsolation: 'absent',
    immutableArtifactView: 'absent',
    modelChildNetworkDeny: 'absent',
    // RFC-253 — the OUTER process's own network fence, distinct from the
    // model-child one: that bundle fences a child the model controls, this one
    // fences the contained process itself.
    outerNetworkDeny: 'absent',
    descendantLifetimeBound: 'absent',
  }
}

export function containmentRequirementDigest(profileId: ContainmentRequirementProfileId): string {
  const profile = CONTAINMENT_REQUIREMENT_PROFILES[profileId]
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: profile.id,
        revision: profile.revision,
        required: profile.required,
        optional: profile.optional,
        childBoundary: profile.childBoundary,
      }),
    )
    .digest('hex')
}

function freezeReceipt(receipt: ContainmentAdmissionReceipt): ContainmentAdmissionReceipt {
  Object.freeze(receipt.requiredCapabilities)
  Object.freeze(receipt.reasonCodes)
  Object.freeze(receipt.capabilities)
  return Object.freeze(receipt)
}

function freezeProvider(provider: SandboxProvider): SandboxProvider {
  Object.freeze(provider.status)
  if (provider.runtimeContainment !== undefined) {
    Object.freeze(provider.runtimeContainment.capabilities)
    Object.freeze(provider.runtimeContainment)
  }
  return Object.freeze(provider)
}

function cloneFrozenJson(value: ContainmentJsonValue): ContainmentJsonValue {
  const clone = structuredClone(value)
  const freeze = (entry: ContainmentJsonValue): ContainmentJsonValue => {
    if (entry !== null && typeof entry === 'object') {
      for (const child of Array.isArray(entry) ? entry : Object.values(entry)) freeze(child)
      Object.freeze(entry)
    }
    return entry
  }
  return freeze(clone)
}

function freezeChildProvider(provider: PreparedChildContainmentPlan): PreparedChildContainmentPlan {
  const parsed = PreparedChildContainmentPlanSchema.parse(provider)
  return Object.freeze({
    providerId: parsed.providerId,
    config: cloneFrozenJson(parsed.config),
  })
}

function sameCapabilities(
  left: Readonly<Record<string, ContainmentCapabilityStrength>>,
  right: Readonly<Record<string, ContainmentCapabilityStrength>>,
): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  return keys.every((key) => left[key] === right[key])
}

function bwrapSandbox(
  base: SandboxProvider,
  mode: SandboxMode,
  bwrapPath: string,
  capabilities: Readonly<Record<string, ContainmentCapabilityStrength>> = {
    platformHomeIsolation: 'strong',
    immutableArtifactView: 'strong',
    modelChildNetworkDeny: 'strong',
    // bwrap renders `--unshare-net` + the /run masks (policy.ts); a provider
    // that qualified at all has the user-namespace machinery both rely on.
    outerNetworkDeny: 'strong',
    descendantLifetimeBound: 'strong',
  },
): SandboxProvider {
  return freezeProvider({
    mode,
    appHome: base.appHome,
    status: { mechanism: 'bwrap', available: true, detail: null },
    runtimeContainment: {
      providerId: 'linux-bwrap',
      capabilities,
      childProviderPlan: { bwrapPath },
    },
    // Outer and model-child layers consume the same canonical executable.
    wrapCommand: (cmd: readonly string[], policy: SandboxPolicy): string[] => [
      bwrapPath,
      ...renderBwrapArgs(policy, { appHome: base.appHome }),
      '--',
      ...cmd,
    ],
  })
}

function seatbeltSandbox(base: SandboxProvider, mode: SandboxMode): SandboxProvider {
  return freezeProvider({
    mode,
    appHome: base.appHome,
    status: { mechanism: 'seatbelt', available: true, detail: null },
    runtimeContainment: {
      providerId: 'macos-seatbelt',
      capabilities: {
        platformHomeIsolation: 'strong',
        immutableArtifactView: 'strong',
        modelChildNetworkDeny: 'strong',
        // SBPL `(deny network*)` is part of the profile language itself — if
        // sandbox-exec runs at all, the fence renders.
        outerNetworkDeny: 'strong',
        descendantLifetimeBound: 'best-effort',
      },
      childProviderPlan: { sandboxExecPath: '/usr/bin/sandbox-exec' },
    },
  })
}

function noneSandbox(
  base: SandboxProvider,
  mode: SandboxMode,
  reasonCodes: readonly ContainmentReasonCode[],
): SandboxProvider {
  return freezeProvider({
    mode,
    appHome: base.appHome,
    status: {
      mechanism: base.status.mechanism,
      available: false,
      detail: reasonCodes[0] ?? null,
    },
  })
}

/**
 * Daemon-scoped policy/qualification coordinator.
 *
 * Mode is mutable and generation-stamped; every returned plan is immutable.
 * Qualification is single-flight only while concurrent callers overlap, then
 * discarded so the next spawn re-proves the exact provider boundary.
 */
export class ContainmentCoordinator {
  readonly #provider: SandboxProvider
  readonly #qualifyProviderOverride: (() => Promise<QualifiedContainmentProvider>) | undefined
  readonly #qualifyBwrap: (() => Promise<string>) | undefined
  readonly #qualifyBwrapFilesystem: (() => Promise<string>) | undefined
  readonly #qualifyBwrapFull: ((canonicalPath: string) => Promise<void>) | undefined
  readonly #qualifySeatbelt: (() => Promise<void>) | undefined
  readonly #bootId: string
  readonly #now: () => number
  #mode: SandboxMode
  #policyGeneration = 1
  #probeGeneration = 0
  #admissionGeneration = 0
  #qualificationInFlight: Promise<{
    generation: number
    result: ContainmentQualification
  }> | null = null
  #lastQualification: {
    generation: number
    result: ContainmentQualification
    checkedAt: number
  } | null = null

  constructor(options: ContainmentCoordinatorOptions) {
    this.#provider = freezeProvider({ ...options.provider, status: { ...options.provider.status } })
    this.#mode = options.provider.mode
    this.#qualifyProviderOverride = options.qualifyProvider
    this.#qualifyBwrap = options.qualifyBwrap
    this.#qualifyBwrapFilesystem = options.qualifyBwrapFilesystem
    this.#qualifyBwrapFull = options.qualifyBwrapFull
    this.#qualifySeatbelt = options.qualifySeatbelt
    this.#bootId = options.bootId ?? randomUUID()
    this.#now = options.now ?? Date.now
  }

  get mode(): SandboxMode {
    return this.#mode
  }

  get policyGeneration(): number {
    return this.#policyGeneration
  }

  setMode(mode: SandboxMode): number {
    if (mode !== this.#mode) {
      this.#mode = mode
      this.#policyGeneration += 1
    }
    return this.#policyGeneration
  }

  async #qualifyProvider(): Promise<{
    generation: number
    result: ContainmentQualification
  }> {
    if (this.#qualificationInFlight !== null) return this.#qualificationInFlight
    const generation = ++this.#probeGeneration
    const pending = (async (): Promise<{
      generation: number
      result: ContainmentQualification
    }> => {
      if (this.#qualifyProviderOverride !== undefined) {
        try {
          const qualified = await this.#qualifyProviderOverride()
          const parsedChild = PreparedChildContainmentPlanSchema.safeParse(qualified.childProvider)
          const strengths = Object.values(qualified.capabilities)
          const runtimeContainment = qualified.sandbox.runtimeContainment
          const runtimeChildPlan = ContainmentJsonValueSchema.safeParse(
            runtimeContainment?.childProviderPlan,
          )
          const valid =
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(qualified.providerId) &&
            qualified.sandbox.appHome === this.#provider.appHome &&
            qualified.sandbox.status.available &&
            runtimeContainment?.providerId === qualified.providerId &&
            runtimeContainment !== undefined &&
            sameCapabilities(runtimeContainment.capabilities, qualified.capabilities) &&
            strengths.every(
              (strength) =>
                strength === 'strong' || strength === 'best-effort' || strength === 'absent',
            ) &&
            typeof qualified.sandbox.wrapCommand === 'function' &&
            parsedChild.success &&
            (qualified.childProvider.providerId === qualified.providerId ||
              qualified.childProvider.providerId === 'none') &&
            (qualified.capabilities.modelChildNetworkDeny !== 'strong' ||
              qualified.childProvider.providerId === qualified.providerId) &&
            (qualified.childProvider.providerId === 'none' ||
              (runtimeChildPlan.success &&
                canonicalJson(runtimeChildPlan.data) ===
                  canonicalJson(qualified.childProvider.config)))
          if (!valid) {
            return {
              generation,
              result: {
                providerId: qualified.providerId || null,
                reasonCodes: ['provider-contract-invalid'],
              },
            }
          }
          const childProvider = freezeChildProvider(qualified.childProvider)
          return {
            generation,
            result: {
              ...qualified,
              childProvider,
              sandbox: freezeProvider({
                ...qualified.sandbox,
                status: { ...qualified.sandbox.status },
                runtimeContainment: {
                  providerId: qualified.providerId,
                  capabilities: { ...qualified.capabilities },
                  ...(childProvider.providerId === 'none'
                    ? {}
                    : { childProviderPlan: cloneFrozenJson(childProvider.config) }),
                },
              }),
            },
          }
        } catch (error) {
          const reason =
            error instanceof ContainmentProviderQualificationError
              ? error.containmentReason
              : 'provider-internal-error'
          return {
            generation,
            result: {
              providerId: this.#provider.status.mechanism,
              reasonCodes: [reason],
            },
          }
        }
      }
      const mechanism = this.#provider.status.mechanism
      if (mechanism === 'bwrap') {
        if (this.#qualifyBwrap === undefined && this.#qualifyBwrapFilesystem === undefined) {
          return {
            generation,
            result: { providerId: 'linux-bwrap', reasonCodes: ['provider-contract-invalid'] },
          }
        }
        try {
          const bwrapPath =
            this.#qualifyBwrapFilesystem === undefined
              ? await this.#qualifyBwrap!()
              : await this.#qualifyBwrapFilesystem()
          if (!bwrapPath.startsWith('/')) {
            return {
              generation,
              result: {
                providerId: 'linux-bwrap',
                reasonCodes: ['provider-path-not-canonical'],
              },
            }
          }
          let fullTopology = this.#qualifyBwrapFilesystem === undefined
          let fullFailure: ContainmentReasonCode | null = null
          if (this.#qualifyBwrapFilesystem !== undefined) {
            if (this.#qualifyBwrapFull === undefined) {
              fullFailure = 'provider-contract-invalid'
            } else {
              try {
                await this.#qualifyBwrapFull(bwrapPath)
                fullTopology = true
              } catch (error) {
                fullFailure =
                  error instanceof ContainmentProviderQualificationError
                    ? error.containmentReason
                    : 'provider-trial-rejected'
              }
            }
          }
          const capabilities: Readonly<Record<string, ContainmentCapabilityStrength>> = {
            platformHomeIsolation: 'strong',
            immutableArtifactView: 'strong',
            modelChildNetworkDeny: fullTopology ? 'strong' : 'absent',
            // Tied to the SAME full-topology trial as the child fence: both are
            // namespace operations, so a host where the full trial failed
            // cannot be claimed to deliver either.
            outerNetworkDeny: fullTopology ? 'strong' : 'absent',
            descendantLifetimeBound: 'strong',
          }
          const sandbox = bwrapSandbox(this.#provider, this.#mode, bwrapPath, capabilities)
          return {
            generation,
            result: {
              providerId: 'linux-bwrap',
              capabilities: sandbox.runtimeContainment!.capabilities,
              childProvider: fullTopology
                ? {
                    providerId: 'linux-bwrap',
                    config: { bwrapPath },
                  }
                : { providerId: 'none', config: {} },
              sandbox,
              ...(fullFailure === null ? {} : { reasonCodes: [fullFailure] }),
            },
          }
        } catch (error) {
          const reason =
            error instanceof ContainmentProviderQualificationError
              ? error.containmentReason
              : 'provider-trial-rejected'
          return {
            generation,
            result: { providerId: 'linux-bwrap', reasonCodes: [reason] },
          }
        }
      }
      if (mechanism === 'seatbelt') {
        try {
          if (this.#qualifySeatbelt !== undefined) {
            await this.#qualifySeatbelt()
          } else if (!this.#provider.status.available) {
            throw new ContainmentProviderQualificationError('provider-trial-rejected')
          }
          const sandbox = seatbeltSandbox(this.#provider, this.#mode)
          return {
            generation,
            result: {
              providerId: 'macos-seatbelt',
              capabilities: sandbox.runtimeContainment!.capabilities,
              childProvider: {
                providerId: 'macos-seatbelt',
                config: { sandboxExecPath: '/usr/bin/sandbox-exec' },
              },
              sandbox,
            },
          }
        } catch (error) {
          const reason =
            error instanceof ContainmentProviderQualificationError
              ? error.containmentReason
              : 'provider-trial-rejected'
          return {
            generation,
            result: { providerId: 'macos-seatbelt', reasonCodes: [reason] },
          }
        }
      }
      return {
        generation,
        result: {
          providerId: mechanism,
          reasonCodes: [mechanism === null ? 'platform-unsupported' : 'provider-contract-invalid'],
        },
      }
    })()
    this.#qualificationInFlight = pending
    try {
      const completed = await pending
      this.#lastQualification = {
        ...completed,
        checkedAt: this.#now(),
      }
      return completed
    } finally {
      if (this.#qualificationInFlight === pending) this.#qualificationInFlight = null
    }
  }

  async #waitForQualification(signal?: AbortSignal): Promise<{
    generation: number
    result: ContainmentQualification
  }> {
    if (signal?.aborted) throw new ContainmentAdmissionAborted()
    const shared = this.#qualifyProvider()
    if (signal === undefined) return shared
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(new ContainmentAdmissionAborted())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void shared.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolvePromise(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          rejectPromise(error)
        },
      )
    })
  }

  async #evaluate(
    profileId: ContainmentRequirementProfileId,
    incrementAdmission: boolean,
    observedQualification?: {
      generation: number
      result: ContainmentQualification
    },
    signal?: AbortSignal,
  ): Promise<PreparedContainmentPlan> {
    if (signal?.aborted) throw new ContainmentAdmissionAborted()
    const profile = CONTAINMENT_REQUIREMENT_PROFILES[profileId]
    const modeBeforeProbe = this.#mode
    const policyGenerationBeforeProbe = this.#policyGeneration
    const admissionGeneration = incrementAdmission ? ++this.#admissionGeneration : 0
    // RFC-253 — a fail-closed profile never takes the `off` shortcut: `off`
    // would hand back a plan with no fence at all, which for this bundle is
    // exactly the silent escalation the flag exists to prevent. It falls
    // through to full qualification and is judged on capability alone.
    const failClosed = 'failClosed' in profile && profile.failClosed === true
    if (modeBeforeProbe === 'off' && !failClosed) {
      const capabilities = Object.freeze(absentCapabilities())
      const receipt = freezeReceipt({
        coordinatorBootId: this.#bootId,
        admissionGeneration,
        policyGeneration: policyGenerationBeforeProbe,
        probeGeneration: null,
        probeCheckedAt: null,
        providerId: null,
        profileId,
        requirementDigest: containmentRequirementDigest(profileId),
        mode: 'off',
        decision: 'off',
        requiredCapabilities: [...profile.required],
        capabilities,
        reasonCodes: [],
        admittedAt: this.#now(),
      })
      return Object.freeze({
        receipt,
        topology: 'none',
        spawnTopology: 'runner-outer',
        sandbox: noneSandbox(this.#provider, 'off', []),
        childProvider: freezeChildProvider({ providerId: 'none', config: {} }),
        runtimeReceipt: Object.freeze({
          providerId: null,
          mode: 'off',
          capabilities: { ...capabilities },
          available: false,
          degradedReasons: [],
        }),
      })
    }

    const qualification = observedQualification ?? (await this.#waitForQualification(signal))
    const probeCheckedAt =
      this.#lastQualification?.generation === qualification.generation
        ? this.#lastQualification.checkedAt
        : this.#now()
    // Linearization point: a mode update that completed during qualification
    // governs this admission. The provider evidence itself is mode-independent.
    const mode = this.#mode
    const policyGeneration = this.#policyGeneration
    if (mode === 'off' && !failClosed) {
      const capabilities = Object.freeze(absentCapabilities())
      const receipt = freezeReceipt({
        coordinatorBootId: this.#bootId,
        admissionGeneration,
        policyGeneration,
        probeGeneration: qualification.generation,
        probeCheckedAt,
        providerId: null,
        profileId,
        requirementDigest: containmentRequirementDigest(profileId),
        mode,
        decision: 'off',
        requiredCapabilities: [...profile.required],
        capabilities,
        reasonCodes: [],
        admittedAt: this.#now(),
      })
      return Object.freeze({
        receipt,
        topology: 'none',
        spawnTopology: 'runner-outer',
        sandbox: noneSandbox(this.#provider, mode, []),
        childProvider: freezeChildProvider({ providerId: 'none', config: {} }),
        runtimeReceipt: Object.freeze({
          providerId: null,
          mode,
          capabilities: { ...capabilities },
          available: false,
          degradedReasons: [],
        }),
      })
    }

    const capabilities = Object.freeze(
      isQualified(qualification.result)
        ? { ...qualification.result.capabilities }
        : absentCapabilities(),
    )
    const missing = profile.required.filter((capability) => capabilities[capability] !== 'strong')
    const qualificationReasons = isQualified(qualification.result)
      ? missing.length === 0
        ? []
        : [...(qualification.result.reasonCodes ?? [])]
      : [...qualification.result.reasonCodes]
    // RFC-253 — `off` cannot DELIVER a fail-closed bundle even on a host whose
    // provider qualifies for it: the mode travels into the returned
    // SandboxProvider, `sandboxActive()` is false for `off`, and `wrapSandbox`
    // then returns the argv untouched. Admitting `contained` here would hand
    // back a receipt saying "fenced" for a process that runs with no fence at
    // all — the same escalation the flag exists to prevent, reached from the
    // other direction. Capability presence is irrelevant when nothing applies it.
    const fenceUndeliverable = failClosed && mode === 'off'
    const reasonCodes = Object.freeze([
      ...new Set<ContainmentReasonCode>([
        ...qualificationReasons,
        ...(missing.length > 0 ? (['required-capability-missing'] as const) : []),
        ...(fenceUndeliverable ? (['containment-mode-off'] as const) : []),
      ]),
    ])
    const qualified =
      isQualified(qualification.result) && missing.length === 0 && !fenceUndeliverable
    const decision: ContainmentDecision = qualified
      ? 'contained'
      : // RFC-253 — fail-closed bundles block in EVERY mode, including `warn`
        // and `off`. See the profile comment: degrading a declared network
        // fence is a privilege escalation, not a reduced safety margin.
        failClosed || mode === 'enforce'
        ? 'blocked'
        : 'degraded'
    const providerId = qualification.result.providerId
    const receipt = freezeReceipt({
      coordinatorBootId: this.#bootId,
      admissionGeneration,
      policyGeneration,
      probeGeneration: qualification.generation,
      probeCheckedAt,
      providerId,
      profileId,
      requirementDigest: containmentRequirementDigest(profileId),
      mode,
      decision,
      requiredCapabilities: [...profile.required],
      capabilities,
      reasonCodes,
      admittedAt: this.#now(),
    })

    const active =
      isQualified(qualification.result) && missing.length === 0 ? qualification.result : null
    const sandbox =
      active === null
        ? noneSandbox(this.#provider, mode, reasonCodes)
        : freezeProvider({
            ...active.sandbox,
            mode,
            status: { ...active.sandbox.status },
          })
    const childProvider =
      active === null || profile.childBoundary === 'none'
        ? freezeChildProvider({ providerId: 'none', config: {} })
        : freezeChildProvider(active.childProvider)
    const topology: ContainmentTopology =
      active === null
        ? 'none'
        : profile.childBoundary === 'model-controlled'
          ? active.providerId === 'macos-seatbelt'
            ? 'provider-child-only'
            : 'runner-outer-and-child'
          : 'runner-outer'
    const runtimeReceipt: ContainmentRuntimeProjection = Object.freeze({
      providerId,
      mode,
      capabilities: { ...capabilities },
      available: qualified,
      degradedReasons: [...reasonCodes],
    })
    return Object.freeze({
      receipt,
      topology,
      spawnTopology: topology === 'provider-child-only' ? 'provider-child-only' : 'runner-outer',
      sandbox,
      childProvider,
      runtimeReceipt,
    })
  }

  async admit(
    profileId: ContainmentRequirementProfileId,
    options: { signal?: AbortSignal } = {},
  ): Promise<PreparedContainmentPlan> {
    const plan = await this.#evaluate(profileId, true, undefined, options.signal)
    if (plan.receipt.decision === 'blocked') {
      throw new ContainmentAdmissionError(plan.receipt)
    }
    return plan
  }

  /** Read-only exact profile projection. It never throws and never mints an admission id. */
  preview(profileId: ContainmentRequirementProfileId): Promise<PreparedContainmentPlan> {
    return this.#evaluate(profileId, false)
  }

  /**
   * Read-only observability projection. Unlike admission, status polling may
   * reuse a recent exact qualification for a short, explicit max age.
   */
  observe(
    profileId: ContainmentRequirementProfileId,
    maxAgeMs = 30_000,
  ): Promise<PreparedContainmentPlan> {
    const last = this.#lastQualification
    if (
      this.#mode !== 'off' &&
      last !== null &&
      maxAgeMs >= 0 &&
      this.#now() - last.checkedAt <= maxAgeMs
    ) {
      return this.#evaluate(profileId, false, last)
    }
    return this.#evaluate(profileId, false)
  }
}
