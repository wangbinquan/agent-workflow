import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionOwners } from '@/db/schema'
import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  TaskHostClaimFailures,
  TaskHostFailedClaim,
} from '../application/ports/taskHostClaimFailure'
import type { TaskOwnershipPersistence } from '../application/ports/taskOwnershipPersistence'
import {
  associateTaskHostWork,
  taskHostAdmissionResult,
  taskHostWorkCapture,
  type TaskHostAdmittedWork,
} from '../application/taskHostAdmission'
import { TaskExecutionError } from '../application/taskExecutionError'
import { canonicalJson } from '../domain/executionIntent'
import type { OwnershipToken, WorkerIdentity } from '../domain/ownership'
import { withTaskHostIssuedAck, type TaskHostWriteBinding } from './hostExecutionWriteTransaction'

type OwnerRow = typeof taskExecutionOwners.$inferSelect
type IntentRow = typeof taskExecutionIntents.$inferSelect
interface ClaimTuple {
  readonly taskId: string
  readonly epoch: number
  readonly revision: number
  readonly leaseUntil: number
}
interface BodyWitness {
  phase: 'entered' | 'rejected' | 'fulfilled'
  taskId?: string
  beforeOwner?: OwnerRow | null
  tuple?: ClaimTuple
}
interface Observation {
  readonly ownership: TaskOwnershipPersistence
  readonly identity: WorkerIdentity
  readonly intentId: string
  readonly work: TaskHostAdmittedWork
  readonly bodies: BodyWitness[]
  claimInput?: { readonly now: number; readonly leaseMs: number }
  claimInputChanged?: boolean
  current?: BodyWitness
}

export interface TaskHostClaimObservation {
  scope(taskId: string | undefined): void
  beforeOwner(owner: OwnerRow | null): void
}

interface ClaimFacts {
  readonly intent: IntentRow | null
  readonly owner: OwnerRow | null
}
interface ClaimFactInput {
  readonly intentId: string
  readonly requireWriterCompletion: boolean
  readonly taskId?: string
}

/** Infrastructure-only named facts; capture retains this method and receiver. */
export interface TaskHostClaimFailureFactQueries {
  read(tx: DatabaseTransaction, input: ClaimFactInput): Promise<ClaimFacts>
}
const failurePorts = new WeakMap<TaskOwnershipPersistence, TaskHostClaimFailures>()
const factPorts = new WeakMap<TaskOwnershipPersistence, TaskHostClaimFailureFactQueries>()
const observations = new WeakMap<TaskHostAdmittedWork, Observation>()
const observerState = new WeakMap<TaskHostClaimObservation, Observation>()

export function taskHostClaimFailures(
  ownership: TaskOwnershipPersistence,
): TaskHostClaimFailures | undefined {
  return failurePorts.get(ownership)
}

export function taskHostClaimFailureFactQueries(
  ownership: TaskOwnershipPersistence,
): TaskHostClaimFailureFactQueries | undefined {
  return factPorts.get(ownership)
}

function incomplete(message: string): TaskExecutionError {
  return new TaskExecutionError('task-execution-stale-owner', message)
}

function completedTuple(observation: Observation, facts: ClaimFacts): ClaimTuple | undefined {
  const { owner, intent } = facts
  if (
    owner === null ||
    intent === null ||
    owner.state !== 'claimed' ||
    owner.ownerId !== observation.identity.ownerId ||
    owner.daemonGeneration !== observation.identity.daemonGeneration ||
    intent.id !== observation.intentId ||
    intent.state !== 'claimed' ||
    intent.taskId !== owner.taskId ||
    intent.claimedEpoch !== owner.epoch ||
    observation.claimInput === undefined ||
    observation.claimInputChanged === true
  )
    return undefined
  return observation.bodies.find(
    ({ tuple }) =>
      tuple !== undefined &&
      tuple.taskId === owner.taskId &&
      tuple.epoch === owner.epoch &&
      tuple.revision === owner.revision &&
      tuple.leaseUntil === owner.leaseUntil &&
      tuple.leaseUntil === observation.claimInput!.now + observation.claimInput!.leaseMs &&
      intent.claimedAt === observation.claimInput!.now &&
      owner.lastHeartbeatAt === observation.claimInput!.now &&
      intent.updatedAt === observation.claimInput!.now &&
      owner.updatedAt === observation.claimInput!.now &&
      owner.recoveryCode === null &&
      owner.recoveryProofDigest === null,
  )?.tuple
}

