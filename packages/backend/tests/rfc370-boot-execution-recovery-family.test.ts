// RFC-370: boot recovery uses one selected four-member family before any automatic work.
// Original real SQLite/PostgreSQL recovery remains in rfc359-w3-t4-boot-recovery.test.ts.
import { describe, expect, test } from 'bun:test'
import { runBootExecutionRecovery } from '@/modules/task-execution/application/bootExecutionRecovery'
import { runTaskExecutionBootRecovery } from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import { createLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/infrastructure/local/bootExecutionRecovery'
import type {
  BootExecutionRecoveryFactory,
  BootExecutionRecoveryFamily,
  BootExecutionRecoveryRef,
  BootRecoveryLogger,
  ReapResult,
  TaskExecutionBootRecoveryInput,
} from '@/modules/task-execution/application/ports/bootExecutionRecovery'
import type {
  TaskExecutionRecoveryFinalization,
  TaskExecutionRecoveryPersistence,
} from '@/modules/task-execution/application/recoverTaskExecutions'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { RuntimeSessionLeaseOperations } from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'
import { createExclusiveDaemonLockProof } from '@/modules/task-execution/domain/ownership'

const members = ['prepare', 'reap', 'repair', 'finalize'] as const
type Member = (typeof members)[number]
const emptyFinalization = (): TaskExecutionRecoveryFinalization => ({
  releasedTaskIds: [],
  outcomeUnknownTaskIds: [],
  recoveredProcessEffectIds: [],
  recoveredCodeHostEffectIds: [],
  retryAuthorizedCodeHostEffectIds: [],
})
class OpaqueReference {
  get pid(): never {
    throw new Error('common recovery interpreted native process facts')
  }
  get path(): never {
    throw new Error('common recovery interpreted native paths')
  }
  get orphanReaperCompleted(): never {
    throw new Error('common recovery interpreted native evidence')
  }
}
type LogEntry = readonly ['info' | 'warn', string, Record<string, unknown> | undefined]
function logger() {
  const entries: LogEntry[] = []
  const log: BootRecoveryLogger = {
    info(message, fields) {
      entries.push(['info', message, fields])
    },
    warn(message, fields) {
      entries.push(['warn', message, fields])
    },
  }
  return { log, entries }
}
function portableInput(log: BootRecoveryLogger): TaskExecutionBootRecoveryInput {
  return {
    get persistence(): never {
      throw new Error('common recovery read local persistence')
    },
    get runtimeSessionLeases(): never {
      throw new Error('common recovery read local leases')
    },
    get lockProof(): never {
      throw new Error('common recovery read local proof')
    },
    get codeHostProbe(): never {
      throw new Error('common recovery read local probe')
    },
    log,
  }
}
class SelectedFamily implements BootExecutionRecoveryFamily {
  readonly #reapRef = Object.freeze(new OpaqueReference())
  readonly #finalizationRef = Object.freeze(new OpaqueReference())
  readonly calls: Member[] = []
  readonly entered = Object.fromEntries(
    members.map((m) => [m, Promise.withResolvers<void>()]),
  ) as Record<Member, ReturnType<typeof Promise.withResolvers<void>>>
  readonly releases = Object.fromEntries(
    members.map((m) => [m, Promise.withResolvers<void>()]),
  ) as Record<Member, ReturnType<typeof Promise.withResolvers<void>>>
  readonly preparation = { revokedTaskIds: ['previous-owner'] }
  readonly counts: ReapResult = { tasks: 2, runs: 3 }
  leases = 4
  readonly finalization: TaskExecutionRecoveryFinalization = {
    releasedTaskIds: ['released'],
    outcomeUnknownTaskIds: ['unknown'],
    recoveredProcessEffectIds: ['process'],
    recoveredCodeHostEffectIds: ['code-host'],
    retryAuthorizedCodeHostEffectIds: ['retry'],
  }
  constructor(
    readonly held = false,
    readonly failures: Partial<Record<Member, Error>> = {},
  ) {}
  async #enter(member: Member) {
    this.calls.push(member)
    this.entered[member].resolve()
    if (this.held) await this.releases[member].promise
    if (this.failures[member] !== undefined) throw this.failures[member]
  }
  async prepare() {
    await this.#enter('prepare')
    return this.preparation
  }
  async reap() {
    await this.#enter('reap')
    return { counts: this.counts, reapRef: this.#reapRef }
  }
  async repair(reapRef: BootExecutionRecoveryRef) {
    expect(reapRef).toBe(this.#reapRef)
    await this.#enter('repair')
    return { leases: this.leases, finalizationRef: this.#finalizationRef }
  }
  async finalize(finalizationRef: BootExecutionRecoveryRef) {
    expect(finalizationRef).toBe(this.#finalizationRef)
    await this.#enter('finalize')
    return this.finalization
  }
}
class SelectedFactory implements BootExecutionRecoveryFactory {
  #creates = 0
  get creates() {
    return this.#creates
  }
  constructor(
    readonly input: TaskExecutionBootRecoveryInput,
    readonly family: BootExecutionRecoveryFamily,
  ) {}
  create(input: TaskExecutionBootRecoveryInput) {
    this.#creates++
    expect(input).toBe(this.input)
    return this.family
  }
}

describe('RFC-370 selected boot recovery family', () => {
  test('prototype receivers, opaque references, every ACK, and original report identities', async () => {
    const { log, entries } = logger()
    const input = portableInput(log)
    const family = new SelectedFamily(true)
    const factory = new SelectedFactory(input, family)
    let settled = false
    const pending = runBootExecutionRecovery(factory, input).then((report) => {
      settled = true
      return report
    })
    for (const [index, member] of members.entries()) {
      await family.entered[member].promise
      expect(family.calls).toEqual(members.slice(0, index + 1))
      expect(settled).toBe(false)
      expect(factory.creates).toBe(1)
      expect(entries).toHaveLength(index)
      family.releases[member].resolve()
    }
    const report = await pending
    expect(report.revokedTaskIds).toBe(family.preparation.revokedTaskIds)
    expect(report.reap).toBe(family.counts)
    expect(report.repairedRuntimeLeases).toBe(family.leases)
    expect(report.finalization).toBe(family.finalization)
    expect(entries).toEqual([
      ['warn', 'revoked task owners left by a previous daemon', { tasks: 1 }],
      ['warn', 'reaped orphan runs from previous daemon', { tasks: 2, runs: 3 }],
      ['info', 'released runtime session leases held by terminal orphan runs', { leases: 4 }],
      [
        'info',
        'durable task execution recovery finalized',
        {
          released: 1,
          outcomeUnknown: 1,
          recoveredProcessEffects: 1,
          recoveredCodeHostEffects: 1,
          retryAuthorizedCodeHostEffects: 1,
        },
      ],
    ])
  })
  for (const member of members) {
    test(`${member} rejection stops the original sequence and remains visible`, async () => {
      const { log, entries } = logger()
      const input = portableInput(log)
      const failure = new Error('selected:' + member)
      const family = new SelectedFamily(false, { [member]: failure })
      const factory = new SelectedFactory(input, family)
      await expect(runBootExecutionRecovery(factory, input)).rejects.toBe(failure)
      const index = members.indexOf(member)
      expect(family.calls).toEqual(members.slice(0, index + 1))
      expect(entries).toHaveLength(index)
      expect(factory.creates).toBe(1)
    })
    test(`${member} missing from a selected family does not invoke local recovery`, async () => {
      const { log, entries } = logger()
      const input = portableInput(log)
      const family = new SelectedFamily()
      Object.defineProperty(family, member, { value: undefined })
      await expect(
        runBootExecutionRecovery(new SelectedFactory(input, family), input),
      ).rejects.toBeInstanceOf(TypeError)
      const index = members.indexOf(member)
      expect(family.calls).toEqual(members.slice(0, index))
      expect(entries).toHaveLength(index)
    })
  }
  test('factory rejection occurs before any recovery or logging', async () => {
    const { log, entries } = logger()
    const input = portableInput(log)
    const failure = new Error('selected-create')
    const factory: BootExecutionRecoveryFactory = {
      create() {
        throw failure
      },
    }
    await expect(runBootExecutionRecovery(factory, input)).rejects.toBe(failure)
    expect(entries).toEqual([])
  })
  test('missing selected create remains visible', async () => {
    const { log, entries } = logger()
    const input = portableInput(log)
    const factory = new SelectedFactory(input, new SelectedFamily())
    Object.defineProperty(factory, 'create', { value: undefined })
    await expect(runBootExecutionRecovery(factory, input)).rejects.toBeInstanceOf(TypeError)
    expect(entries).toEqual([])
  })
  test('each invocation creates a fresh selected family', async () => {
    const { log } = logger()
    const input = portableInput(log)
    const families: SelectedFamily[] = []
    const factory: BootExecutionRecoveryFactory = {
      create(selected) {
        expect(selected).toBe(input)
        const family = new SelectedFamily()
        families.push(family)
        return family
      },
    }
    const first = await runBootExecutionRecovery(factory, input)
    const second = await runBootExecutionRecovery(factory, input)
    expect(families).toHaveLength(2)
    expect(first.reap).not.toBe(second.reap)
    expect(families[0]!.calls).toEqual(members)
    expect(families[1]!.calls).toEqual(members)
  })
  test('a complete synchronous family keeps the same sequence and result identities', async () => {
    const { log } = logger()
    const input = portableInput(log)
    const calls: Member[] = []
    const reapRef = new OpaqueReference()
    const finalizationRef = new OpaqueReference()
    const counts = { tasks: 0, runs: 0 }
    const finalization = emptyFinalization()
    const family: BootExecutionRecoveryFamily = {
      prepare() {
        calls.push('prepare')
        return { revokedTaskIds: [] }
      },
      reap() {
        calls.push('reap')
        return { counts, reapRef }
      },
      repair(reference) {
        expect(reference).toBe(reapRef)
        calls.push('repair')
        return { leases: 0, finalizationRef }
      },
      finalize(reference) {
        expect(reference).toBe(finalizationRef)
        calls.push('finalize')
        return finalization
      },
    }
    const report = await runBootExecutionRecovery(new SelectedFactory(input, family), input)
    expect(calls).toEqual(members)
    expect(report.reap).toBe(counts)
    expect(report.finalization).toBe(finalization)
  })
  test('native compatibility entry uses the selected factory and the same input', async () => {
    const { log } = logger()
    const input = portableInput(log)
    const family = new SelectedFamily()
    const factory = new SelectedFactory(input, family)
    let reads = 0
    Object.defineProperty(input, 'recoveryEffects', {
      get() {
        reads++
        return factory
      },
    })
    expect(selectLocalBootExecutionRecoveryFactory(factory)).toBe(factory)
    expect((await runTaskExecutionBootRecovery(input)).finalization).toBe(family.finalization)
    expect(reads).toBe(1)
    expect(factory.creates).toBe(1)
  })
  test('zero original counts emit no messages', async () => {
    const { log, entries } = logger()
    const input = portableInput(log)
    const family = new SelectedFamily()
    family.preparation.revokedTaskIds.splice(0)
    family.counts.tasks = 0
    family.counts.runs = 0
    family.leases = 0
    Object.assign(family.finalization, emptyFinalization())
    await runBootExecutionRecovery(new SelectedFactory(input, family), input)
    expect(family.calls).toEqual(members)
    expect(entries).toEqual([])
  })
  test('runs and unknown outcomes alone preserve original log conditions', async () => {
    const { log, entries } = logger()
    const input = portableInput(log)
    const family = new SelectedFamily()
    family.preparation.revokedTaskIds.splice(0)
    family.counts.tasks = 0
    family.leases = 0
    Object.assign(family.finalization, emptyFinalization(), { outcomeUnknownTaskIds: ['unknown'] })
    await runBootExecutionRecovery(new SelectedFactory(input, family), input)
    expect(entries).toEqual([
      ['warn', 'reaped orphan runs from previous daemon', { tasks: 0, runs: 3 }],
      [
        'info',
        'durable task execution recovery finalized',
        {
          released: 0,
          outcomeUnknown: 1,
          recoveredProcessEffects: 0,
          recoveredCodeHostEffects: 0,
          retryAuthorizedCodeHostEffects: 0,
        },
      ],
    ])
  })
})

function unexpected(): never {
  throw new Error('unexpected native operation')
}
function nativeInput(failureAt?: Member, probePresent = true) {
  const order: string[] = []
  const failure = new Error('native:' + failureAt)
  const proof = createExclusiveDaemonLockProof({
    daemonGeneration: 'native-selected-generation',
    acquiredAt: 1000,
    lockReceiptDigest: 'native-selected-receipt',
  })
  const finalization = emptyFinalization()
  const probe: NonNullable<TaskExecutionBootRecoveryInput['codeHostProbe']> = async () =>
    unexpected()
  const recovery: TaskExecutionRecoveryPersistence = {
    async prepare(input) {
      order.push('prepare')
      expect(input.lockProof).toBe(proof)
      if (failureAt === 'prepare') throw failure
      return { revokedTaskIds: [] }
    },
    async finalize(input) {
      order.push('finalize')
      expect(input.lockProof).toBe(proof)
      expect(input.processEvidence).toEqual({
        orphanReaperCompleted: true,
        orphanTasks: 0,
        orphanRuns: 0,
        repairedRuntimeLeases: 2,
      })
      expect(Object.hasOwn(input, 'codeHostProbe')).toBe(probePresent)
      if (probePresent) expect(input.codeHostProbe).toBe(probe)
      if (failureAt === 'finalize') throw failure
      return finalization
    },
  }
  const recoveryAdministration: TaskRecoveryOperations = {
    async loadBootOrphanSnapshot() {
      order.push('reap')
      if (failureAt === 'reap') throw failure
      return { tasks: [], runs: [], heldLeaseRunIds: [], heldLeaseRuns: [] }
    },
    recordEvent: unexpected,
    listEventsForTask: unexpected,
    isAutoRecoverySuspended: unexpected,
    recordAutoRecoveryAttempt: unexpected,
    clearAutoRecoverySuspension: unexpected,
    listOpenLifecycleAlerts: unexpected,
    taskIdsWithRepoPrepRow: unexpected,
    listStalledRunningChildren: unexpected,
    listAutoResumeCandidates: unexpected,
    interruptBootOrphanTask: unexpected,
    interruptNodeRun: unexpected,
    listPeriodicReconcileCandidates: unexpected,
    loadPeriodicReconcileSnapshot: unexpected,
    findHeldRuntimeSessionId: unexpected,
    repairRuntimeSessionLeaseAfterOrphanReap: unexpected,
    interruptPeriodicTaskIfIdle: unexpected,
    loadStuckTaskSnapshots: unexpected,
    loadLifecycleInvariantSnapshots: unexpected,
    reconcileStuckAlerts: unexpected,
  }
  const runtimeSessionLeases: RuntimeSessionLeaseOperations = {
    async repairAfterOrphanReap(nodeRunId) {
      order.push('repair')
      expect(nodeRunId).toBeUndefined()
      if (failureAt === 'repair') throw failure
      return 2
    },
    load: unexpected,
    claimNew: unexpected,
    preclaimResume: unexpected,
    confirmResume: unexpected,
    rotate: unexpected,
    markResetPending: unexpected,
    discard: unexpected,
    release: unexpected,
  }
  const persistence = { recovery, recoveryAdministration }
  const { log } = logger()
  const input: TaskExecutionBootRecoveryInput = {
    get persistence() {
      order.push('persistence')
      return persistence
    },
    get runtimeSessionLeases() {
      order.push('leases')
      return runtimeSessionLeases
    },
    get lockProof() {
      order.push('proof')
      return proof
    },
    get codeHostProbe() {
      order.push('probe')
      return probePresent ? probe : undefined
    },
    log,
  }
  return { input, order, failure, finalization }
}
describe('RFC-370 original local boot pairing', () => {
  test('create captures input without reads; original ports and probe are read at their stage', async () => {
    const { input, order, finalization } = nativeInput()
    const factory = createLocalBootExecutionRecoveryFactory()
    const family = factory.create(input)
    expect(order).toEqual([])
    await family.prepare()
    expect(order).toEqual(['persistence', 'proof', 'prepare'])
    const reap = await family.reap()
    expect(order).toEqual(['persistence', 'proof', 'prepare', 'persistence', 'reap'])
    const repair = await family.repair(reap.reapRef)
    expect(order).toEqual([
      'persistence',
      'proof',
      'prepare',
      'persistence',
      'reap',
      'leases',
      'repair',
    ])
    expect(await family.finalize(repair.finalizationRef)).toBe(finalization)
    expect(order).toEqual([
      'persistence',
      'proof',
      'prepare',
      'persistence',
      'reap',
      'leases',
      'repair',
      'persistence',
      'proof',
      'probe',
      'probe',
      'finalize',
    ])
  })
  test('undefined probe retains the original omitted finalization property', async () => {
    const { input, order, finalization } = nativeInput(undefined, false)
    const report = await runBootExecutionRecovery(createLocalBootExecutionRecoveryFactory(), input)
    expect(report.finalization).toBe(finalization)
    expect(order.filter((entry) => entry === 'probe')).toHaveLength(1)
    expect(order.filter((entry) => members.includes(entry as Member))).toEqual(members)
  })
  test('references from another create report a pairing error before reading later inputs', async () => {
    const { input, order } = nativeInput()
    const factory = createLocalBootExecutionRecoveryFactory()
    const first = factory.create(input)
    const second = factory.create(input)
    await first.prepare()
    const reap = await first.reap()
    const beforeRepair = [...order]
    await expect(second.repair(reap.reapRef)).rejects.toThrow(
      'boot recovery reference belongs to another pairing',
    )
    expect(order).toEqual(beforeRepair)
    const repaired = await first.repair(reap.reapRef)
    const beforeFinalization = [...order]
    await expect(second.finalize(repaired.finalizationRef)).rejects.toThrow(
      'boot recovery reference belongs to another pairing',
    )
    expect(order).toEqual(beforeFinalization)
  })
  for (const member of members) {
    test(`original ${member} port rejection stays visible through local pairing`, async () => {
      const { input, order, failure } = nativeInput(member)
      await expect(
        runBootExecutionRecovery(createLocalBootExecutionRecoveryFactory(), input),
      ).rejects.toBe(failure)
      expect(order.filter((entry) => members.includes(entry as Member))).toEqual(
        members.slice(0, members.indexOf(member) + 1),
      )
      if (member !== 'finalize') expect(order).not.toContain('probe')
    })
  }
})
