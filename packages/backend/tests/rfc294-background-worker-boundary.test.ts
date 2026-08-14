// RFC-294 W9-B/W4-E7 compatibility locks.
//
// These are daemon-lifetime user journeys rather than timer implementation
// tests: a durable webhook effect survives process replacement, a stopped
// worker cannot be revived by a late wakeup, and a schedule slot claimed just
// before a crash is not launched twice by the next daemon.  The final block
// protects the narrow task participant consumed by the integration worker.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StartTask } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createInMemoryDb, type DbClient } from '@/db/client'
import { scheduledTasks, webhookMrControlEffects } from '@/db/schema'
import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'
import { pollAndClaim, runDueSchedulesOnce } from '@/services/scheduledTaskScheduler'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { createUser } from '@/services/users'
import { createWorkflow } from '@/services/workflow'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function guards(): MrLaunchGuardCoordinator {
  return {
    supervisor: { abortAll: () => [] },
    abortRevoked: () => 0,
    reconcileStaleOnBoot: () => {},
  } as unknown as MrLaunchGuardCoordinator
}

async function seedEffect(db: DbClient, id: string): Promise<void> {
  const now = Date.now()
  await db.insert(webhookMrControlEffects).values({
    id,
    deliveryId: `delivery-${id}`,
    endpointId: 'endpoint-rfc294',
    streamKey: `gitlab:294:${id}`,
    binding: `binding-${id}`,
    revision: 2,
    observedEventType: 'mr_closed',
    kind: 'fence-closed',
    status: 'pending',
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  })
}

function effectRow(db: DbClient, id: string) {
  return db.select().from(webhookMrControlEffects).where(eq(webhookMrControlEffects.id, id)).get()
}

describe('RFC-294 managed background compatibility', () => {
  test('a retryable webhook control effect is reclaimed and completed by the next daemon worker', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const effectId = 'effect-restart'
    await seedEffect(db, effectId)

    let firstDaemonCalls = 0
    const first = new MrTerminalControlWorker(
      db,
      guards(),
      {
        async apply() {
          firstDaemonCalls += 1
          throw new Error('transient provider failure')
        },
      },
      mintSourceTerminationEffectCapability,
    )
    await first.reconcileOnBoot()
    await first.stop()

    expect(firstDaemonCalls).toBe(1)
    expect(effectRow(db, effectId)).toMatchObject({ status: 'retryable', attemptCount: 1 })

    // No wall-clock sleep: advancing the durable due field models the next
    // daemon starting after the retry deadline.
    await db
      .update(webhookMrControlEffects)
      .set({ nextAttemptAt: Date.now() - 1 })
      .where(eq(webhookMrControlEffects.id, effectId))

    let secondDaemonCalls = 0
    const second = new MrTerminalControlWorker(
      db,
      guards(),
      {
        async apply() {
          secondDaemonCalls += 1
          return []
        },
      },
      mintSourceTerminationEffectCapability,
    )
    await second.reconcileOnBoot()
    await second.stop()

    // The worker intentionally performs a fixed-point sweep after its launch
    // guard barrier.  Both calls belong to the same durable attempt.
    expect(secondDaemonCalls).toBe(2)
    expect(effectRow(db, effectId)).toMatchObject({ status: 'succeeded', attemptCount: 2 })
    db.$client.close()
  })

  test('stop is terminal for the instance: a late wake cannot claim pending work', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const effectId = 'effect-after-stop'
    await seedEffect(db, effectId)
    let calls = 0
    const participant: TaskSourceTerminationParticipant = {
      async apply() {
        calls += 1
        return []
      },
    }
    const worker = new MrTerminalControlWorker(
      db,
      guards(),
      participant,
      mintSourceTerminationEffectCapability,
    )

    await worker.stop()
    worker.wake(effectId)
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toBe(0)
    expect(effectRow(db, effectId)).toMatchObject({ status: 'pending', attemptCount: 0 })
    db.$client.close()
  })

  test('daemon restart after a schedule claim does not duplicate the already-advanced slot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await createUser(db, {
      username: `rfc294-schedule-${ulid().toLowerCase()}`,
      displayName: 'RFC-294 Schedule Owner',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const workflow = await createWorkflow(
      db,
      {
        name: 'rfc294-scheduled-workflow',
        description: '',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      },
      {
        ownerUserId: owner.id,
        actor: buildActor({ user: owner, source: 'session' }),
      },
    )
    const now = Date.now()
    await db.insert(scheduledTasks).values({
      id: 'schedule-restart',
      name: 'schedule-restart',
      ownerUserId: owner.id,
      launchPayload: JSON.stringify({
        workflowId: workflow.id,
        name: 'scheduled run',
        repoUrl: 'https://git.invalid/repository.git',
        ref: 'main',
        inputs: {},
      }),
      scheduleSpec: JSON.stringify({ kind: 'daily', at: '09:00', timezone: 'UTC' }),
      enabled: true,
      nextRunAt: now - 1_000,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    })

    // Daemon A crashes after the durable claim and before invoking launch.
    const claimedByA = await pollAndClaim(db, now, 1)
    expect(claimedByA.map((row) => row.id)).toEqual(['schedule-restart'])

    const launches: StartTask[] = []
    const buildLaunch: BuildScheduleLaunch = () => async (_kind, payload) => {
      launches.push(payload as unknown as StartTask)
      return { id: 'must-not-launch' }
    }
    // Daemon B re-runs the due scan at the same logical time.  The prior slot
    // was at-most-once claimed, so it must not be fired twice.
    const claimedByB = await runDueSchedulesOnce(db, { now, buildLaunch })
    expect(claimedByB).toEqual([])
    expect(launches).toEqual([])
    db.$client.close()
  })
})

describe('RFC-294 cross-context participant information budget', () => {
  test('integration sees only the exact task termination capability/input/receipt surface', () => {
    const file = resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'task-execution',
      'public',
      'participants.ts',
    )
    const source = readFileSync(file, 'utf8')
    const input = source.match(
      /export type TaskSourceTerminationEffectInput = Readonly<\{[\s\S]*?\n\}>/,
    )?.[0]
    const receipt = source.match(
      /export type TaskSourceTerminationReceipt = Readonly<\{[\s\S]*?\n\}>/,
    )?.[0]
    const participant = source.match(
      /export interface TaskSourceTerminationParticipant \{[\s\S]*?\n\}/,
    )?.[0]

    expect(input).toBeDefined()
    expect(receipt).toBeDefined()
    expect(participant).toBeDefined()
    expect(input).not.toMatch(/\btaskId\b/)

    const publicSurface = [input, receipt, participant].join('\n')
    for (const forbidden of [
      'DbClient',
      'nodeRuns',
      'workerId',
      'ownerId',
      'epoch',
      'leaseUntil',
      'AbortSignal',
      'AbortController',
      'TaskDriverStopTicket',
      'ActiveTaskHandle',
      'worktreePath',
      'repoPath',
    ]) {
      expect(publicSurface).not.toContain(forbidden)
    }
    expect(source).not.toMatch(
      /from ['"]@\/(?:db|services|modules\/task-execution\/(?:application|engine|infrastructure|ports))\b/,
    )
  })
})
