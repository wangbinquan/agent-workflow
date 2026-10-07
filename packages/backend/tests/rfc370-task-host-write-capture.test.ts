// RFC-370 C1: original Task receipt/context propagation and named write helpers.
// Both real providers retain business SQL/owner conditions, rollback and ACK.
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { workflows, tasks, taskExecutionOwners, hostExecutionWriteContexts } from '@/db/schema'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/infrastructure/hostExecutionWriteContext'
import {
  withTaskHostNewWork,
  withTaskHostRecovery,
  withTaskHostIssuedAck,
  type TaskHostWriteSelection,
  type TaskHostWriteBinding,
} from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import {
  withTaskExecutionWrite,
  fenceTaskWrite,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { captureTaskHostWriteContext } from '@/modules/task-execution/application/taskHostWriteCapture'
import type { TaskHostWriteContext } from '@/modules/task-execution/application/ports/taskHostWriteContext'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
  currentTaskExecutionContext,
  taskExecutionHostWriteCapture,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import { canonicalJson, type LineageSlot } from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider } from './helpers/eachProvider'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function prepared(db: ProviderNeutralDatabase) {
  let current = true
  const selected = composeHostExecutionWriteContext(db)
  const grant = Object.freeze({
    generation: 'task-capture-generation',
    reference: Object.freeze({}),
    current: () => current,
  })
  const receipt = await selected.context.prepare({
    context: grant,
    holder: 'task-capture-holder',
    expiresAt: Date.now() + 60_000,
  })
  const binding = createTaskHostWriteContextAdapter(selected)
  const capture = captureTaskHostWriteContext(binding.port, grant)
  const selection = { kind: 'selected', capture, binding } as const
  return {
    selected,
    grant,
    receipt,
    binding,
    capture,
    selection,
    lose: () => {
      current = false
    },
  }
}
async function writeWorkflow(db: ProviderNeutralDatabase, id: string) {
  await db
    .insert(workflows)
    .values({ id, name: id, description: '', definition: '{}', version: 1, schemaVersion: 4 })
}
async function workflowIds(db: ProviderNeutralDatabase, id: string) {
  return db.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, id))
}
async function claimedTask(db: ProviderNeutralDatabase, taskId: string) {
  const workflowId = `workflow-${taskId}`
  await writeWorkflow(db, workflowId)
  const slotPath: readonly LineageSlot[] = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(slotPath),
  })
  const intent = await new DrizzleTaskExecutionIntentPersistence(db).submit({
    intentId: `intent-${taskId}`,
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'actor-1',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: `${taskId}:root`,
        slotPath,
        operationGeneration: 0,
      },
      payload: { v: 1 },
    },
  })
  const module = createTaskExecutionTestModule(`daemon-${taskId}`)
  const claim = await module.claim({ db, intentId: intent.intentId })
  module.claimGate.leave(claim.permit)
  return {
    token: claim.token,
    intentId: intent.intentId,
    persistence: createTaskExecutionPersistence(db),
  }
}