function unclaimed(observation: Observation, facts: ClaimFacts): boolean {
  if (observation.bodies.some(({ phase }) => phase === 'entered')) return false
  const { owner, intent } = facts
  // The actual provider transaction only sends COMMIT after its body returns.
  // A failed call whose bodies all rejected (or never entered) cannot later send it.
  if (!observation.bodies.some(({ phase }) => phase === 'fulfilled')) {
    return !(
      owner?.ownerId === observation.identity.ownerId &&
      owner.daemonGeneration === observation.identity.daemonGeneration
    )
  }
  if (intent === null || intent.id !== observation.intentId || intent.state !== 'pending')
    return false
  return observation.bodies.some(
    ({ phase, taskId, beforeOwner }) =>
      phase === 'fulfilled' &&
      taskId === intent.taskId &&
      beforeOwner !== undefined &&
      canonicalJson(beforeOwner) === canonicalJson(owner),
  )
}

/** Constructed by the same selected ownership adapter; no platform state escapes. */
export function registerTaskHostClaimFailures(
  ownership: TaskOwnershipPersistence,
  db: ProviderNeutralDatabase,
  writes: TaskHostWriteBinding,
  createOriginalClaimToken: (input: {
    readonly taskId: string
    readonly identity: WorkerIdentity
    readonly epoch: number
    readonly ownerRevision: number
    readonly leaseUntil: number
  }) => OwnershipToken,
): void {
  const facts: TaskHostClaimFailureFactQueries = {
    async read(tx, input) {
      if (input.requireWriterCompletion) {
        // The original fulfilled body already updated this exact intent row.
        // Wait for that writer, then read fresh READ COMMITTED facts in this tx.
        await engineOf(tx).lockAggregateRoot(
          tx,
          taskExecutionIntents,
          taskExecutionIntents.id,
          input.intentId,
        )
      }
      const intent =
        (
          await tx
            .select()
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.id, input.intentId))
            .limit(1)
        )[0] ?? null
      const taskId = intent?.taskId ?? input.taskId
      const owner =
        taskId === undefined
          ? null
          : ((
              await tx
                .select()
                .from(taskExecutionOwners)
                .where(eq(taskExecutionOwners.taskId, taskId))
                .limit(1)
            )[0] ?? null)
      return { intent, owner }
    },
  }
  factPorts.set(ownership, facts)
  failurePorts.set(ownership, {
    capture(input): TaskHostFailedClaim {
      if (observations.has(input.work)) throw new Error('task-host-claim-capture-already-bound')
      taskHostWorkCapture(input.work)
      const observation: Observation = {
        ownership,
        identity: input.identity,
        intentId: input.intentId,
        work: input.work,
        bodies: [],
      }
      observations.set(input.work, observation)
      const read = facts.read,
        mark = ownership.markRecoveryRequired
      const identity = input.identity,
        intentId = input.intentId,
        work = input.work
      const capture = taskHostWorkCapture(work)
      const transactionFor = writes.transactionFor
      const binding: TaskHostWriteBinding = Object.freeze({
        port: writes.port,
        transactionFor: (tx: DatabaseTransaction) => transactionFor.call(writes, tx),
      })
      let scope: string | undefined
      let marked: Parameters<TaskOwnershipPersistence['markRecoveryRequired']>[0] | undefined
      let acknowledged = false
      const scoped = () =>
        scope ?? observation.bodies.find((body) => body.taskId !== undefined)?.taskId
      return Object.freeze({
        work,
        intentId,
        taskId: scoped,
        async acknowledge() {
          if (acknowledged) return
          if (observation.bodies.some(({ phase }) => phase === 'entered'))
            throw incomplete('original claim body has not settled')
          const bodyScopes = new Set(
            observation.bodies.flatMap(({ taskId }) => (taskId === undefined ? [] : [taskId])),
          )
          if (bodyScopes.size > 1 || observation.claimInputChanged === true)
            throw incomplete('original failed claim scope changed across transaction attempts')
          const fact = await withTaskHostIssuedAck({
            db,
            selection: { kind: 'selected', capture, binding },
            body: (tx) =>
              read.call(facts, tx, {
                intentId,
                requireWriterCompletion: observation.bodies.some(
                  ({ phase }) => phase === 'fulfilled',
                ),
                ...(scoped() === undefined ? {} : { taskId: scoped() }),
              }),
          })
          const originalScope = scoped()
          if (
            fact.intent !== null &&
            originalScope !== undefined &&
            fact.intent.taskId !== originalScope
          )
            throw incomplete('original failed claim scope changed')
          scope ??= fact.intent?.taskId
          if (marked !== undefined) {
            const owner = fact.owner
            if (
              owner !== null &&
              owner.taskId === marked.token.taskId &&
              owner.ownerId === identity.ownerId &&
              owner.daemonGeneration === identity.daemonGeneration &&
              owner.epoch === marked.token.epoch &&
              owner.state === 'recovery-required' &&
              owner.revision === marked.expectedRevision + 1 &&
              owner.recoveryCode === marked.code &&
              owner.recoveryProofDigest === null &&
              owner.updatedAt === marked.now &&
              owner.leaseUntil === marked.token.leaseUntil &&
              owner.lastHeartbeatAt === observation.claimInput?.now &&
              fact.intent?.id === intentId &&
              fact.intent.state === 'claimed' &&
              fact.intent.taskId === marked.token.taskId &&
              fact.intent.claimedAt === observation.claimInput?.now &&
              fact.intent.updatedAt === observation.claimInput?.now &&
              fact.intent.claimedEpoch === marked.token.epoch
            ) {
              acknowledged = true
              return
            }
          }
          const tuple = completedTuple(observation, fact)
          if (tuple !== undefined) {
            if (marked === undefined) {
              const token = createOriginalClaimToken({
                taskId: tuple.taskId,
                identity,
                epoch: tuple.epoch,
                ownerRevision: tuple.revision,
                leaseUntil: tuple.leaseUntil,
              })
              associateTaskHostWork(token, work)
              marked = {
                token,
                expectedRevision: tuple.revision,
                code: 'task-host-claim-result-unknown',
                evidenceDigest: null,
                now: Date.now(),
              }
            }
            await mark.call(ownership, marked)
            acknowledged = true
            return
          }
          if (marked === undefined && unclaimed(observation, fact)) {
            acknowledged = true
            return
          }
          throw incomplete('original failed claim outcome is not acknowledged')
        },
      })
    },
  })
}

