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

export class MrLaunchGuardCoordinator {
  constructor(
    private readonly persistence: MrLaunchGuardPersistencePort,
    readonly supervisor: MrLaunchSupervisorPort,
  ) {}

  async reserve(input: ProtectedMrLaunchGuardInput): Promise<ProtectedMrLaunchGuard> {
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

  async abortRevoked(): Promise<number> {
    const guardIds = await this.persistence.listRevokingGuardIds()
    let aborted = 0
    for (const guardId of guardIds) if (this.supervisor.abort(guardId)) aborted++
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
