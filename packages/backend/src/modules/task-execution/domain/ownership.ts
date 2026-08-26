// RFC-328 — durable task-execution ownership capabilities.
//
// These values are intentionally module-internal.  Public task-execution
// contracts never expose a constructor, owner id, daemon generation or epoch.
// Runtime membership in the WeakSets below supplements the TypeScript brands:
// a JSON object (or an `as OwnershipToken` cast in a legacy adapter) is not a
// capability and is rejected before it can reach a persistence gateway.

const workerIdentityBrand: unique symbol = Symbol('rfc328.worker-identity')
const ownershipTokenBrand: unique symbol = Symbol('rfc328.ownership-token')
const ownedTaskTxBrand: unique symbol = Symbol('rfc328.owned-task-tx')
const daemonLockProofBrand: unique symbol = Symbol('rfc328.daemon-lock-proof')
const claimAttachPermitBrand: unique symbol = Symbol('rfc328.claim-attach-permit')
const takeoverProofBrand: unique symbol = Symbol('rfc328.takeover-proof')
const stopProofBrand: unique symbol = Symbol('rfc328.stop-proof')
const outcomeClosureBrand: unique symbol = Symbol('rfc328.outcome-closure')
const maintenanceClaimBrand: unique symbol = Symbol('rfc328.maintenance-claim')

export const TASK_OWNER_STATES = ['claimed', 'revoked', 'released', 'recovery-required'] as const
export type TaskOwnerState = (typeof TASK_OWNER_STATES)[number]

export interface WorkerIdentity {
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly [workerIdentityBrand]: true
}

export interface OwnershipToken {
  readonly taskId: string
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly epoch: number
  readonly leaseUntil: number
  readonly ownerRevision: number
  readonly [ownershipTokenBrand]: true
}

export interface OwnedTaskTx {
  readonly taskId: string
  readonly epoch: number
  readonly revision: number
  readonly [ownedTaskTxBrand]: true
}

export interface ExclusiveDaemonLockProof {
  readonly daemonGeneration: string
  readonly acquiredAt: number
  readonly lockReceiptDigest: string
  readonly [daemonLockProofBrand]: true
}

export interface ClaimAttachPermit {
  readonly gateGeneration: string
  readonly permitId: string
  readonly [claimAttachPermitBrand]: true
}

export interface VerifiedTakeoverProof {
  readonly taskId: string
  readonly oldOwnerRevision: number
  readonly oldEpoch: number
  readonly evidenceDigest: string
  readonly verifiedAt: number
  readonly [takeoverProofBrand]: true
}

export interface VerifiedStopProof {
  readonly taskId: string
  readonly ownerRevision: number
  readonly epoch: number
  readonly evidenceDigest: string
  readonly verifiedAt: number
  readonly [stopProofBrand]: true
}

/**
 * A closure proves only that the local execution plane is quiet.  It does not
 * claim that a remote effect did not happen, and deliberately cannot mint a
 * successor token.  Actor-authorized replay remains a separate command.
 */
export interface VerifiedOutcomeUnknownClosure {
  readonly taskId: string
  readonly ownerRevision: number
  readonly epoch: number
  readonly quiescenceDigest: string
  readonly unresolvedEffectIds: readonly string[]
  readonly verifiedAt: number
  readonly [outcomeClosureBrand]: true
}

export type TerminalMaintenanceOperation =
  | 'archive'
  | 'delete'
  | 'retention'
  | 'workspace-gc'
  | 'repair-metadata'

export interface TerminalMaintenanceClaim {
  readonly claimId: string
  readonly operation: TerminalMaintenanceOperation
  readonly revision: number
  readonly memberSetDigest: string
  readonly [maintenanceClaimBrand]: true
}

