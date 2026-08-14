// RFC-303 — durable protected-launch reservation and the two admission gates.
import { and, eq, inArray, lte } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { webhookMrLaunchGuards, webhookMrStreamStates } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { InMemoryWebhookLaunchSupervisor } from '@/modules/integration/infrastructure/inMemoryWebhookLaunchSupervisor'
import type {
  ProtectedMrLaunchGuard,
  ProtectedMrLaunchGuardInput,
} from '@/modules/integration/public/mrTerminalControl'
import { ConflictError } from '@/util/errors'

const OPEN_GUARD_STATUSES = ['reserved', 'launching'] as const

function safeCode(errorCode: string): string {
  return errorCode.replace(/[^a-z0-9._-]/gi, '-').slice(0, 200)
}

export class MrLaunchGuardCoordinator {
  constructor(
    private readonly db: DbClient,
    readonly supervisor = new InMemoryWebhookLaunchSupervisor(),
  ) {}

  reserve(input: ProtectedMrLaunchGuardInput): ProtectedMrLaunchGuard {
    const guardId = ulid()
    const ownerKey = ulid()
    const controller = new AbortController()
    const now = Date.now()
    dbTxSync(this.db, (tx) => {
      const stream = tx
        .select({
          state: webhookMrStreamStates.state,
          revision: webhookMrStreamStates.revision,
          lastTerminalRevision: webhookMrStreamStates.lastTerminalRevision,
        })
        .from(webhookMrStreamStates)
        .where(
          and(
            eq(webhookMrStreamStates.endpointId, input.endpointId),
            eq(webhookMrStreamStates.streamKey, input.streamKey),
          ),
        )
        .get()
      if (
        stream === undefined ||
        stream.revision < input.launchRevision ||
        stream.state !== 'open' ||
        (stream.lastTerminalRevision !== null && stream.lastTerminalRevision > input.launchRevision)
      ) {
        throw new ConflictError(
          'webhook-mr-launch-terminal',
          'the MR/PR stream became terminal before launch reservation',
        )
      }
      tx.insert(webhookMrLaunchGuards)
        .values({
          id: guardId,
          endpointId: input.endpointId,
          streamKey: input.streamKey,
          binding: input.binding,
          launchRevision: input.launchRevision,
          deliveryId: input.deliveryId,
          fireId: input.fireId,
          triggerId: input.triggerId,
          triggerNameSnapshot: input.triggerName,
          launchOwnerKey: ownerKey,
          status: 'reserved',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    if (!this.supervisor.register(guardId, controller)) {
      throw new Error(`duplicate webhook launch guard owner: ${guardId}`)
    }
    this.db
      .update(webhookMrLaunchGuards)
      .set({ status: 'launching', updatedAt: Date.now() })
      .where(
        and(eq(webhookMrLaunchGuards.id, guardId), eq(webhookMrLaunchGuards.status, 'reserved')),
      )
      .run()

    const assertCanCommit = (): void => {
      const row = this.db
        .select({
          status: webhookMrLaunchGuards.status,
          state: webhookMrStreamStates.state,
          lastTerminalRevision: webhookMrStreamStates.lastTerminalRevision,
        })
        .from(webhookMrLaunchGuards)
        .innerJoin(
          webhookMrStreamStates,
          and(
            eq(webhookMrStreamStates.endpointId, webhookMrLaunchGuards.endpointId),
            eq(webhookMrStreamStates.streamKey, webhookMrLaunchGuards.streamKey),
          ),
        )
        .where(eq(webhookMrLaunchGuards.id, guardId))
        .limit(1)
        .all()[0]
      if (
        controller.signal.aborted ||
        row === undefined ||
        !OPEN_GUARD_STATUSES.includes(row.status as (typeof OPEN_GUARD_STATUSES)[number]) ||
        row.state !== 'open' ||
        (row.lastTerminalRevision !== null && row.lastTerminalRevision > input.launchRevision)
      ) {
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
      taskCommitted: (taskId) => {
        this.db
          .update(webhookMrLaunchGuards)
          .set({ taskId, status: 'task-committed', updatedAt: Date.now() })
          .where(
            and(
              eq(webhookMrLaunchGuards.id, guardId),
              inArray(webhookMrLaunchGuards.status, ['reserved', 'launching', 'revoking-terminal']),
            ),
          )
          .run()
      },
      launchSettled: (taskId) => {
        this.db
          .update(webhookMrLaunchGuards)
          .set({ taskId, status: 'launch-settled', launchOwnerKey: null, updatedAt: Date.now() })
          .where(
            and(
              eq(webhookMrLaunchGuards.id, guardId),
              inArray(webhookMrLaunchGuards.status, [
                'reserved',
                'launching',
                'revoking-terminal',
                'task-committed',
              ]),
            ),
          )
          .run()
      },
      failed: (errorCode) => {
        const current = this.db
          .select({ status: webhookMrLaunchGuards.status })
          .from(webhookMrLaunchGuards)
          .where(eq(webhookMrLaunchGuards.id, guardId))
          .limit(1)
          .all()[0]
        if (current === undefined || current.status === 'launch-settled') return
        this.db
          .update(webhookMrLaunchGuards)
          .set({
            status: current.status === 'revoking-terminal' ? 'aborted-terminal' : 'failed',
            error: safeCode(errorCode),
            launchOwnerKey: null,
            updatedAt: Date.now(),
          })
          .where(eq(webhookMrLaunchGuards.id, guardId))
          .run()
      },
      release: () => {
        this.supervisor.release(guardId, controller)
      },
    }
  }

  abortRevoked(): number {
    const rows = this.db
      .select({ id: webhookMrLaunchGuards.id })
      .from(webhookMrLaunchGuards)
      .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
      .all()
    let aborted = 0
    for (const row of rows) if (this.supervisor.abort(row.id)) aborted++
    return aborted
  }

  /** Boot runs after orphan repair, so no pre-task launch owner from the old process survives. */
  reconcileStaleOnBoot(): void {
    const now = Date.now()
    this.db
      .update(webhookMrLaunchGuards)
      .set({ status: 'aborted-terminal', launchOwnerKey: null, updatedAt: now })
      .where(eq(webhookMrLaunchGuards.status, 'revoking-terminal'))
      .run()
    this.db
      .update(webhookMrLaunchGuards)
      .set({
        status: 'failed',
        error: 'daemon-restart-before-task-commit',
        launchOwnerKey: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(webhookMrLaunchGuards.status, ['reserved', 'launching']),
          lte(webhookMrLaunchGuards.updatedAt, now),
        ),
      )
      .run()
    const committed = this.db
      .select({ id: webhookMrLaunchGuards.id, taskId: webhookMrLaunchGuards.taskId })
      .from(webhookMrLaunchGuards)
      .where(eq(webhookMrLaunchGuards.status, 'task-committed'))
      .all()
    for (const row of committed) {
      this.db
        .update(webhookMrLaunchGuards)
        .set({
          status: row.taskId === null ? 'failed' : 'launch-settled',
          error: row.taskId === null ? 'daemon-restart-task-id-missing' : null,
          launchOwnerKey: null,
          updatedAt: now,
        })
        .where(eq(webhookMrLaunchGuards.id, row.id))
        .run()
    }
  }
}