describeEachProvider(
  'RFC-370 Task original capture and named transaction helpers',
  (harness) => {
    test('private capture preserves the original context shape, compatibility, freeze and ALS across await', async () => {
      const h = await prepared(harness.db)
      const original = await claimedTask(harness.db, 'capture-context-task')
      const input = {
        ...original,
        legacyConnection: harness.db,
        compatibility: { db: harness.db, legacyMarker: 'unchanged' },
      }
      const native = createTaskExecutionContext(input)
      const selected = createTaskExecutionContext({ ...input, hostWriteCapture: h.capture })
      expect(Reflect.ownKeys(selected)).toEqual(Reflect.ownKeys(native))
      expect(selected).toEqual(native)
      expect(Object.isFrozen(selected)).toBe(true)
      expect(Object.isFrozen(h.capture)).toBe(true)
      expect(selected.token).toBe(original.token)
      expect(selected.persistence).toBe(original.persistence)
      expect(selected.legacyConnection).toBe(harness.db)
      expect(selected.db).toBe(harness.db)
      expect(selected.legacyMarker).toBe('unchanged')
      expect(taskExecutionHostWriteCapture(native)).toBeUndefined()
      expect(taskExecutionHostWriteCapture(selected)).toBe(h.capture)
      await runWithTaskExecutionContext(selected, async () => {
        await nextTurn()
        expect(currentTaskExecutionContext(original.token.taskId)).toBe(selected)
        expect(taskExecutionHostWriteCapture(currentTaskExecutionContext()!)).toBe(h.capture)
        await runWithTaskExecutionContext(native, async () => {
          await nextTurn()
          expect(currentTaskExecutionContext()).toBe(native)
          expect(taskExecutionHostWriteCapture(native)).toBeUndefined()
        })
        expect(currentTaskExecutionContext()).toBe(selected)
      })
      expect(currentTaskExecutionContext()).toBeUndefined()
    })

    test('the original capture, methods, receipt and receiver survive replacement after an actual await', async () => {
      const h = await prepared(harness.db)
      const calls: string[] = []
      let captures = 0
      const originalPort = h.binding.port
      const port: TaskHostWriteContext = {
        capture(grant) {
          expect(this).toBe(port)
          captures++
          return originalPort.capture(grant)
        },
        async consumeNewWork(tx, receipt) {
          expect(this).toBe(port)
          calls.push('new-work')
          await originalPort.consumeNewWork(tx, receipt)
        },
        async consumeRecovery(tx, receipt) {
          expect(this).toBe(port)
          calls.push('recovery')
          await originalPort.consumeRecovery(tx, receipt)
        },
        async consumeIssuedAck(tx, receipt) {
          expect(this).toBe(port)
          calls.push('issued-ack')
          await originalPort.consumeIssuedAck(tx, receipt)
        },
      }
      const capture = captureTaskHostWriteContext(port, h.grant)
      const binding: TaskHostWriteBinding = {
        port,
        transactionFor(tx) {
          expect(this).toBe(binding)
          return h.binding.transactionFor(tx)
        },
      }
      const selection = { kind: 'selected', capture, binding } as const
      await nextTurn()
      port.capture = () => {
        throw new Error('replacement capture called')
      }
      port.consumeNewWork =
        port.consumeRecovery =
        port.consumeIssuedAck =
          async () => {
            throw new Error('replacement consume called')
          }
      await withTaskHostRecovery({
        db: harness.db,
        selection,
        body: async (tx) => {
          await writeWorkflow(tx, 'retained-recovery')
        },
      })
      await h.selected.context.activate(h.receipt)
      await withTaskHostNewWork({
        db: harness.db,
        selection,
        body: async (tx) => {
          await nextTurn()
          binding.transactionFor = () => {
            throw new Error('replacement transactionFor called')
          }
          await writeWorkflow(tx, 'retained-new-work')
        },
      })
      // The next operation has its own original transactionFor captured at entry.
      binding.transactionFor = function (tx) {
        expect(this).toBe(binding)
        return h.binding.transactionFor(tx)
      }
      await h.selected.context.drain(h.receipt)
      await withTaskHostIssuedAck({
        db: harness.db,
        selection,
        body: async (tx) => {
          await writeWorkflow(tx, 'retained-ack')
        },
      })
      expect(captures).toBe(1)
      expect(calls).toEqual(['recovery', 'new-work', 'issued-ack'])
      expect(await workflowIds(harness.db, 'retained-recovery')).toEqual([
        { id: 'retained-recovery' },
      ])
      expect(await workflowIds(harness.db, 'retained-new-work')).toEqual([
        { id: 'retained-new-work' },
      ])
      expect(await workflowIds(harness.db, 'retained-ack')).toEqual([{ id: 'retained-ack' }])
    })

    test('preparing recovery and active new-work use the original serializable body and return value', async () => {
      const h = await prepared(harness.db)
      const result = { original: 'result' }
      expect(
        await withTaskHostRecovery({
          db: harness.db,
          selection: h.selection,
          isolation: 'serializable',
          body: async (tx) => {
            await writeWorkflow(tx, 'recovery-result')
            return result
          },
        }),
      ).toBe(result)
      await expect(
        withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await writeWorkflow(tx, 'not-yet-active')
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(await workflowIds(harness.db, 'not-yet-active')).toEqual([])
      await h.selected.context.activate(h.receipt)
      expect(
        await withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          isolation: 'serializable',
          body: async (tx) => {
            await writeWorkflow(tx, 'new-work-result')
            return result
          },
        }),
      ).toBe(result)
      expect(await workflowIds(harness.db, 'recovery-result')).toEqual([{ id: 'recovery-result' }])
      expect(await workflowIds(harness.db, 'new-work-result')).toEqual([{ id: 'new-work-result' }])
    })

    test('loss after original SQL rolls back new-work while expired issued ACK commits', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      let bodyCompleted = false
      await expect(
        withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await writeWorkflow(tx, 'lost-original-body')
            await nextTurn()
            h.lose()
            bodyCompleted = true
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(bodyCompleted).toBe(true)
      expect(await workflowIds(harness.db, 'lost-original-body')).toEqual([])
      await h.selected.context.drain(h.receipt)
      await harness.db.update(hostExecutionWriteContexts).set({ expiresAt: 0 })
      await expect(
        withTaskHostRecovery({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await writeWorkflow(tx, 'lost-recovery')
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      await withTaskHostIssuedAck({
        db: harness.db,
        selection: h.selection,
        body: async (tx) => {
          await writeWorkflow(tx, 'collected-issued-ack')
        },
      })
      expect(await workflowIds(harness.db, 'lost-recovery')).toEqual([])
      expect(await workflowIds(harness.db, 'collected-issued-ack')).toEqual([
        { id: 'collected-issued-ack' },
      ])
    })

    test('a preparing recovery rejected after the body rolls back its full SQL', async () => {
      const h = await prepared(harness.db)
      await expect(
        withTaskHostRecovery({
          db: harness.db,
          selection: h.selection,
          isolation: 'serializable',
          body: async (tx) => {
            await writeWorkflow(tx, 'lost-preparation')
            h.lose()
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(await workflowIds(harness.db, 'lost-preparation')).toEqual([])
    })

    test('the original business error wins and the original owner CAS rolls back with its body', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const task = await claimedTask(harness.db, 'business-error-task')
      const context = createTaskExecutionContext({ ...task, hostWriteCapture: h.capture })
      const before = (
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, task.token.taskId))
      )[0]!
      await harness.db.update(hostExecutionWriteContexts).set({ expiresAt: 0 })
      const original = new Error('original-task-business-error')
      await expect(
        withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await fenceTaskWrite(tx, { taskId: task.token.taskId, context })
            await writeWorkflow(tx, 'business-error-body')
            throw original
          },
        }),
      ).rejects.toBe(original)
      expect(await workflowIds(harness.db, 'business-error-body')).toEqual([])
      const after = (
        await harness.db
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, task.token.taskId))
      )[0]!
      expect(after).toEqual(before)
      await expect(
        withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await fenceTaskWrite(tx, { taskId: task.token.taskId, context })
            await writeWorkflow(tx, 'host-rejected-owned-body')
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(await workflowIds(harness.db, 'host-rejected-owned-body')).toEqual([])
      expect(
        (
          await harness.db
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, task.token.taskId))
        )[0],
      ).toEqual(before)
    })

    test('a stale original Task owner fails before the host participant can hide its condition', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const task = await claimedTask(harness.db, 'stale-owner-task')
      const context = createTaskExecutionContext({ ...task, hostWriteCapture: h.capture })
      await harness.db
        .update(taskExecutionOwners)
        .set({ epoch: sql`${taskExecutionOwners.epoch} + 1` })
        .where(eq(taskExecutionOwners.taskId, task.token.taskId))
      await harness.db.update(hostExecutionWriteContexts).set({ expiresAt: 0 })
      await expect(
        withTaskHostNewWork({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await fenceTaskWrite(tx, { taskId: task.token.taskId, context })
            await writeWorkflow(tx, 'stale-owner-body')
          },
        }),
      ).rejects.toThrow('was fenced')
      expect(await workflowIds(harness.db, 'stale-owner-body')).toEqual([])
    })

    test('consume acknowledgement must finish before the original transaction returns', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const entered = deferred(),
        ack = deferred()
      const port: TaskHostWriteContext = {
        capture: (grant) => h.binding.port.capture(grant),
        consumeRecovery: (tx, receipt) => h.binding.port.consumeRecovery(tx, receipt),
        consumeIssuedAck: (tx, receipt) => h.binding.port.consumeIssuedAck(tx, receipt),
        async consumeNewWork(tx, receipt) {
          entered.resolve()
          await ack.promise
          await h.binding.port.consumeNewWork(tx, receipt)
        },
      }
      const capture = captureTaskHostWriteContext(port, h.grant)
      const selection = {
        kind: 'selected',
        capture,
        binding: { port, transactionFor: (tx) => h.binding.transactionFor(tx) },
      } satisfies TaskHostWriteSelection
      let completed = false
      const pending = withTaskHostNewWork({
        db: harness.db,
        selection,
        body: async (tx) => {
          await writeWorkflow(tx, 'waited-host-ack')
          return 'original-result'
        },
      }).then((result) => {
        completed = true
        return result
      })
      await entered.promise
      await nextTurn()
      expect(completed).toBe(false)
      ack.resolve()
      expect(await pending).toBe('original-result')
      expect(completed).toBe(true)
      expect(await workflowIds(harness.db, 'waited-host-ack')).toEqual([{ id: 'waited-host-ack' }])
    })

    test('nested helpers reuse the original transaction and outer failure rolls back all SQL', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      let outerTransaction: ProviderNeutralDatabase | undefined
      const original = new Error('original-outer-error')
      await expect(
        withTaskExecutionWrite(harness.db, async (outer) => {
          outerTransaction = outer
          await writeWorkflow(outer, 'outer-sql')
          await withTaskHostNewWork({
            db: harness.db,
            selection: h.selection,
            isolation: 'serializable',
            body: async (inner) => {
              expect(inner).toBe(outerTransaction)
              await writeWorkflow(inner, 'inner-sql')
            },
          })
          throw original
        }),
      ).rejects.toBe(original)
      expect(await workflowIds(harness.db, 'outer-sql')).toEqual([])
      expect(await workflowIds(harness.db, 'inner-sql')).toEqual([])
    })

    test('another binding fails before the body; another real database rolls back the body', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      const second = harness.database(1)
      const other = await prepared(second.db)
      await other.selected.context.activate(other.receipt)
      let ran = false
      expect(() =>
        withTaskHostNewWork({
          db: harness.db,
          selection: { kind: 'selected', capture: h.capture, binding: other.binding },
          body: async () => {
            ran = true
          },
        }),
      ).toThrow('task-host-write-capture-binding-mismatch')
      expect(ran).toBe(false)
      await expect(
        withTaskHostNewWork({
          db: second.db,
          selection: h.selection,
          body: async (tx) => {
            ran = true
            await writeWorkflow(tx, 'other-database-body')
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      expect(ran).toBe(true)
      expect(await workflowIds(second.db, 'other-database-body')).toEqual([])
    })

    test('same generation with a later grant does not replace the original admitted capture', async () => {
      const h = await prepared(harness.db)
      await h.selected.context.activate(h.receipt)
      await h.selected.context.drain(h.receipt)
      await h.selected.context.retire(h.receipt)
      const grant = Object.freeze({
        generation: h.grant.generation,
        reference: Object.freeze({}),
        current: () => true,
      })
      const receipt = await h.selected.context.prepare({
        context: grant,
        holder: 'task-capture-holder',
        expiresAt: Date.now() + 60_000,
      })
      await h.selected.context.activate(receipt)
      const capture = captureTaskHostWriteContext(h.binding.port, grant)
      expect(capture).not.toBe(h.capture)
      await expect(
        withTaskHostIssuedAck({
          db: harness.db,
          selection: h.selection,
          body: async (tx) => {
            await writeWorkflow(tx, 'retired-capture-body')
          },
        }),
      ).rejects.toThrow('host-execution-write-context-unavailable')
      await withTaskHostNewWork({
        db: harness.db,
        selection: { ...h.selection, capture },
        body: async (tx) => {
          await writeWorkflow(tx, 'new-capture-body')
        },
      })
      expect(await workflowIds(harness.db, 'retired-capture-body')).toEqual([])
      expect(await workflowIds(harness.db, 'new-capture-body')).toEqual([
        { id: 'new-capture-body' },
      ])
    })

    test('explicit native selection keeps original behavior; incomplete selected input never falls back', async () => {
      const native = { kind: 'native' } as const
      const result = { native: true }
      expect(
        await withTaskHostNewWork({
          db: harness.db,
          selection: native,
          body: async (tx) => {
            await writeWorkflow(tx, 'native-body')
            return result
          },
        }),
      ).toBe(result)
      const original = new Error('native-original-error')
      await expect(
        withTaskHostRecovery({
          db: harness.db,
          selection: native,
          body: async (tx) => {
            await writeWorkflow(tx, 'native-failed-body')
            throw original
          },
        }),
      ).rejects.toBe(original)
      expect(await workflowIds(harness.db, 'native-body')).toEqual([{ id: 'native-body' }])
      expect(await workflowIds(harness.db, 'native-failed-body')).toEqual([])
      const h = await prepared(harness.db)
      let ran = false
      for (const selection of [
        { kind: 'selected', binding: h.binding },
        { kind: 'selected', capture: h.capture },
        {
          kind: 'selected',
          capture: h.capture,
          binding: { transactionFor: h.binding.transactionFor },
        },
        { kind: 'selected', capture: h.capture, binding: { port: h.binding.port } },
      ] as unknown as TaskHostWriteSelection[]) {
        expect(() =>
          withTaskHostNewWork({
            db: harness.db,
            selection,
            body: async () => {
              ran = true
            },
          }),
        ).toThrow('task-host-write-selection-incomplete')
      }
      expect(ran).toBe(false)
      expect(() =>
        captureTaskHostWriteContext(undefined as unknown as TaskHostWriteContext, h.grant),
      ).toThrow('task-host-write-capture-incomplete')
      const incomplete = {
        capture: h.binding.port.capture,
        consumeNewWork: h.binding.port.consumeNewWork,
      } as unknown as TaskHostWriteContext
      expect(() => captureTaskHostWriteContext(incomplete, h.grant)).toThrow(
        'task-host-write-capture-incomplete',
      )
    })
  },
  { databaseCount: 2 },
)