export type ControlRevisionAuthority =
  | {
      readonly subtype: 'continuation-admission'
      readonly expectedTaskRevision: number
      readonly command:
        | 'launch'
        | 'resume'
        | 'retry-repository-preparation'
        | 'retry-node'
        | 'sync-workflow'
    }
  | {
      readonly subtype: 'terminal-control'
      readonly expectedTaskRevision: number
      readonly control: 'cancel' | 'source-terminal'
    }
  | {
      readonly subtype: 'gate-control'
      readonly expectedTaskRevision: number
      readonly expectedGateRevision: number
    }
  | {
      readonly subtype: 'membership-control'
      readonly expectedTaskRevision: number
      readonly expectedMembershipRevision: number
    }
  | {
      readonly subtype: 'daemon-shutdown'
      readonly expectedTaskRevision: number
      readonly expectedOwnerRevision: number
      readonly exactDaemonGeneration: string
    }
  | {
      readonly subtype: 'recovery-candidate-revoke'
      readonly expectedOwnerRevision: number
      readonly exactOldOwner: OwnershipTuple
      readonly lockProof: ExclusiveDaemonLockProof
    }

export type TaskMutationAuthority =
  | Readonly<{ kind: 'worker-epoch'; ownedTx: OwnedTaskTx }>
  | Readonly<{ kind: 'control-revision'; control: ControlRevisionAuthority }>
  | Readonly<{
      kind: 'recovery-proof'
      proof: VerifiedTakeoverProof | VerifiedStopProof | VerifiedOutcomeUnknownClosure
      expectedOwnerRevision: number
      exactOldEpoch: number
    }>
  | Readonly<{
      kind: 'terminal-maintenance'
      claim: TerminalMaintenanceClaim
      expectedClaimRevision: number
      operation: TerminalMaintenanceOperation
    }>

export interface OwnershipTuple {
  readonly taskId: string
  readonly ownerId: string
  readonly daemonGeneration: string
  readonly epoch: number
}

export interface OwnerSnapshot extends OwnershipTuple {
  readonly state: TaskOwnerState
  readonly leaseUntil: number
  readonly revision: number
}

const workerIdentities = new WeakSet<object>()
const ownershipTokens = new WeakSet<object>()
const ownedTaskTransactions = new WeakSet<object>()
const daemonLockProofs = new WeakSet<object>()
const claimAttachPermits = new WeakSet<object>()
const takeoverProofs = new WeakSet<object>()
const stopProofs = new WeakSet<object>()
const outcomeClosures = new WeakSet<object>()
const maintenanceClaims = new WeakSet<object>()

function frozenCapability<T extends object>(value: T, registry: WeakSet<object>): T {
  const frozen = Object.freeze(value)
  registry.add(frozen)
  return frozen
}

/** Internal factory owned by the composition root. */
export function createWorkerIdentity(input: {
  ownerId: string
  daemonGeneration: string
}): WorkerIdentity {
  if (input.ownerId.length === 0 || input.daemonGeneration.length === 0) {
    throw new Error('worker identity requires non-empty owner and daemon generation')
  }
  return frozenCapability(
    {
      ownerId: input.ownerId,
      daemonGeneration: input.daemonGeneration,
      [workerIdentityBrand]: true as const,
    },
    workerIdentities,
  )
}

export function assertWorkerIdentity(value: WorkerIdentity): void {
  if (!workerIdentities.has(value)) throw new Error('untrusted-worker-identity')
}

/** Internal adapter factory; call only after a successful durable claim. */
export function createOwnershipToken(input: {
  taskId: string
  identity: WorkerIdentity
  epoch: number
  leaseUntil: number
  ownerRevision: number
}): OwnershipToken {
  assertWorkerIdentity(input.identity)
  if (input.taskId.length === 0 || input.epoch < 1 || input.ownerRevision < 1) {
    throw new Error('invalid durable ownership claim')
  }
  return frozenCapability(
    {
      taskId: input.taskId,
      ownerId: input.identity.ownerId,
      daemonGeneration: input.identity.daemonGeneration,
      epoch: input.epoch,
      leaseUntil: input.leaseUntil,
      ownerRevision: input.ownerRevision,
      [ownershipTokenBrand]: true as const,
    },
    ownershipTokens,
  )
}

