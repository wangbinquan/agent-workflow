// RFC-349 — owner maintenance ports remain provider-neutral and preserve the
// recovery/sweep fences that bootstrap previously implemented with SQLite.

import { describe, expect, test } from 'bun:test'

import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import type { WebhookDeliveryPersistencePort } from '@/modules/integration/application/ports/webhookDeliveryPersistence'
import { composeIntentMaintenanceCommands } from '@/modules/intent/composition/maintenance'
import type { IntentMaintenancePersistence } from '@/modules/intent/application/ports/intentPersistence'

describe('RFC-349 Intent and Integration maintenance ports', () => {
  test('intent scratch sweep excludes running and failed removals from persistence cleanup', async () => {
    const marked: Array<{ cutoff: number; excludedTurnIds: readonly string[] }> = []
    const persistence: IntentMaintenancePersistence = {
      async listQueuedWorkingSetSessionIds() {
        return ['queued-session']
      },
      async listTurnIdsForBootRecovery() {
        return ['turn-orphan']
      },
      async listRunningTurnIds(turnIds) {
        expect(turnIds).toEqual(['turn-failed', 'turn-removed', 'turn-running'])
        return new Set(['turn-running'])
      },
      async recoverTurnsOnBoot(input) {
        expect(input).toEqual({
          turnIds: ['turn-orphan'],
          now: 20_000,
          reason: 'intent-run-daemon-restart',
        })
        return 1
      },
      async markScratchSwept(input) {
        marked.push(input)
        return ['turn-removed']
      },
    }
    const removed: string[] = []
    const commands = composeIntentMaintenanceCommands({
      persistence,
      scratch: {
        staleTurnIds(cutoff) {
          expect(cutoff).toBe(10_000)
          return ['turn-failed', 'turn-removed', 'turn-running']
        },
        remove(turnId) {
          if (turnId === 'turn-failed') throw new Error('fixture removal failure')
          removed.push(turnId)
        },
      },
      intentApplies: {
        async converge(input) {
          expect(input.activeJournalIds).toEqual(['intent-active'])
          return { failed: 1, rolledForward: 2 }
        },
      },
      resourcePackages: {
        async converge(input) {
          expect(input.activeApplyIds).toEqual(['bundle-active'])
          return { failed: 3, rolledForward: 4 }
        },
      },
    })

    await expect(commands.scratch.sweep({ retentionHours: 1, now: 3_610_000 })).resolves.toEqual({
      removed: 1,
    })
    expect(removed).toEqual(['turn-removed'])
    expect(marked).toEqual([
      {
        cutoff: 10_000,
        excludedTurnIds: ['turn-running', 'turn-failed'],
      },
    ])
    await expect(commands.recovery.bootTurnIds()).resolves.toEqual(['turn-orphan'])
    await expect(
      commands.recovery.recover({
        recoverTurnIds: ['turn-orphan'],
        activeIntentApplyJournalIds: ['intent-active'],
        activeBundleApplyIds: ['bundle-active'],
        now: 20_000,
      }),
    ).resolves.toEqual({
      failed: 4,
      rolledForward: 6,
      queuedWorkingSets: 1,
      orphanedTurns: 1,
      queuedSessionIds: ['queued-session'],
    })
  })

  test('integration maintenance delegates exact recovery and bounded GC contracts', async () => {
    const persistence: WebhookDeliveryPersistencePort = {
      async insert() {
        throw new Error('not used')
      },
      async mark() {
        throw new Error('not used')
      },
      async recoverInterrupted() {
        return 7
      },
      async gcSlice(input) {
        expect(input).toEqual({
          now: 50_000,
          retention: { bodyRetentionMs: 100, rowRetentionMs: 200 },
          cursor: null,
          batchSize: 25,
        })
        return {
          done: false,
          cursor: { version: 1, phase: 'rows', bodyCutoff: 49_900, rowCutoff: 49_800 },
          counters: { bodiesCleared: 4, rowsDeleted: 3 },
        }
      },
      async touchEndpointLastDelivery() {
        throw new Error('not used')
      },
    }
    const commands = composeIntegrationMaintenanceCommands(persistence)

    await expect(commands.recoverInterruptedWebhookDeliveries()).resolves.toEqual({ recovered: 7 })
    await expect(
      commands.gcWebhookDeliveries({
        now: 50_000,
        retention: { bodyRetentionMs: 100, rowRetentionMs: 200 },
        cursor: null,
        batchSize: 25,
      }),
    ).resolves.toEqual({
      done: false,
      cursor: { version: 1, phase: 'rows', bodyCutoff: 49_900, rowCutoff: 49_800 },
      counters: { bodiesCleared: 4, rowsDeleted: 3 },
    })
  })
})
