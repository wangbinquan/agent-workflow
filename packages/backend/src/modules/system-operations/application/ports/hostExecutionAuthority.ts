export type HostExecutionResult<T> = T | Promise<T>

/** Named execution groups; resource reads and edits do not acquire these. */
export type HostExecutionGroup =
  | 'task'
  | 'intent'
  | 'purpose'
  | 'diagnostics'
  | 'verification'
  | 'observation'
  | 'memory'
  | 'development'
  | 'digital-employee'
  | 'event-dispatch'
  | 'knowledge'
  | 'maintenance'

export type HostExecutionAuthorityReference = object

export type HostExecutionAuthorityObservation =
  | { readonly kind: 'standby'; readonly reason: string }
  | { readonly kind: 'granted'; readonly reference: HostExecutionAuthorityReference }
  | { readonly kind: 'lost'; readonly reason: string }

export type HostExecutionStopReason = 'authority-loss' | 'handoff' | 'shutdown'

export interface HostExecutionAuthorityDriver {
  claim(): HostExecutionResult<HostExecutionAuthorityObservation>
  renew(
    reference: HostExecutionAuthorityReference,
  ): HostExecutionResult<HostExecutionAuthorityObservation>
  activate(input: {
    readonly reference: HostExecutionAuthorityReference
    readonly preparationDigest: string
    readonly acceptedTaskContractVersions: readonly string[]
  }): HostExecutionResult<HostExecutionAuthorityObservation>
  quiesce(input: {
    readonly reference: HostExecutionAuthorityReference
    readonly reason: HostExecutionStopReason
  }): HostExecutionResult<void>
  release(reference: HostExecutionAuthorityReference): HostExecutionResult<void>
  /**
   * Close stops the driver's observations and automatic renewal, and settles
   * its in-flight control work. Late references must remain callable through
   * quiesce/release until their exact retirement ACKs complete.
   */
  subscribe(input: {
    readonly onObservation: (observation: HostExecutionAuthorityObservation) => void
    readonly onFailure: (error: unknown) => void
  }): HostExecutionResult<{ close(): HostExecutionResult<void> }>
}

export interface HostExecutionAuthorityFactory {
  create(input: {
    readonly provider: 'sqlite' | 'postgresql'
    readonly generation: string
  }): HostExecutionResult<HostExecutionAuthorityDriver>
}

export interface HostExecutionGrantContext {
  readonly generation: string
  readonly reference: HostExecutionAuthorityReference
  /** Read dynamically before each new boot write or dispatch. */
  readonly current: () => boolean
}

export type HostExecutionPreparation =
  | {
      readonly kind: 'prepared'
      readonly preparationDigest: string
      readonly acceptedTaskContractVersions: readonly string[]
      readonly readyGroups: readonly HostExecutionGroup[]
    }
  | { readonly kind: 'deferred'; readonly reason: string }

export interface HostExecutionRecoveryFamily {
  readonly kind: 'local-startup' | 'durable-intent'
  prepare(context: HostExecutionGrantContext): HostExecutionResult<HostExecutionPreparation>
  quiesce(input: {
    readonly context: HostExecutionGrantContext
    readonly reason: HostExecutionStopReason
  }): HostExecutionResult<void>
  drain(context: HostExecutionGrantContext): HostExecutionResult<void>
}

export interface HostExecutionRuntimeFamily {
  start(input: {
    readonly context: HostExecutionGrantContext
    readonly groups: readonly HostExecutionGroup[]
  }): HostExecutionResult<void>
  quiesce(input: {
    readonly context: HostExecutionGrantContext
    readonly reason: HostExecutionStopReason
  }): HostExecutionResult<void>
  drain(context: HostExecutionGrantContext): HostExecutionResult<void>
}

export type HostExecutionPhase = 'standby' | 'preparing' | 'active' | 'draining' | 'closed'

export interface HostExecutionAvailabilityQueries {
  snapshot(): {
    readonly phase: HostExecutionPhase
    readonly generation: string
    readonly readyGroups: readonly HostExecutionGroup[]
    readonly reason: string | null
  }
}

export interface HostExecutionAdmissionLease {
  readonly generation: string
  readonly reference: HostExecutionAuthorityReference
  /** A loss/close notification is distinct from a normal business cancel. */
  readonly stopped: Promise<HostExecutionStopReason>
  /** Complete after the admitted owner work and its durable ACK have settled. */
  complete(): void
}

export interface HostExecutionAdmission {
  acquire(
    group: HostExecutionGroup,
  ):
    | { readonly kind: 'admitted'; readonly lease: HostExecutionAdmissionLease }
    | { readonly kind: 'unavailable'; readonly reason: string }
}

export interface HostExecutionAuthorityLifecycle {
  readonly queries: HostExecutionAvailabilityQueries
  readonly admission: HostExecutionAdmission
  start(): Promise<void>
  /** An explicit renewal, when required by the chosen host control flow. */
  renew(): Promise<void>
  /** Wait for already received lifecycle observations; does not create work. */
  settled(): Promise<void>
  close(): Promise<void>
}
