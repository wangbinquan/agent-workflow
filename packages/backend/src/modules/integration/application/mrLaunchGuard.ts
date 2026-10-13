// RFC-303 / RFC-349 — durable protected-launch reservation. Persistence is a
// consumer-owned Promise port; provider transactions stay in infrastructure.
import { ulid } from 'ulid'

import type {
  MrLaunchGuardPersistencePort,
  MrLaunchSupervisorPort,
} from './ports/mrTerminalControlPersistence'
import type {
  ProtectedMrLaunchGuard,
  ProtectedMrLaunchGuardInput,
} from '@/modules/integration/public/mrTerminalControl'
import { ConflictError } from '@/util/errors'
import {
  MrTerminalExecutionUnavailable,
  type MrLaunchExecutionPort,
} from './mrTerminalControlExecution'

export class MrLaunchGuardCoordinator {
  constructor(
    private readonly persistence: MrLaunchGuardPersistencePort,
    readonly supervisor: MrLaunchSupervisorPort,
    private readonly canDispatch: () => boolean = () => true,
    private readonly execution?: MrLaunchExecutionPort,
  ) {}

  async reserve(input: ProtectedMrLaunchGuardInput): Promise<ProtectedMrLaunchGuard> {
    if (this.execution !== undefined) return this.reserveExecution(input, this.execution)
    const guardId = ulid()
    const ownerKey = ulid()
    const controller = new AbortController()
    const now = Date.now()
    await this.persistence.reserve({ ...input, guardId, ownerKey, createdAt: now })
    if (!this.supervisor.register(guardId, controller)) {
      throw new Error(`duplicate webhook launch guard owner: ${guardId}`)
    }
    await this.persistence.markLaunching(guardId, Date.now())

    const assertCanCommit = (): void => {
      if (controller.signal.aborted) {
        throw new ConflictError(
          'webhook-mr-launch-terminal',
          'the MR/PR stream became terminal while launch was being prepared',
        )
      }
    }

    return {
      id: guardId,
      signal: controller.signal,
      snapshot: {
        binding: input.binding,
        launchRevision: input.launchRevision,
        fence: null,
        effectRevision: null,
      },
      assertCanCommit,
      verifyCanCommit: async () => {
        assertCanCommit()
        if (
          !(await this.persistence.assertCanCommit({
            guardId,
            launchRevision: input.launchRevision,
          }))
        ) {
          throw new ConflictError(
            'webhook-mr-launch-terminal',
            'the MR/PR stream became terminal while launch was being prepared',
          )
        }
      },
      taskCommitted: async (taskId) =>
        await this.persistence.markTaskCommitted(guardId, taskId, Date.now()),
      launchSettled: async (taskId) =>
        await this.persistence.markLaunchSettled(guardId, taskId, Date.now()),
      failed: async (errorCode) =>
        await this.persistence.markFailed(guardId, errorCode, Date.now()),
      release: () => {
        this.supervisor.release(guardId, controller)
      },
    }
  }

  private async reserveExecution(
    input: ProtectedMrLaunchGuardInput,
    execution: MrLaunchExecutionPort,
  ): Promise<ProtectedMrLaunchGuard> {
    const admission = execution.admit()
    const guardId = ulid(),
      ownerKey = ulid(),
      controller = new AbortController()
    const assertCurrent = () => {
      if (!admission.current()) throw new MrTerminalExecutionUnavailable()
      if (controller.signal.aborted)
        throw new ConflictError(
          'webhook-mr-launch-terminal',
          'the MR/PR stream became terminal while launch was being prepared',
        )
    }
    let registered = false
    try {
      await admission.run(async () => {
        assertCurrent()
        await this.persistence.reserve({ ...input, guardId, ownerKey, createdAt: Date.now() })
        assertCurrent()
        registered = this.supervisor.register(guardId, controller)
        if (!registered) throw new Error(`duplicate webhook launch guard owner: ${guardId}`)
        await this.persistence.markLaunching(guardId, Date.now())
        assertCurrent()
      })
    } catch (error) {
      try {
        await admission.settle(() =>
          this.persistence.markFailed(guardId, 'webhook-mr-launch-not-issued', Date.now()),
        )
      } finally {
        if (registered) this.supervisor.release(guardId, controller)
        admission.release()
      }
      throw error
    }
    return {
      id: guardId,
      signal: controller.signal,
      snapshot: {
        binding: input.binding,
        launchRevision: input.launchRevision,
        fence: null,
        effectRevision: null,
      },
      assertCanCommit: assertCurrent,
      verifyCanCommit: () =>
        admission.run(async () => {
          assertCurrent()
          const allowed = await this.persistence.assertCanCommit({
            guardId,
            launchRevision: input.launchRevision,
          })
          assertCurrent()
          if (!allowed)
            throw new ConflictError(
              'webhook-mr-launch-terminal',
              'the MR/PR stream became terminal while launch was being prepared',
            )
        }),
      taskCommitted: (taskId) =>
        admission.settle(() => this.persistence.markTaskCommitted(guardId, taskId, Date.now())),
      launchSettled: (taskId) =>
        admission.settle(() => this.persistence.markLaunchSettled(guardId, taskId, Date.now())),
      failed: (errorCode) =>
        admission.settle(() => this.persistence.markFailed(guardId, errorCode, Date.now())),
      release: () => {
        this.supervisor.release(guardId, controller)
        admission.release()
      },
    }
  }

  async abortRevoked(canDispatch: () => boolean = this.canDispatch): Promise<number> {
    const guardIds = await this.persistence.listRevokingGuardIds()
    let aborted = 0
    for (const guardId of guardIds) {
      if (!canDispatch()) break
      if (this.supervisor.abort(guardId)) aborted++
    }
    return aborted
  }

  async hasLaunchBarrier(binding: string, revision: number): Promise<boolean> {
    return await this.persistence.hasLaunchBarrier(binding, revision)
  }

  /** Boot runs after orphan repair, so no pre-task launch owner from the old process survives. */
  async reconcileStaleOnBoot(): Promise<void> {
    await this.persistence.reconcileStaleOnBoot(Date.now())
  }
}