export function assertOwnershipToken(value: OwnershipToken): void {
  if (!ownershipTokens.has(value)) throw new Error('untrusted-ownership-token')
}

export function refreshOwnershipToken(input: {
  token: OwnershipToken
  leaseUntil: number
  ownerRevision: number
}): OwnershipToken {
  assertOwnershipToken(input.token)
  if (input.ownerRevision < input.token.ownerRevision) {
    throw new Error('ownership token revision cannot regress')
  }
  return frozenCapability(
    {
      taskId: input.token.taskId,
      ownerId: input.token.ownerId,
      daemonGeneration: input.token.daemonGeneration,
      epoch: input.token.epoch,
      leaseUntil: input.leaseUntil,
      ownerRevision: input.ownerRevision,
      [ownershipTokenBrand]: true as const,
    },
    ownershipTokens,
  )
}

export function ownershipTuple(token: OwnershipToken): OwnershipTuple {
  assertOwnershipToken(token)
  return {
    taskId: token.taskId,
    ownerId: token.ownerId,
    daemonGeneration: token.daemonGeneration,
    epoch: token.epoch,
  }
}

/** Internal mutation-gateway factory; valid only for the transaction callback. */
export function createOwnedTaskTx(input: { token: OwnershipToken; revision: number }): OwnedTaskTx {
  assertOwnershipToken(input.token)
  if (input.revision <= input.token.ownerRevision) {
    throw new Error('owned transaction revision must advance the owner row')
  }
  return frozenCapability(
    {
      taskId: input.token.taskId,
      epoch: input.token.epoch,
      revision: input.revision,
      [ownedTaskTxBrand]: true as const,
    },
    ownedTaskTransactions,
  )
}

export function assertOwnedTaskTx(value: OwnedTaskTx): void {
  if (!ownedTaskTransactions.has(value)) throw new Error('untrusted-owned-task-tx')
}

export function createExclusiveDaemonLockProof(input: {
  daemonGeneration: string
  acquiredAt: number
  lockReceiptDigest: string
}): ExclusiveDaemonLockProof {
  if (input.daemonGeneration.length === 0 || input.lockReceiptDigest.length === 0) {
    throw new Error('invalid-daemon-lock-proof')
  }
  return frozenCapability({ ...input, [daemonLockProofBrand]: true as const }, daemonLockProofs)
}

export function assertExclusiveDaemonLockProof(value: ExclusiveDaemonLockProof): void {
  if (!daemonLockProofs.has(value)) throw new Error('untrusted-daemon-lock-proof')
}

export function createClaimAttachPermit(input: {
  gateGeneration: string
  permitId: string
}): ClaimAttachPermit {
  if (input.gateGeneration.length === 0 || input.permitId.length === 0) {
    throw new Error('invalid-claim-attach-permit')
  }
  return frozenCapability({ ...input, [claimAttachPermitBrand]: true as const }, claimAttachPermits)
}

export function assertClaimAttachPermit(value: ClaimAttachPermit): void {
  if (!claimAttachPermits.has(value)) throw new Error('untrusted-claim-attach-permit')
}

export function createVerifiedTakeoverProof(
  input: Omit<VerifiedTakeoverProof, typeof takeoverProofBrand>,
): VerifiedTakeoverProof {
  if (input.oldEpoch < 1 || input.oldOwnerRevision < 1 || input.evidenceDigest.length === 0) {
    throw new Error('invalid-takeover-proof')
  }
  return frozenCapability({ ...input, [takeoverProofBrand]: true as const }, takeoverProofs)
}

export function assertVerifiedTakeoverProof(value: VerifiedTakeoverProof): void {
  if (!takeoverProofs.has(value)) throw new Error('untrusted-takeover-proof')
}

export function createVerifiedStopProof(
  input: Omit<VerifiedStopProof, typeof stopProofBrand>,
): VerifiedStopProof {
  if (input.epoch < 1 || input.ownerRevision < 1 || input.evidenceDigest.length === 0) {
    throw new Error('invalid-stop-proof')
  }
  return frozenCapability({ ...input, [stopProofBrand]: true as const }, stopProofs)
}

