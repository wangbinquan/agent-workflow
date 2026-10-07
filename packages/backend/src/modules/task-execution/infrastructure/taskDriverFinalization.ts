import type { TaskDriverFinalizations } from '../application/ports/taskDriverFinalization'
import type { TaskHostFailedClaim } from '../application/ports/taskHostClaimFailure'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import {
  completeTaskHostWork,
  taskHostWorkCompleted,
  taskHostWorkForToken,
} from '../application/taskHostAdmission'
import { TaskExecutionError } from '../application/taskExecutionError'
import { canonicalJson } from '../domain/executionIntent'
import { aggregateEffectOutcome } from '../domain/executionEffect'
import { ownershipTokenKey, type OwnershipToken, type OwnerSnapshot } from '../domain/ownership'
import type { InMemoryTaskRuntimeRegistry, RuntimeStopResult } from './inMemoryTaskRuntimeRegistry'
import {
  taskDriverFinalizationFactQueries,
  type TaskDriverFinalizationFact,
} from './taskOwnershipPersistence'

export interface TaskDriverOwnerTransferPersistence {
  readonly ownership: Pick<
    TaskExecutionPersistence['ownership'],
    'read' | 'releaseAfterStop' | 'markRecoveryRequired'
  >
  readonly effects: Pick<
    TaskExecutionPersistence['effects'],
    'resolveQuiescedManagedProcesses' | 'unresolvedEffectIds' | 'closeOutcomeUnknownAndRelease'
  >
}

export interface TaskDriverFinalizationReleaseDependencies {
  readonly registry: InMemoryTaskRuntimeRegistry
  readonly persistence: Pick<TaskExecutionPersistence, 'ownership' | 'effects'>
  readonly stopHeartbeat: (tokenKey: string) => void
  readonly awaitHeartbeatAcks?: (tokenKey: string) => Promise<void>
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
}

type TransferOwner = (
  persistence: TaskDriverOwnerTransferPersistence,
  input: {
    readonly taskId: string
    readonly token: OwnershipToken
    readonly intentId: string
    readonly stopResult: RuntimeStopResult
  },
) => Promise<void>

type AttachedDriver = Parameters<TaskDriverFinalizations['attached']>[0]
interface Progress {
  run(): Promise<void>
}
interface DriverEntry extends AttachedDriver {
  readonly completed: Promise<void>
  phase: 'active' | 'pending'
  progress?: Progress
  inFlight?: Promise<void>
  error: unknown
}
interface FailedClaimEntry {
  readonly claim: TaskHostFailedClaim
  readonly work: TaskHostFailedClaim['work']
  readonly taskId: () => string | undefined
  readonly acknowledge: () => Promise<void>
  readonly completed: Promise<void>
  inFlight?: Promise<void>
  error: unknown
}
interface FinalizationControl {
  release(
    deps: TaskDriverFinalizationReleaseDependencies,
    input: { taskId: string; controller: AbortController },
    transfer: TransferOwner,
  ): Promise<void>
  retreat(
    input: AttachedDriver & {
      readonly intentId: string
      readonly persistence: TaskExecutionPersistence['ownership']
    },
  ): Promise<void>
}
const controls = new WeakMap<TaskDriverFinalizations, FinalizationControl>()

function pending(message: string): TaskExecutionError {
  return new TaskExecutionError('task-execution-stale-owner', message)
}

function sameDriverOwner(owner: OwnerSnapshot, token: OwnershipToken): boolean {
  return (
    owner.taskId === token.taskId &&
    owner.ownerId === token.ownerId &&
    owner.daemonGeneration === token.daemonGeneration &&
    owner.epoch === token.epoch
  )
}

function ownerSnapshot(fact: TaskDriverFinalizationFact): OwnerSnapshot | undefined {
  const row = fact.owner
  if (row === null) return undefined
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
    state: row.state,
    leaseUntil: row.leaseUntil,
    revision: row.revision,
  }
}

