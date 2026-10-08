import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import type {
  HostExecutionAdmission,
  HostExecutionAdmissionLease,
  HostExecutionStopReason,
} from '@/modules/system-operations/public/participants'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { composeTaskHostExecutionAdmission } from '@/modules/task-execution/composition/hostExecutionAdmission'
import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/infrastructure/hostExecutionWriteContext'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createProviderTaskExecutionModule,
  TaskExecutionModule,
  ProviderTaskExecutionModule,
} from '@/modules/task-execution/composition'
import { canonicalJson, type LineageSlot } from '@/modules/task-execution/domain/executionIntent'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import { createLogger } from '@/util/log'

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export async function seedTaskHostIntent(
  db: ProviderNeutralDatabase,
  taskId: string,
  intentId: string,
  generation = 0,
) {
  const slotPath: readonly LineageSlot[] = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  return new DrizzleTaskExecutionIntentPersistence(db).submit({
    intentId,
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'task-host-actor',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: `${taskId}:root:${generation}`,
        slotPath,
        operationGeneration: generation,
      },
      payload: { v: 1 },
    },
  })
}

async function seedTaskHostFixtureTask(db: ProviderNeutralDatabase, taskId: string) {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  const slotPath: readonly LineageSlot[] = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db.insert(workflows).values({
    id: `workflow-${taskId}`,
    name: taskId,
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `workflow-${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(slotPath),
  })
  const intentId = `intent-${taskId}`
  await seedTaskHostIntent(db, taskId, intentId)
  return intentId
}

/** A real selected write context, original Drizzle persistence and real Task claim/lifecycle. */
export async function taskHostFixture(
  db: ProviderNeutralDatabase,
  taskId: string,
  options: {
    readonly mode?: 'direct' | 'provider'
    readonly beforeNewWork?: () => void
    readonly beforeIssuedAck?: () => void
    readonly finalizeWorkspace?: (taskId: string) => Promise<void>
  } = {},
) {
  const intentId = await seedTaskHostFixtureTask(db, taskId)
  let current = true,
    unavailable: string | undefined,
    completed = 0
  const stopped = deferred<HostExecutionStopReason>()
  const events: string[] = [],
    leases: HostExecutionAdmissionLease[] = []
  const selected = composeHostExecutionWriteContext(db)
  const grant = Object.freeze({
    generation: `host-${taskId}`,
    reference: Object.freeze({}),
    current: () => current,
  })
  const receipt = await selected.context.prepare({
    context: grant,
    holder: `holder-${taskId}`,
    expiresAt: Date.now() + 60_000,
  })
  await selected.context.activate(receipt)
  const originalBinding = createTaskHostWriteContextAdapter(selected)
  const originalPort = originalBinding.port
  const binding =
    options.beforeNewWork === undefined && options.beforeIssuedAck === undefined
      ? originalBinding
      : Object.freeze({
          transactionFor: (tx: Parameters<typeof originalBinding.transactionFor>[0]) =>
            originalBinding.transactionFor(tx),
          port: Object.freeze({
            capture: (input: Parameters<typeof originalPort.capture>[0]) =>
              originalPort.capture(input),
            consumeNewWork: async (...args: Parameters<typeof originalPort.consumeNewWork>) => {
              options.beforeNewWork?.()
              await originalPort.consumeNewWork(...args)
            },
            consumeRecovery: (...args: Parameters<typeof originalPort.consumeRecovery>) =>
              originalPort.consumeRecovery(...args),
            consumeIssuedAck: async (...args: Parameters<typeof originalPort.consumeIssuedAck>) => {
              await originalPort.consumeIssuedAck(...args)
              options.beforeIssuedAck?.()
            },
          }),
        })
  const source: HostExecutionAdmission = {
    acquire(group) {
      if (group !== 'task') throw new Error('unexpected Task admission group')
      events.push('admission')
      if (unavailable !== undefined || !current)
        return { kind: 'unavailable', reason: unavailable ?? 'lost' }
      const lease: HostExecutionAdmissionLease = {
        generation: grant.generation,
        reference: grant.reference,
        stopped: stopped.promise,
        complete() {
          if (this !== lease) throw new Error('original lease receiver changed')
          completed++
          events.push('complete')
        },
      }
      leases.push(lease)
      return { kind: 'admitted', lease }
    },
  }
  const host = {
    admission: composeTaskHostExecutionAdmission({ admission: source, writes: binding.port }),
    writes: binding,
  }
  const persistence = createTaskExecutionPersistence(db, { hostWrites: binding })
  const module =
    options.mode === 'direct'
      ? new TaskExecutionModule(`daemon-${taskId}`, host)
      : createProviderTaskExecutionModule({
          daemonGeneration: `daemon-${taskId}`,
          persistence,
          host,
        })
  const claim = (id = intentId) =>
    module instanceof ProviderTaskExecutionModule
      ? module.claimPersisted({ intentId: id })
      : module.claim({ db, intentId: id })
  const lifecycle = createTaskDriverLifecyclePort({
    db,
    module,
    claim,
    persistence,
    log: createLogger('rfc370-task-host-fixture'),
    finalizeWorkspace: options.finalizeWorkspace ?? (async () => {}),
    legacyConnection: db,
  })
  return {
    db,
    taskId,
    intentId,
    selected,
    receipt,
    grant,
    binding,
    source,
    host,
    persistence,
    module,
    claim,
    lifecycle,
    events,
    leases,
    get completed() {
      return completed
    },
    deny(reason: string) {
      unavailable = reason
    },
    allow() {
      unavailable = undefined
    },
    lose() {
      current = false
      stopped.resolve('authority-loss')
    },
  }
}

export type TaskHostWorkFixture = Pick<
  Awaited<ReturnType<typeof taskHostFixture>>,
  | 'db'
  | 'taskId'
  | 'intentId'
  | 'binding'
  | 'persistence'
  | 'module'
  | 'claim'
  | 'completed'
  | 'leases'
  | 'lose'
>

/** Another real Task uses the same installation, host admission and Task module. */
export async function additionalTaskHostFixture(
  original: TaskHostWorkFixture,
  taskId: string,
): Promise<TaskHostWorkFixture> {
  const intentId = await seedTaskHostFixtureTask(original.db, taskId)
  return {
    db: original.db,
    taskId,
    intentId,
    binding: original.binding,
    persistence: original.persistence,
    module: original.module,
    claim: (id = intentId) => original.claim(id),
    get completed() {
      return original.completed
    },
    get leases() {
      return original.leases
    },
    lose: () => original.lose(),
  }
}