export function assertVerifiedStopProof(value: VerifiedStopProof): void {
  if (!stopProofs.has(value)) throw new Error('untrusted-stop-proof')
}

export function createVerifiedOutcomeUnknownClosure(
  input: Omit<VerifiedOutcomeUnknownClosure, typeof outcomeClosureBrand>,
): VerifiedOutcomeUnknownClosure {
  if (
    input.epoch < 1 ||
    input.ownerRevision < 1 ||
    input.quiescenceDigest.length === 0 ||
    input.unresolvedEffectIds.length === 0
  ) {
    throw new Error('invalid-outcome-unknown-closure')
  }
  return frozenCapability(
    {
      ...input,
      unresolvedEffectIds: Object.freeze([...input.unresolvedEffectIds]),
      [outcomeClosureBrand]: true as const,
    },
    outcomeClosures,
  )
}

export function assertVerifiedOutcomeUnknownClosure(value: VerifiedOutcomeUnknownClosure): void {
  if (!outcomeClosures.has(value)) throw new Error('untrusted-outcome-unknown-closure')
}

export function createTerminalMaintenanceClaim(
  input: Omit<TerminalMaintenanceClaim, typeof maintenanceClaimBrand>,
): TerminalMaintenanceClaim {
  if (input.claimId.length === 0 || input.revision < 1 || input.memberSetDigest.length === 0) {
    throw new Error('invalid-terminal-maintenance-claim')
  }
  return frozenCapability({ ...input, [maintenanceClaimBrand]: true as const }, maintenanceClaims)
}

export function assertTerminalMaintenanceClaim(value: TerminalMaintenanceClaim): void {
  if (!maintenanceClaims.has(value)) throw new Error('untrusted-terminal-maintenance-claim')
}

export type OwnerTransition = Readonly<{
  from: TaskOwnerState | 'absent'
  to: TaskOwnerState
  incrementsEpoch: boolean
}>

/** Pure transition oracle used by both SQLite code and property tests. */
export function decideOwnerTransition(input: {
  current: TaskOwnerState | 'absent'
  operation:
    | 'initial-claim'
    | 'revoke'
    | 'mark-recovery-required'
    | 'release-after-stop'
    | 'takeover'
}): OwnerTransition | null {
  const { current, operation } = input
  if (operation === 'initial-claim') {
    if (current === 'absent') return { from: current, to: 'claimed', incrementsEpoch: true }
    if (current === 'released') return { from: current, to: 'claimed', incrementsEpoch: true }
    return null
  }
  if (operation === 'revoke') {
    return current === 'claimed' ? { from: current, to: 'revoked', incrementsEpoch: false } : null
  }
  if (operation === 'mark-recovery-required') {
    return current === 'claimed' || current === 'revoked'
      ? { from: current, to: 'recovery-required', incrementsEpoch: false }
      : null
  }
  if (operation === 'release-after-stop') {
    return current === 'claimed' || current === 'revoked' || current === 'recovery-required'
      ? { from: current, to: 'released', incrementsEpoch: false }
      : null
  }
  return current === 'revoked' || current === 'recovery-required'
    ? { from: current, to: 'claimed', incrementsEpoch: true }
    : null
}

export function exactOwnerMatches(snapshot: OwnerSnapshot, token: OwnershipToken): boolean {
  assertOwnershipToken(token)
  return (
    snapshot.taskId === token.taskId &&
    snapshot.ownerId === token.ownerId &&
    snapshot.daemonGeneration === token.daemonGeneration &&
    snapshot.epoch === token.epoch &&
    snapshot.state === 'claimed'
  )
}

export function ownershipTokenKey(token: OwnershipToken): string {
  assertOwnershipToken(token)
  return `${token.taskId}\u0000${token.ownerId}\u0000${token.daemonGeneration}\u0000${token.epoch}`
}