export function taskHostClaimObservation(
  ownership: TaskOwnershipPersistence,
  input: Parameters<TaskOwnershipPersistence['claimPendingIntent']>[0],
): TaskHostClaimObservation | undefined {
  if (input.hostAdmission === undefined) return undefined
  const original = taskHostAdmissionResult(input.hostAdmission)
  if (original.kind !== 'admitted') return undefined
  const observation = observations.get(original.work)
  if (
    observation === undefined ||
    observation.ownership !== ownership ||
    observation.intentId !== input.intentId ||
    observation.identity !== input.identity
  )
    throw new Error('task-host-claim-capture-required')
  if (observation.claimInput === undefined) {
    observation.claimInput = Object.freeze({ now: input.now, leaseMs: input.leaseMs })
  } else if (
    observation.claimInput.now !== input.now ||
    observation.claimInput.leaseMs !== input.leaseMs
  ) {
    observation.claimInputChanged = true
  }
  const observer: TaskHostClaimObservation = {
    scope: (taskId) => {
      if (observation.current !== undefined && taskId !== undefined)
        observation.current.taskId = taskId
    },
    beforeOwner: (owner) => {
      if (observation.current !== undefined)
        observation.current.beforeOwner = owner === null ? null : { ...owner }
    },
  }
  observerState.set(observer, observation)
  return observer
}

/** Metadata only: the exact original SQL body and result remain the callback. */
export function observeTaskHostClaimBody<T extends ClaimTuple>(
  observer: TaskHostClaimObservation | undefined,
  body: (tx: DatabaseTransaction) => Promise<T>,
): (tx: DatabaseTransaction) => Promise<T> {
  if (observer === undefined) return body
  const observation = observerState.get(observer)
  if (observation === undefined) throw new Error('task-host-claim-capture-required')
  return async (tx) => {
    const witness: BodyWitness = { phase: 'entered' }
    observation.current = witness
    observation.bodies.push(witness)
    try {
      const tuple = await body(tx)
      witness.tuple = { ...tuple }
      witness.phase = 'fulfilled'
      return tuple
    } catch (error) {
      witness.phase = 'rejected'
      throw error
    }
  }
}
