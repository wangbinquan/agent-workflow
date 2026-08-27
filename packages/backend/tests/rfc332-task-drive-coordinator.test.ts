import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { createTaskExecutionContext } from '../src/modules/task-execution/application/taskExecutionContext'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '../src/modules/task-execution/domain/ownership'
import {
  DefaultTaskDriveCoordinator,
  type AdmittedContinuationStep,
  type RepositoryPreparationStep,
  type TaskDriveFailureReporter,
  type TaskDriverLifecyclePort,
  type TaskEngineOrchestrationPort,
} from '../src/modules/task-execution/application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '../src/modules/task-execution/application/drive/taskDriveTypes'
import type { DbClient } from '../src/db/client'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function applicationFixture(input?: {
  readonly attach?: 'attached' | 'not-attached'
  readonly admittedContinuation?: AdmittedContinuationStep
  readonly preparation?: RepositoryPreparationStep
  readonly engine?: TaskEngineOrchestrationPort
  readonly reporter?: TaskDriveFailureReporter
}) {
  const events: string[] = []
  const released = deferred<void>()
  let attachedController: AbortController | null = null
  const lifecycle: TaskDriverLifecyclePort = {
    async attach(request) {
      events.push(`attach:${request.taskId}:${request.intentId}`)
      attachedController = request.controller
      if (input?.attach === 'not-attached') return { kind: 'not-attached' }
      const token = createOwnershipToken({
        taskId: request.taskId,
        identity: createWorkerIdentity({
          ownerId: ulid(),
          daemonGeneration: 'rfc332-test',
        }),
        epoch: 1,
        leaseUntil: Date.now() + 60_000,
        ownerRevision: 1,
      })
      return {
        kind: 'attached',
        attachment: {
          execution: createTaskExecutionContext({
            intentId: request.intentId,
            token,
            db: {} as DbClient,
          }),
        },
      }
    },
    async releaseAndFinalize(request) {
      if (attachedController === null) throw new Error('release without attach')
      expect(request.controller === attachedController).toBe(true)
      events.push(`release:${request.taskId}`)
      released.resolve()
    },
  }
  const preparation: RepositoryPreparationStep =
    input?.preparation ??
    ({
      async run(context) {
        events.push(`prepare:${context.taskId}`)
        return { kind: 'ready' }
      },
    } satisfies RepositoryPreparationStep)
  const engine: TaskEngineOrchestrationPort =
    input?.engine ??
    ({
      async drive(context) {
        events.push(`engine:${context.taskId}`)
      },
    } satisfies TaskEngineOrchestrationPort)
  const reporter: TaskDriveFailureReporter =
    input?.reporter ??
    ({
      report(request) {
        events.push(`error:${request.taskId}:${String(request.error)}`)
      },
    } satisfies TaskDriveFailureReporter)
  return {
    coordinator: new DefaultTaskDriveCoordinator({
      runtime: resolveTaskDriveConfig({ appHome: '/tmp/rfc332-drive' }),
      lifecycle,
      ...(input?.admittedContinuation === undefined
        ? {}
        : { admittedContinuation: input.admittedContinuation }),
      repositoryPreparation: preparation,
      engineOrchestrator: engine,
      failureReporter: reporter,
    }),
    events,
    controller: () => attachedController,
    released: released.promise,
  }
}