function jsonRecord(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** A reply is recovered only from the exact old tuple, revision, intent and proof. */
function releasedReply(
  fact: TaskDriverFinalizationFact,
  input: Parameters<TaskExecutionPersistence['ownership']['releaseAfterStop']>[0],
): OwnerSnapshot | undefined {
  const owner = ownerSnapshot(fact)
  if (
    owner === undefined ||
    !sameDriverOwner(owner, input.token) ||
    owner.state !== 'released' ||
    owner.revision !== input.proof.ownerRevision + 1 ||
    fact.owner!.recoveryCode !== null ||
    fact.owner!.recoveryProofDigest !== input.proof.evidenceDigest ||
    fact.owner!.updatedAt !== input.now ||
    fact.intent?.claimedEpoch !== input.token.epoch ||
    fact.intent.state !== 'completed' ||
    fact.intent.completedAt !== input.now
  )
    return undefined
  return owner
}

function recoveryReply(
  fact: TaskDriverFinalizationFact,
  input: Parameters<TaskExecutionPersistence['ownership']['markRecoveryRequired']>[0],
): OwnerSnapshot | undefined {
  const owner = ownerSnapshot(fact)
  if (
    owner === undefined ||
    !sameDriverOwner(owner, input.token) ||
    owner.state !== 'recovery-required' ||
    owner.revision !== input.expectedRevision + 1 ||
    fact.owner!.recoveryCode !== input.code ||
    fact.owner!.recoveryProofDigest !== (input.evidenceDigest ?? null) ||
    fact.owner!.updatedAt !== input.now ||
    fact.intent?.claimedEpoch !== input.token.epoch ||
    fact.intent.state !== 'claimed'
  )
    return undefined
  return owner
}

function outcomeUnknownReply(
  fact: TaskDriverFinalizationFact,
  input: Parameters<TaskExecutionPersistence['effects']['closeOutcomeUnknownAndRelease']>[0],
): OwnerSnapshot | undefined {
  const owner = ownerSnapshot(fact)
  if (
    owner === undefined ||
    !sameDriverOwner(owner, input.token) ||
    owner.state !== 'released' ||
    owner.revision !== input.proof.ownerRevision + 1 ||
    fact.owner!.recoveryCode !== 'task-execution-outcome-unknown' ||
    fact.owner!.recoveryProofDigest !== input.proof.quiescenceDigest ||
    fact.owner!.updatedAt !== input.now ||
    fact.intent?.claimedEpoch !== input.token.epoch ||
    fact.intent.state !== 'failed' ||
    fact.intent.failureCode !== 'task-execution-outcome-unknown'
  )
    return undefined
  for (const id of input.proof.unresolvedEffectIds) {
    const rows = fact.effects.filter(({ effect }) => effect.id === id)
    if (
      !rows.some(
        ({ effect, attempt }) =>
          effect.state === 'outcome-unknown' &&
          jsonRecord(effect.receiptJson)?.closureDigest === input.proof.quiescenceDigest &&
          effect.settledAt === input.now &&
          attempt.epoch === input.token.epoch &&
          attempt.state === 'outcome-unknown' &&
          attempt.settledAt === input.now &&
          fact.fences
            .filter(
              (fence) =>
                fence.effectAttemptId === attempt.id && fence.acquiredEpoch === input.token.epoch,
            )
            .every((fence) => fence.releasedAt !== null),
      )
    )
      return undefined
  }
  return owner
}

/** Known replies are retained; a rejected attempt retains its original arguments. */
function retainReply<A, R>(input: {
  readonly invoke: (argument: A) => Promise<R>
  readonly before?: () => Promise<TaskDriverFinalizationFact>
  readonly confirm?: (
    argument: A,
    before: TaskDriverFinalizationFact | undefined,
  ) => Promise<R | undefined>
}): (argument: A) => Promise<R> {
  let original:
    | {
        argument: A
        before?: TaskDriverFinalizationFact
        attempted: boolean
        reply?: { result: R }
      }
    | undefined
  return async (argument) => {
    original ??= { argument, attempted: false }
    if (original.reply !== undefined) return original.reply.result
    if (original.attempted && input.confirm !== undefined) {
      const confirmed = await input.confirm(original.argument, original.before)
      if (confirmed !== undefined) {
        original.reply = { result: confirmed }
        return confirmed
      }
    }
    if (!original.attempted && input.before !== undefined) original.before = await input.before()
    original.attempted = true
    const result = await input.invoke(original.argument)
    original.reply = { result }
    return result
  }
}

function managedProcessReply(
  before: TaskDriverFinalizationFact | undefined,
  after: TaskDriverFinalizationFact,
  input: Parameters<TaskExecutionPersistence['effects']['resolveQuiescedManagedProcesses']>[0],
):
  | Awaited<ReturnType<TaskExecutionPersistence['effects']['resolveQuiescedManagedProcesses']>>
  | undefined {
  if (
    before === undefined ||
    input.now === undefined ||
    input.authority !== 'exact-stop' ||
    before.owner === null ||
    after.owner === null ||
    !sameDriverOwner(after.owner, input.token) ||
    after.owner.revision !== input.expectedRevision ||
    canonicalJson(before.owner) !== canonicalJson(after.owner)
  )
    return undefined
  const oldRows = before.effects.filter(({ effect }) => effect.kind === 'process')
  const newRows = after.effects.filter(({ effect }) => effect.kind === 'process')
  if (oldRows.length !== newRows.length) return undefined
  const resolved = new Set<string>(),
    unresolved = new Set<string>()
  for (const effectId of new Set(oldRows.map(({ effect }) => effect.id))) {
    const oldGroup = oldRows.filter(({ effect }) => effect.id === effectId)
    const newGroup = newRows.filter(({ effect }) => effect.id === effectId)
    if (oldGroup.length !== newGroup.length) return undefined
    const paired = oldGroup.map((old) => ({
      old,
      row: newGroup.find(({ attempt }) => attempt.id === old.attempt.id),
    }))
    if (paired.some(({ row }) => row === undefined)) return undefined
    const active = oldGroup.filter(
      ({ effect, attempt }) =>
        effect.state === 'open' &&
        ['prepared', 'acting', 'recovery-required'].includes(attempt.state),
    )
    if (paired.every(({ old, row }) => canonicalJson(row) === canonicalJson(old))) {
      if (active.length > 0) unresolved.add(effectId)
      continue
    }
    if (active.length !== 1) return undefined
    const old = active[0]!,
      row = newGroup.find(({ attempt }) => attempt.id === old.attempt.id)!
    // Each joined historical attempt shares the one updated effect. Its own
    // durable row must remain exactly unchanged, rather than being "resolved" again.
    if (
      paired.some(
        ({ old: prior, row: next }) =>
          canonicalJson(prior.effect) !== canonicalJson(old.effect) ||
          canonicalJson(next!.effect) !== canonicalJson(row.effect) ||
          (prior.attempt.id !== old.attempt.id &&
            canonicalJson(prior.attempt) !== canonicalJson(next!.attempt)),
      )
    )
      return undefined
    const receipt = jsonRecord(row.effect.receiptJson)
    const candidate = /^(agent|script):(.+)$/.exec(old.attempt.candidateId)
    const applied = row.attempt.applicationEvidence === 'applied'
    const notApplied = row.attempt.applicationEvidence === 'definitely-not-applied'
    const failureCode = applied ? null : 'daemon-restart-before-process-activation'
    if (
      old.effect.state !== 'open' ||
      !['prepared', 'acting', 'recovery-required'].includes(old.attempt.state) ||
      old.attempt.epoch !== input.token.epoch ||
      old.attempt.recoveryClass !== 'managed-process-preactivation' ||
      candidate === null ||
      receipt?.v !== 1 ||
      receipt?.recovery !== 'daemon-restart-process-barrier' ||
      receipt.quiescenceEvidenceDigest !== input.quiescenceEvidenceDigest ||
      receipt.nodeRunId !== candidate[2] ||
      row.effect.settledAt !== input.now ||
      row.attempt.settledAt !== input.now ||
      row.effect.updatedAt !== input.now ||
      row.attempt.updatedAt !== input.now ||
      (!applied && !notApplied) ||
      row.attempt.state !== (applied ? 'succeeded' : 'failed-not-applied') ||
      row.attempt.retryAuthority !== 'none' ||
      row.attempt.failureCode !== failureCode ||
      row.effect.failureCode !== failureCode
    )
      return undefined
    const effectFields = ['state', 'receiptJson', 'failureCode', 'settledAt', 'updatedAt'] as const
    const attemptFields = [
      'state',
      'applicationEvidence',
      'retryAuthority',
      'failureCode',
      'settledAt',
      'updatedAt',
    ] as const
    const stableEffect = { ...row.effect },
      oldEffect = { ...old.effect }
    const stableAttempt = { ...row.attempt },
      oldAttempt = { ...old.attempt }
    for (const key of effectFields) {
      delete (stableEffect as Partial<typeof stableEffect>)[key]
      delete (oldEffect as Partial<typeof oldEffect>)[key]
    }
    for (const key of attemptFields) {
      delete (stableAttempt as Partial<typeof stableAttempt>)[key]
      delete (oldAttempt as Partial<typeof oldAttempt>)[key]
    }
    if (
      canonicalJson(stableEffect) !== canonicalJson(oldEffect) ||
      canonicalJson(stableAttempt) !== canonicalJson(oldAttempt)
    )
      return undefined
    let outcome: ReturnType<typeof aggregateEffectOutcome>
    try {
      outcome = aggregateEffectOutcome(
        newGroup.map(({ attempt }) => ({
          attemptNo: attempt.attemptNo,
          state: attempt.state,
          applicationEvidence: attempt.applicationEvidence ?? 'ambiguous',
        })),
      )
    } catch {
      return undefined
    }
    if (
      outcome.state === 'outcome-unknown' ||
      row.effect.state !== outcome.state ||
      receipt.appliedAttemptNo !== outcome.appliedAttemptNo ||
      receipt.priorAmbiguityCount !== outcome.priorAmbiguityCount
    )
      return undefined
    const attemptIds = new Set(oldGroup.map(({ attempt }) => attempt.id))
    const oldFences = before.fences.filter((fence) => attemptIds.has(fence.effectAttemptId))
    const newFences = after.fences.filter((fence) => attemptIds.has(fence.effectAttemptId))
    if (
      oldFences.length !== newFences.length ||
      oldFences.some((fence) => {
        const next = newFences.find(
          (item) =>
            item.effectAttemptId === fence.effectAttemptId && item.fenceKey === fence.fenceKey,
        )
        const expected = {
          ...fence,
          releasedAt:
            fence.effectAttemptId === old.attempt.id &&
            fence.acquiredEpoch === input.token.epoch &&
            fence.releasedAt === null
              ? input.now
              : fence.releasedAt,
        }
        return next === undefined || canonicalJson(next) !== canonicalJson(expected)
      })
    )
      return undefined
    resolved.add(old.effect.id)
  }
  if (resolved.size === 0) return undefined
  return {
    resolvedEffectIds: [...resolved].sort(),
    unresolvedEffectIds: [...unresolved].filter((id) => !resolved.has(id)).sort(),
  }
}

function captureTransferPersistence(
  persistence: TaskDriverFinalizationReleaseDependencies['persistence'],
  token: OwnershipToken,
  intentId: string,
): TaskDriverOwnerTransferPersistence & { awaitHeartbeatWrites(): Promise<void> } {
  const ownership = persistence.ownership,
    effects = persistence.effects
  const facts = taskDriverFinalizationFactQueries(ownership)
  if (facts === undefined) throw new Error('task-driver-finalization-facts-required')
  const readFacts = facts.read
  const synchronizeHeartbeatWrites = facts.awaitHeartbeatWrites
  let heartbeatWritesAcknowledged = false
  const awaitHeartbeatWrites = async (): Promise<void> => {
    if (heartbeatWritesAcknowledged) return
    await synchronizeHeartbeatWrites.call(facts, token)
    heartbeatWritesAcknowledged = true
  }
  const fact = () => readFacts.call(facts, token.taskId, intentId)
  const read = ownership.read,
    release = ownership.releaseAfterStop,
    recovery = ownership.markRecoveryRequired
  const resolve = effects.resolveQuiescedManagedProcesses,
    unresolved = effects.unresolvedEffectIds,
    close = effects.closeOutcomeUnknownAndRelease
  return Object.freeze({
    awaitHeartbeatWrites,
    ownership: Object.freeze({
      read: retainReply({
        invoke: async (taskId: string) => {
          await awaitHeartbeatWrites()
          const owner = await read.call(ownership, taskId)
          if (owner === null || !sameDriverOwner(owner, token))
            throw pending('original driver owner is unavailable for finalization')
          return owner
        },
      }),
      releaseAfterStop: retainReply({
        invoke: (argument: Parameters<typeof release>[0]) => release.call(ownership, argument),
        confirm: async (argument) => releasedReply(await fact(), argument),
      }),
      markRecoveryRequired: retainReply({
        invoke: (argument: Parameters<typeof recovery>[0]) => recovery.call(ownership, argument),
        confirm: async (argument) => recoveryReply(await fact(), argument),
      }),
    }),
    effects: Object.freeze({
      resolveQuiescedManagedProcesses: retainReply({
        invoke: (argument: Parameters<typeof resolve>[0]) => resolve.call(effects, argument),
        before: fact,
        confirm: async (argument, before) => managedProcessReply(before, await fact(), argument),
      }),
      unresolvedEffectIds: retainReply({
        invoke: (taskId: string) => unresolved.call(effects, taskId),
      }),
      closeOutcomeUnknownAndRelease: retainReply({
        invoke: (argument: Parameters<typeof close>[0]) => close.call(effects, argument),
        confirm: async (argument) => outcomeUnknownReply(await fact(), argument),
      }),
    }),
  })
}

/** A Task-owned lifetime barrier survives registry.settle and rejected cleanup. */
export function createTaskDriverFinalizations(): TaskDriverFinalizations {
  const byTask = new Map<string, DriverEntry>()
  const byController = new WeakMap<AbortController, Map<string, DriverEntry>>()
  const failedClaims = new Map<TaskHostFailedClaim, FailedClaimEntry>()
  const register = (input: AttachedDriver): DriverEntry => {
    if (input.token.taskId !== input.taskId || taskHostWorkForToken(input.token) !== input.work)
      throw new Error('task-driver-finalization-work-mismatch')
    if (byTask.has(input.taskId)) throw new Error('task-driver-finalization-pending')
    const entry: DriverEntry = {
      ...input,
      completed: taskHostWorkCompleted(input.work),
      phase: 'active',
      error: undefined,
    }
    byTask.set(input.taskId, entry)
    const controllers = byController.get(input.controller) ?? new Map<string, DriverEntry>()
    controllers.set(input.taskId, entry)
    byController.set(input.controller, controllers)
    return entry
  }
  const attempt = (entry: DriverEntry): Promise<void> => {
    if (entry.inFlight !== undefined) return entry.inFlight
    if (entry.progress === undefined) throw new Error('task-driver-finalization-not-started')
    const progress = entry.progress
    const run = (async () => {
      await progress.run()
      completeTaskHostWork(entry.work)
      if (byTask.get(entry.taskId) === entry) byTask.delete(entry.taskId)
      byController.get(entry.controller)?.delete(entry.taskId)
    })()
      .catch((error: unknown) => {
        entry.error = error
        throw error
      })
      .finally(() => {
        if (entry.inFlight === run) entry.inFlight = undefined
      })
    entry.inFlight = run
    return run
  }
  const attemptFailedClaim = (entry: FailedClaimEntry): Promise<void> => {
    if (entry.inFlight !== undefined) return entry.inFlight
    const run = (async () => {
      await entry.acknowledge()
      completeTaskHostWork(entry.work)
      failedClaims.delete(entry.claim)
    })()
      .catch((error: unknown) => {
        entry.error = error
        throw error
      })
      .finally(() => {
        if (entry.inFlight === run) entry.inFlight = undefined
      })
    entry.inFlight = run
    return run
  }
  const port: TaskDriverFinalizations = Object.freeze({
    attached: (input: AttachedDriver) => {
      register(input)
    },
    failedClaim(claim: TaskHostFailedClaim) {
      let entry = failedClaims.get(claim)
      if (entry === undefined) {
        const taskId = claim.taskId,
          acknowledge = claim.acknowledge
        if (typeof taskId !== 'function' || typeof acknowledge !== 'function')
          throw new Error('task-host-failed-claim-incomplete')
        entry = {
          claim,
          work: claim.work,
          taskId: () => taskId.call(claim),
          acknowledge: () => acknowledge.call(claim),
          completed: taskHostWorkCompleted(claim.work),
          error: undefined,
        }
        failedClaims.set(claim, entry)
      }
      return attemptFailedClaim(entry)
    },
    pendingForTask(taskId: string) {
      const waits: Promise<void>[] = []
      const driver = byTask.get(taskId)
      if (driver !== undefined) waits.push(driver.completed)
      for (const entry of failedClaims.values()) {
        const scope = entry.taskId()
        if (scope === undefined || scope === taskId) waits.push(entry.completed)
      }
      return waits.length === 0
        ? undefined
        : waits.length === 1
          ? waits[0]
          : Promise.all(waits).then(() => undefined)
    },
    async retryPending() {
      await Promise.all([
        ...[...byTask.values()].filter((entry) => entry.phase === 'pending').map(attempt),
        ...[...failedClaims.values()].map(attemptFailedClaim),
      ])
    },
    async drain() {
      await port.retryPending()
      while (byTask.size > 0 || failedClaims.size > 0)
        await Promise.all(
          [...byTask.values(), ...failedClaims.values()].map((entry) => entry.completed),
        )
    },
    snapshot: () =>
      Object.freeze([
        ...[...byTask.values()].map(({ taskId, phase, error }) =>
          Object.freeze({ taskId, phase, error }),
        ),
        ...[...failedClaims.values()].map((entry) =>
          Object.freeze({
            taskId: entry.taskId(),
            phase: 'pending' as const,
            error: entry.error,
          }),
        ),
      ]),
  })
  controls.set(port, {
    async release(deps, input, transfer) {
      const taskId = input.taskId,
        controller = input.controller
      const entry = byController.get(controller)?.get(taskId)
      if (entry === undefined) {
        const token = deps.registry.tokenForTask(taskId)
        if (token !== null && deps.registry.controllerFor(token) === controller)
          throw new Error('task-driver-finalization-work-required')
        return
      }
      if (entry.progress === undefined) {
        const registry = deps.registry,
          token = registry.tokenForTask(taskId)
        if (token !== entry.token || registry.controllerFor(entry.token) !== controller)
          throw pending('original driver registry changed before finalization')
        const intentId = registry.intentFor(token)
        if (intentId === null)
          throw pending('original driver intent is unavailable for finalization')
        const persistence = captureTransferPersistence(deps.persistence, token, intentId)
        const effects = deps.persistence.effects,
          unreapedCode = effects.unreapedProcessCode
        const release = registry.release,
          settle = registry.settle
        const stopHeartbeat = deps.stopHeartbeat,
          awaitHeartbeatAcks = deps.awaitHeartbeatAcks,
          finalizeWorkspace = deps.finalizeWorkspace
        if (typeof awaitHeartbeatAcks !== 'function')
          throw new Error('task-driver-heartbeat-drain-required')
        let stopResult: RuntimeStopResult | undefined,
          heartbeatStopped = false,
          heartbeatDrained = false,
          transferred = false,
          settled = false,
          workspaceFinalized = false
        entry.progress = {
          async run() {
            if (stopResult === undefined) {
              const unreaped = await unreapedCode.call(effects, taskId)
              stopResult =
                release.call(registry, {
                  token,
                  controller: controller,
                  result:
                    unreaped === null ? { kind: 'released' } : { kind: 'unreaped', code: unreaped },
                }) ?? undefined
              if (stopResult === undefined)
                throw pending('original driver release was not acknowledged')
            }
            if (!heartbeatStopped) {
              stopHeartbeat.call(deps, ownershipTokenKey(token))
              heartbeatStopped = true
            }
            if (!heartbeatDrained) {
              await awaitHeartbeatAcks.call(deps, ownershipTokenKey(token))
              heartbeatDrained = true
            }
            // A rejected client Promise alone does not end the server writer.
            // Keep both barriers outside the transfer's legacy settle-finally.
            await persistence.awaitHeartbeatWrites()
            try {
              if (!transferred) {
                await transfer(persistence, { taskId: taskId, token, intentId, stopResult })
                transferred = true
              }
            } finally {
              if (!settled) {
                settle.call(registry, token)
                settled = true
              }
            }
            if (!workspaceFinalized) {
              await finalizeWorkspace.call(deps, taskId)
              workspaceFinalized = true
            }
          },
        }
        entry.phase = 'pending'
      }
      await attempt(entry)
    },
    async retreat(input) {
      const { taskId, token, controller, work, intentId, persistence: ownership } = input
      const entry = register({ taskId, token, controller, work })
      const read = ownership.read,
        mark = ownership.markRecoveryRequired
      const facts = taskDriverFinalizationFactQueries(ownership),
        readFacts = facts?.read
      if (facts === undefined || readFacts === undefined)
        throw new Error('task-driver-finalization-facts-required')
      const markOnce = retainReply({
        invoke: (argument: Parameters<typeof mark>[0]) => mark.call(ownership, argument),
        confirm: async (argument) =>
          recoveryReply(await readFacts.call(facts, taskId, intentId), argument),
      })
      let argument: Parameters<typeof mark>[0] | undefined
      entry.progress = {
        async run() {
          if (argument === undefined) {
            const owner = await read.call(ownership, taskId)
            if (owner === null || !sameDriverOwner(owner, token))
              throw pending('unattached original driver owner is unavailable')
            argument = {
              token: token,
              expectedRevision: owner.revision,
              code: 'task-host-driver-not-attached',
              evidenceDigest: null,
              now: Date.now(),
            }
          }
          await markOnce(argument)
        },
      }
      entry.phase = 'pending'
      await attempt(entry)
    },
  })
  return port
}

export function releaseTaskDriverFinalization(
  port: TaskDriverFinalizations,
  deps: TaskDriverFinalizationReleaseDependencies,
  input: { taskId: string; controller: AbortController },
  transfer: TransferOwner,
): Promise<void> {
  const control = controls.get(port)
  if (control === undefined) throw new Error('task-driver-finalization-selection-incomplete')
  return control.release(deps, input, transfer)
}

export function retreatUnattachedTaskDriver(
  port: TaskDriverFinalizations,
  input: AttachedDriver & {
    readonly intentId: string
    readonly persistence: TaskExecutionPersistence['ownership']
  },
): Promise<void> {
  const control = controls.get(port)
  if (control === undefined) throw new Error('task-driver-finalization-selection-incomplete')
  return control.retreat(input)
}
