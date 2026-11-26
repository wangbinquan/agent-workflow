// Module contract audit: exercise owner composition for recovery and resumable
// retention. Cutoffs remain fixed across slices even when the worker clock advances.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { composeWebhookDeliveryPersistenceFor } from '@/modules/integration/composition/webhookDelivery'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import { createIntegrationMaintenanceJobHandlers } from '@/modules/integration/composition'
import type { WebhookDeliveryGcCursorV1 } from '@/modules/integration/application/ports/webhookDeliveryPersistence'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

describeEachProvider('module contract: integration delivery lifecycle', (harness) => {
  test('a resumed retention cursor keeps its original cutoffs and each slice respects its row budget', async () => {
    const deliveries = composeWebhookDeliveryPersistenceFor(harness.db)
    const commands = composeIntegrationMaintenanceCommands(deliveries)
    const { webhookDeliveries } = tablesOf(harness.db)
    const fixtures = [
      { key: 'old', at: NOW - 30 * DAY, status: 'ignored' as const },
      { key: 'boundary', at: NOW - 10 * DAY, status: 'ignored' as const },
      { key: 'in-flight', at: NOW - 30 * DAY, status: 'processing' as const },
    ]
    const ids = new Map<string, string>()
    for (const fixture of fixtures) {
      const receipt = await deliveries.insert({
        endpointId: 'module-contract-endpoint',
        eventUuid: fixture.key,
        status: fixture.status,
        bodyJson: JSON.stringify({ key: fixture.key }),
      })
      expect(receipt.kind).toBe('inserted')
      ids.set(fixture.key, receipt.deliveryId)
      await harness.db
        .update(webhookDeliveries)
        .set({ receivedAt: fixture.at })
        .where(eq(webhookDeliveries.id, receipt.deliveryId))
    }
    const retention = { bodyRetentionMs: 10 * DAY, rowRetentionMs: 20 * DAY }
    let cursor: WebhookDeliveryGcCursorV1 | null = null
    let bodiesCleared = 0
    let rowsDeleted = 0
    let done = false
    let slices = 0
    while (!done && slices < 8) {
      const result = await commands.gcWebhookDeliveries({
        now: slices === 0 ? NOW : NOW + 100 * DAY,
        retention,
        cursor,
        batchSize: 1,
      })
      expect(result.cursor).toMatchObject({ bodyCutoff: NOW - 10 * DAY, rowCutoff: NOW - 20 * DAY })
      expect(result.counters.bodiesCleared + result.counters.rowsDeleted).toBeLessThanOrEqual(1)
      bodiesCleared += result.counters.bodiesCleared
      rowsDeleted += result.counters.rowsDeleted
      cursor = result.cursor
      done = result.done
      slices += 1
    }
    expect({ done, bodiesCleared, rowsDeleted, slices }).toEqual({
      done: true,
      bodiesCleared: 1,
      rowsDeleted: 1,
      slices: 4,
    })
    const remaining = await harness.db.select().from(webhookDeliveries)
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [ids.get('boundary')!, ids.get('in-flight')!].sort(),
    )
    expect(remaining.every((row) => row.bodyJson !== null)).toBe(true)
  })

  test('recovery settles interrupted deliveries once and leaves completed deliveries unchanged', async () => {
    const deliveries = composeWebhookDeliveryPersistenceFor(harness.db)
    const commands = composeIntegrationMaintenanceCommands(deliveries)
    for (const status of ['received', 'processing', 'matched', 'ignored', 'failed'] as const) {
      await deliveries.insert({ endpointId: 'module-contract-endpoint', eventUuid: status, status })
    }
    expect(await commands.recoverInterruptedWebhookDeliveries()).toEqual({ recovered: 2 })
    expect(await commands.recoverInterruptedWebhookDeliveries()).toEqual({ recovered: 0 })
    const { webhookDeliveries } = tablesOf(harness.db)
    const rows = new Map(
      (await harness.db.select().from(webhookDeliveries)).map((row) => [row.eventUuid, row]),
    )
    for (const status of ['received', 'processing'])
      expect(rows.get(status)).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    for (const status of ['matched', 'ignored', 'failed'])
      expect(rows.get(status)).toMatchObject({ status, statusReason: null })
  })

  test('invalid batch sizes reject before modifying any stored body and a valid retry still works', async () => {
    const deliveries = composeWebhookDeliveryPersistenceFor(harness.db)
    const commands = composeIntegrationMaintenanceCommands(deliveries)
    const receipt = await deliveries.insert({
      endpointId: 'module-contract-endpoint',
      eventUuid: null,
      status: 'ignored',
      bodyJson: '{"keep":true}',
    })
    const { webhookDeliveries } = tablesOf(harness.db)
    await harness.db
      .update(webhookDeliveries)
      .set({ receivedAt: NOW - 30 * DAY })
      .where(eq(webhookDeliveries.id, receipt.deliveryId))
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      await expect(
        commands.gcWebhookDeliveries({
          now: NOW,
          retention: { bodyRetentionMs: DAY, rowRetentionMs: 20 * DAY },
          cursor: null,
          batchSize,
        }),
      ).rejects.toThrow('maintenance-webhook-delivery-batch-invalid')
    }
    expect((await harness.db.select().from(webhookDeliveries))[0]?.bodyJson).toBe('{"keep":true}')
    expect(
      (
        await commands.gcWebhookDeliveries({
          now: NOW,
          retention: { bodyRetentionMs: DAY, rowRetentionMs: 20 * DAY },
          cursor: null,
          batchSize: 1,
        })
      ).counters,
    ).toEqual({ bodiesCleared: 1, rowsDeleted: 0 })
  })
})

describe('module contract: integration maintenance worker entry', () => {
  test('invalid cursors do not call storage and a storage failure is not reported as completed work', async () => {
    let calls = 0
    const failure = new Error('webhook-maintenance-unavailable')
    const handlers = createIntegrationMaintenanceJobHandlers({
      async recoverInterruptedWebhookDeliveries() {
        return { recovered: 0 }
      },
      async gcWebhookDeliveries() {
        calls += 1
        throw failure
      },
    })
    const base = { appHome: '/unused', payload: { bodyRetentionDays: 7, rowRetentionDays: 30 } }
    await expect(
      handlers.webhookDeliveryGc({
        ...base,
        cursor: { version: 1, phase: 'bodies', bodyCutoff: 1.5, rowCutoff: 0 },
      }),
    ).rejects.toThrow('maintenance-webhook-delivery-cursor-invalid')
    expect(calls).toBe(0)
    await expect(handlers.webhookDeliveryGc(base)).rejects.toBe(failure)
    expect(calls).toBe(1)
  })
})