describe('RFC-332 T9 — TaskDriveCoordinator', () => {
  test('await-settle owns attach → phase 0 → engine → release ordering', async () => {
    const fixture = applicationFixture()
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-await',
        intentId: 'intent-await',
        completionMode: 'await-settle',
      }),
    ).resolves.toEqual({ kind: 'settled', taskId: 'task-await' })
    expect(fixture.events).toEqual([
      'attach:task-await:intent-await',
      'prepare:task-await',
      'engine:task-await',
      'release:task-await',
    ])
  })

  test('background returns after attach while the controlled drive remains owned', async () => {
    const gate = deferred<void>()
    const fixture = applicationFixture({
      engine: {
        async drive(context) {
          fixture.events.push(`engine-start:${context.taskId}`)
          await gate.promise
          fixture.events.push(`engine-end:${context.taskId}`)
        },
      },
    })
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-background',
        intentId: 'intent-background',
        completionMode: 'background',
      }),
    ).resolves.toEqual({ kind: 'accepted', taskId: 'task-background' })
    expect(fixture.events).toEqual([
      'attach:task-background:intent-background',
      'prepare:task-background',
      'engine-start:task-background',
    ])

    gate.resolve()
    await fixture.released
    expect(fixture.events).toEqual([
      'attach:task-background:intent-background',
      'prepare:task-background',
      'engine-start:task-background',
      'engine-end:task-background',
      'release:task-background',
    ])
  })

  test('background receipt waits for admitted continuation but not for engine settlement', async () => {
    const continuationGate = deferred<void>()
    const engineGate = deferred<void>()
    const fixture = applicationFixture({
      admittedContinuation: {
        async run(context) {
          fixture.events.push(`continuation-start:${context.taskId}`)
          await continuationGate.promise
          fixture.events.push(`continuation-end:${context.taskId}`)
          return { kind: 'ready' }
        },
      },
      engine: {
        async drive(context) {
          fixture.events.push(`engine-start:${context.taskId}`)
          await engineGate.promise
        },
      },
    })
    let receiptSettled = false
    const receipt = fixture.coordinator
      .submit({
        taskId: 'task-continuation',
        intentId: 'intent-continuation',
        completionMode: 'background',
      })
      .then((value) => {
        receiptSettled = true
        return value
      })
    await Promise.resolve()
    expect(receiptSettled).toBe(false)
    expect(fixture.events).toEqual([
      'attach:task-continuation:intent-continuation',
      'continuation-start:task-continuation',
    ])

    continuationGate.resolve()
    await expect(receipt).resolves.toEqual({ kind: 'accepted', taskId: 'task-continuation' })
    expect(fixture.events).toEqual([
      'attach:task-continuation:intent-continuation',
      'continuation-start:task-continuation',
      'continuation-end:task-continuation',
      'prepare:task-continuation',
      'engine-start:task-continuation',
    ])
    engineGate.resolve()
    await fixture.released
  })

  test('terminal admitted continuation skips phase 0 and releases once', async () => {
    const fixture = applicationFixture({
      admittedContinuation: {
        async run(context) {
          fixture.events.push(`continuation-terminal:${context.taskId}`)
          return { kind: 'terminal-won' }
        },
      },
    })
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-continuation-terminal',
        intentId: 'intent-continuation-terminal',
        completionMode: 'background',
      }),
    ).resolves.toEqual({ kind: 'accepted', taskId: 'task-continuation-terminal' })
    expect(fixture.events).toEqual([
      'attach:task-continuation-terminal:intent-continuation-terminal',
      'continuation-terminal:task-continuation-terminal',
      'release:task-continuation-terminal',
    ])
  })

  test('admitted continuation failure reports its stage, releases, and rejects background submit', async () => {
    const fixture = applicationFixture({
      admittedContinuation: {
        async run() {
          throw new Error('continuation-boom')
        },
      },
      reporter: {
        report(request) {
          fixture.events.push(`error:${request.stage}:${request.taskId}:${String(request.error)}`)
        },
      },
    })
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-continuation-failure',
        intentId: 'intent-continuation-failure',
        completionMode: 'background',
      }),
    ).rejects.toThrow('continuation-boom')
    expect(fixture.events).toEqual([
      'attach:task-continuation-failure:intent-continuation-failure',
      'error:admission-continuation:task-continuation-failure:Error: continuation-boom',
      'release:task-continuation-failure',
    ])
  })

  test('not-attached never enters phase 0 and does not release an unowned handle', async () => {
    const fixture = applicationFixture({ attach: 'not-attached' })
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-race-loser',
        intentId: 'intent-race-loser',
        completionMode: 'background',
      }),
    ).resolves.toEqual({ kind: 'not-attached', taskId: 'task-race-loser' })
    expect(fixture.events).toEqual(['attach:task-race-loser:intent-race-loser'])
  })

  test('terminal phase-0 outcome skips the engine and releases exactly once', async () => {
    const fixture = applicationFixture({
      preparation: {
        async run(context) {
          fixture.events.push(`prepare-terminal:${context.taskId}`)
          return { kind: 'terminal-won' }
        },
      },
    })
    await fixture.coordinator.submit({
      taskId: 'task-terminal',
      intentId: 'intent-terminal',
      completionMode: 'await-settle',
    })
    expect(fixture.events).toEqual([
      'attach:task-terminal:intent-terminal',
      'prepare-terminal:task-terminal',
      'release:task-terminal',
    ])
  })

  test('drive failure is reported and release still runs exactly once', async () => {
    const fixture = applicationFixture({
      engine: {
        async drive() {
          throw new Error('engine-boom')
        },
      },
    })
    await expect(
      fixture.coordinator.submit({
        taskId: 'task-failure',
        intentId: 'intent-failure',
        completionMode: 'await-settle',
      }),
    ).rejects.toThrow('engine-boom')
    expect(fixture.events).toEqual([
      'attach:task-failure:intent-failure',
      'prepare:task-failure',
      'error:task-failure:Error: engine-boom',
      'release:task-failure',
    ])
  })
})
