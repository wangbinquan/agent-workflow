import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { hostExecutionWriteContexts, workflows } from '@/db/schema'
import {
  type HostExecutionWriteContext,
  type HostExecutionWriteContextParticipant,
  type HostExecutionWriteReceipt,
} from '@/modules/system-operations/public/participants'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/infrastructure/hostExecutionWriteContext'
import {
  withTaskExecutionSerializable,
  withTaskExecutionWrite,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import type { TaskHostWriteReceipt } from '@/modules/task-execution/application/ports/taskHostWriteContext'
import type { ProviderNeutralDatabase } from '@/db/query'
import { describeEachProvider } from './helpers/eachProvider'

function grant(generation = 'host-generation') {
  return Object.freeze({ generation, reference: Object.freeze({}), current: () => true })
}

async function prepared(db: ProviderNeutralDatabase, generation = 'host-generation') {
  const selected = composeHostExecutionWriteContext(db)
  const context = grant(generation)
  const receipt = await selected.context.prepare({
    context,
    holder: 'host-holder',
    expiresAt: Date.now() + 60_000,
  })
  const adapter = createTaskHostWriteContextAdapter(selected)
  return { selected, context, receipt, adapter, captured: adapter.port.capture(context) }
}

async function writeWorkflow(db: ProviderNeutralDatabase, id: string) {
  await db.insert(workflows).values({
    id,
    name: id,
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
}

describeEachProvider(
  'RFC-370 Task independent host write participant in original transactions',
  (harness) => {
    test('preparing permits recovery; new work rolls back the complete original SQL body', async () => {
      const h = await prepared(harness.db)
      await withTaskExecutionWrite(harness.db, async (tx) => {
        await writeWorkflow(tx, 'prepared-recovery')
        await h.adapter.port.consumeRecovery(h.adapter.transactionFor(tx), h.captured)
      })
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'blocked-new-work')
          await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'blocked-new-work')),
      ).toEqual([])
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'prepared-recovery')),
      ).toEqual([{ id: 'prepared-recovery' }])
    })

    test('active original transaction commits; renew preserves the captured receipt and revision', async () => {
      const h = await prepared(harness.db)
      expect(Object.isFrozen(h.receipt)).toBe(true)
      expect(Object.isFrozen(h.captured)).toBe(true)
      expect(h.adapter.port.capture(h.context)).toBe(h.captured)
      await h.selected.context.activate(h.receipt)
      const before = (await harness.db.select().from(hostExecutionWriteContexts))[0]!
      await h.selected.context.renew(h.receipt, before.expiresAt + 60_000)
      await withTaskExecutionSerializable(harness.db, async (tx) => {
        await writeWorkflow(tx, 'active-work')
        await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
      })
      const after = (await harness.db.select().from(hostExecutionWriteContexts))[0]!
      expect(after.revision).toBe(before.revision)
      expect(after.expiresAt).toBe(before.expiresAt + 60_000)
      expect(h.adapter.port.capture(h.context)).toBe(h.captured)
    })

    test('loss closes new work while an expired draining grant still receives issued ACK SQL', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      await h.selected.context.drain(h.receipt)
      await harness.db.update(hostExecutionWriteContexts).set({ expiresAt: 0 })
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'lost-new-work')
          await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      await withTaskExecutionWrite(harness.db, async (tx) => {
        await writeWorkflow(tx, 'issued-ack')
        await h.adapter.port.consumeIssuedAck(h.adapter.transactionFor(tx), h.captured)
      })
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'lost-new-work')),
      ).toEqual([])
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'issued-ack')),
      ).toEqual([{ id: 'issued-ack' }])
      await expect(h.selected.context.renew(h.receipt, Date.now() + 60_000)).rejects.toThrow(
        'host-execution-write-context-unavailable',
      )
    })

    test('expired active receipt rolls back; an earlier original business error retains object identity', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      await harness.db.update(hostExecutionWriteContexts).set({ expiresAt: 0 })
      const originalError = new Error('original-task-business-conflict')
      let consumed = false
      await expect(
        withTaskExecutionSerializable(harness.db, async (tx) => {
          await writeWorkflow(tx, 'business-conflict-write')
          const originalBody = async (): Promise<void> => {
            throw originalError
          }
          await originalBody()
          consumed = true
          await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toBe(originalError)
      expect(consumed).toBe(false)
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'expired-write')
          await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'expired-write')),
      ).toEqual([])
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'business-conflict-write')),
      ).toEqual([])
      await expect(h.selected.context.renew(h.receipt, Date.now() + 60_000)).rejects.toThrow(
        'host-execution-write-context-unavailable',
      )
    })

    test('retired receipt never becomes a new grant even with the same holder and generation', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      await h.selected.context.drain(h.receipt)
      await h.selected.context.retire(h.receipt)
      const nextContext = grant(h.context.generation)
      const nextReceipt = await h.selected.context.prepare({
        context: nextContext,
        holder: 'host-holder',
        expiresAt: Date.now() + 60_000,
      })
      await h.selected.context.activate(nextReceipt)
      const nextCaptured = h.adapter.port.capture(nextContext)
      expect(nextCaptured).not.toBe(h.captured)
      expect((await harness.db.select().from(hostExecutionWriteContexts))[0]?.revision).toBe(2)
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'old-grant-write')
          await h.adapter.port.consumeIssuedAck(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      await withTaskExecutionWrite(harness.db, async (tx) => {
        await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), nextCaptured)
      })
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'old-grant-write')),
      ).toEqual([])
    })

    test('matching strings in another actual database do not substitute the original transaction', async () => {
      const h = await prepared(harness.db)
      const second = harness.database(1)
      const other = await prepared(second.db)
      await h.selected.context.activate(h.receipt)
      await other.selected.context.activate(other.receipt)
      await expect(
        withTaskExecutionWrite(second.db, async (tx) => {
          await writeWorkflow(tx, 'other-database-write')
          await h.adapter.port.consumeNewWork(h.adapter.transactionFor(tx), h.captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(
        await second.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'other-database-write')),
      ).toEqual([])
      await expect(h.selected.participant.consumeNewWork(harness.db, h.receipt)).rejects.toThrow(
        'host-execution-write-context-unavailable',
      )
    })

    test('nested original transaction reuses the original handle and keeps rollback semantics', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const failure = new Error('outer-original-transaction-failed')
      await expect(
        withTaskExecutionWrite(harness.db, async (outer) => {
          await withTaskExecutionSerializable(harness.db, async (inner) => {
            expect(inner).toBe(outer)
            expect(h.adapter.transactionFor(inner)).toBe(h.adapter.transactionFor(outer))
            await writeWorkflow(inner, 'nested-host-write')
            await h.adapter.port.consumeNewWork(h.adapter.transactionFor(inner), h.captured)
          })
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'nested-host-write')),
      ).toEqual([])
    })

    test('lifecycle control cannot report durable preparation before an outer Task COMMIT', async () => {
      const selected = composeHostExecutionWriteContext(harness.db)
      const context = grant()
      await withTaskExecutionWrite(harness.db, async () => {
        await expect(
          selected.context.prepare({
            context,
            holder: 'nested-control',
            expiresAt: Date.now() + 60_000,
          }),
        ).rejects.toThrow('host-execution-write-context-control-inside-transaction')
      })
      expect(await harness.db.select().from(hostExecutionWriteContexts)).toEqual([])
      expect(selected.context.forGrant(context)).toBeUndefined()
    })

    test('a different binding and a reconstructed receipt cannot replace original identities', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const another = composeHostExecutionWriteContext(harness.db)
      expect(another.context.forGrant(h.context)).toBeUndefined()
      expect(
        h.selected.context.forGrant({ ...h.context, reference: Object.freeze({}) }),
      ).toBeUndefined()
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await another.participant.consumeNewWork(tx, h.receipt)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await h.adapter.port.consumeNewWork(
            h.adapter.transactionFor(tx),
            Object.freeze({}) as TaskHostWriteReceipt,
          )
        }),
      ).rejects.toThrow('task-host-write-context-unavailable')
    })

    test('Task adapter retains the selected original methods, receiver and error object', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const failure = new Error('original-selected-participant-failed')
      let calls = 0
      const mutableContext: HostExecutionWriteContext = { ...h.selected.context }
      const mutableParticipant: HostExecutionWriteContextParticipant = {
        ...h.selected.participant,
        async consumeNewWork(tx, receipt) {
          expect(this).toBe(mutableParticipant)
          expect(receipt).toBe(h.receipt)
          calls += 1
          await h.selected.participant.consumeNewWork(tx, receipt)
          throw failure
        },
      }
      const originalForGrant = mutableContext.forGrant
      mutableContext.forGrant = function (input) {
        expect(this).toBe(mutableContext)
        return originalForGrant.call(h.selected.context, input)
      }
      const adapter = createTaskHostWriteContextAdapter({
        context: mutableContext,
        participant: mutableParticipant,
      })
      mutableContext.forGrant = () => undefined
      mutableParticipant.consumeNewWork = async () => {
        throw new Error('replacement must not run')
      }
      const captured = adapter.port.capture(h.context)
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'original-method-write')
          await adapter.port.consumeNewWork(adapter.transactionFor(tx), captured)
        }),
      ).rejects.toBe(failure)
      expect(calls).toBe(1)
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'original-method-write')),
      ).toEqual([])
      await expect(
        h.selected.context.activate(Object.freeze({}) as HostExecutionWriteReceipt),
      ).rejects.toThrow('host-execution-write-context-unavailable')
    })

    // Locks in SOURCE18-R1 F01: loss precedes the durable drain ACK, so an
    // unexpired installation row cannot extend the original grant's currentness.
    test('preparing receipt retains the original current method and receiver after loss', async () => {
      const selected = composeHostExecutionWriteContext(harness.db)
      let current = true
      let replacementCalls = 0
      const context = {
        generation: 'preparing-original-grant',
        reference: Object.freeze({}),
        current() {
          expect(this).toBe(context)
          return current
        },
      }
      const receipt = await selected.context.prepare({
        context,
        holder: 'preparing-original-holder',
        expiresAt: Date.now() + 60_000,
      })
      const adapter = createTaskHostWriteContextAdapter(selected)
      const captured = adapter.port.capture(context)
      context.current = () => {
        replacementCalls += 1
        return true
      }
      current = false
      await expect(selected.context.activate(receipt)).rejects.toThrow(
        'host-execution-write-context-unavailable',
      )
      await expect(
        withTaskExecutionWrite(harness.db, async (tx) => {
          await writeWorkflow(tx, 'lost-preparing-recovery')
          await adapter.port.consumeRecovery(adapter.transactionFor(tx), captured)
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'lost-preparing-recovery')),
      ).toEqual([])
      const row = (await harness.db.select().from(hostExecutionWriteContexts))[0]!
      expect(row.phase).toBe('preparing')
      expect(row.expiresAt).toBeGreaterThan(Date.now())
      expect(replacementCalls).toBe(0)
      await selected.context.drain(receipt)
      await selected.context.retire(receipt)
    })

    test('loss during an original SQL await rolls back active new work while issued ACK still commits', async () => {
      const selected = composeHostExecutionWriteContext(harness.db)
      let current = true
      const context = {
        generation: 'active-original-grant',
        reference: Object.freeze({}),
        current() {
          expect(this).toBe(context)
          return current
        },
      }
      const receipt = await selected.context.prepare({
        context,
        holder: 'active-original-holder',
        expiresAt: Date.now() + 60_000,
      })
      await selected.context.activate(receipt)
      const adapter = createTaskHostWriteContextAdapter(selected)
      const captured = adapter.port.capture(context)
      await expect(
        withTaskExecutionSerializable(harness.db, async (tx) => {
          await writeWorkflow(tx, 'lost-active-original-work')
          const consuming = adapter.port.consumeNewWork(adapter.transactionFor(tx), captured)
          queueMicrotask(() => {
            current = false
          })
          await consuming
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      const before = (await harness.db.select().from(hostExecutionWriteContexts))[0]!
      expect(before.phase).toBe('active')
      expect(before.expiresAt).toBeGreaterThan(Date.now())
      await expect(selected.context.renew(receipt, before.expiresAt + 60_000)).rejects.toThrow(
        'host-execution-write-context-unavailable',
      )
      expect((await harness.db.select().from(hostExecutionWriteContexts))[0]?.expiresAt).toBe(
        before.expiresAt,
      )
      await withTaskExecutionWrite(harness.db, async (tx) => {
        await writeWorkflow(tx, 'lost-active-issued-ack')
        await adapter.port.consumeIssuedAck(adapter.transactionFor(tx), captured)
      })
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'lost-active-original-work')),
      ).toEqual([])
      expect(
        await harness.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, 'lost-active-issued-ack')),
      ).toEqual([{ id: 'lost-active-issued-ack' }])
      await selected.context.drain(receipt)
      await selected.context.retire(receipt)
    })
  },
  { databaseCount: 2 },
)
