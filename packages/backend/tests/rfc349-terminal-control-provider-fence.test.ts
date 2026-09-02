// RFC-349 — the MR terminal-control worker must live inside the provider
// pause/resume fence, and its fire-and-forget drain must never kill the daemon.
//
// Why this file exists: the hosted external-PostgreSQL evidence run (T10,
// `postgresql-evidence` workflow) crashed the compiled daemon mid-cutover with
//
//   SQLiteError: no such table: agent_workflow.webhook_mr_launch_guards
//       at listRevokingGuardIds -> abortRevoked -> drain -> wake
//
// Two independent defects produced that:
//   1. the SQLite bootstrap registered the worker only as a *close* participant,
//      and the source session is deliberately kept open as the rollback horizon
//      during a cutover — so its interval timer kept ticking after
//      `selectDatabaseSchemaProvider('postgresql')` re-pointed the shared table
//      projection, and every tick then prepared PostgreSQL-qualified SQL on the
//      bun:sqlite client;
//   2. `wake()` assigned the drain promise without a rejection handler, so that
//      failure surfaced as an unhandled rejection and terminated the process
//      instead of being logged.
//
// Anything that makes these green again must keep the worker in
// `providerBackgroundWriterFactories` (pause stops it) and keep `wake`
// non-throwing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { MrLaunchGuardCoordinator } from '@/modules/integration/application/mrLaunchGuard'
import { MrTerminalControlWorker } from '@/modules/integration/application/mrTerminalControlWorker'
import type {
  MrControlEffectClaim,
  MrTerminalEffectPersistencePort,
} from '@/modules/integration/application/ports/mrTerminalControlPersistence'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import type { TaskSourceTerminationParticipant } from '@/modules/task-execution/public/participants'

function guards(abortRevoked: () => number | Promise<number>): MrLaunchGuardCoordinator {
  return {
    supervisor: { abortAll: () => [] },
    abortRevoked,
    hasLaunchBarrier: async () => false,
    reconcileStaleOnBoot: () => {},
  } as unknown as MrLaunchGuardCoordinator
}

function idlePersistence(
  overrides: Partial<MrTerminalEffectPersistencePort> = {},
): MrTerminalEffectPersistencePort {
  return {
    claimNextDue: async () => null,
    finishAttempt: async () => {},
    recordReceipts: async () => {},
    listReleaseOutcomes: async () => [],
    reconcileStaleOnBoot: async () => 0,
    ...overrides,
  } as unknown as MrTerminalEffectPersistencePort
}

const noopParticipant: TaskSourceTerminationParticipant = {
  async apply() {
    return []
  },
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('RFC-349 terminal-control worker inside the provider fence', () => {
  test('a drain failure is contained: wake does not reject and the worker keeps serving', async () => {
    let failNext = true
    let abortCalls = 0
    const worker = new MrTerminalControlWorker(
      idlePersistence(),
      guards(() => {
        abortCalls += 1
        if (failNext) throw new Error('no such table: agent_workflow.webhook_mr_launch_guards')
        return 0
      }),
      noopParticipant,
      mintSourceTerminationEffectCapability,
    )

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    // Bun surfaces an unhandled drain rejection here before it kills the process.
    process.on('unhandledRejection', onRejection)
    try {
      worker.wake()
      await settle()
      expect(abortCalls).toBe(1)

      failNext = false
      worker.wake()
      await settle()
      expect(abortCalls).toBe(2)
      await worker.stop()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections).toEqual([])
  })

  test('stop stays terminal, and only resume re-arms the same instance', async () => {
    const claimed: string[] = []
    let due: MrControlEffectClaim | null = null
    const worker = new MrTerminalControlWorker(
      idlePersistence({
        async claimNextDue() {
          if (due === null) return null
          const effect = due
          due = null
          claimed.push(effect.id)
          return effect
        },
      }),
      guards(() => 0),
      noopParticipant,
      mintSourceTerminationEffectCapability,
    )

    await worker.stop()
    due = {
      id: 'effect-after-stop',
      binding: 'binding-after-stop',
      revision: 1,
      kind: 'fence-closed',
      deliveryId: 'delivery-after-stop',
      attemptCount: 0,
    } as unknown as MrControlEffectClaim
    worker.wake()
    await settle()
    expect(claimed).toEqual([])

    worker.resume()
    worker.wake()
    await settle()
    expect(claimed).toEqual(['effect-after-stop'])
    await worker.stop()
  })

  test('both daemon bootstraps register the worker as a paused provider writer', () => {
    const start = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')

    // SQLite bootstrap: the source session of every cutover.
    expect(start).toContain('webhookTerminalControlRuntimeFactory')
    expect(start).toMatch(
      /const providerBackgroundWriterFactories = Object\.freeze\(\[\s*\n\s*webhookTerminalControlRuntimeFactory,/,
    )

    // PostgreSQL bootstrap: the target session, and the source of any later switch.
    expect(start).toMatch(/backgroundWriterFactories: \[\s*\n\s*webhookTerminalRuntimeFactory,/)
  })
})
