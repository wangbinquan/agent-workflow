// RFC-395 plan §3 activation/restore and migration §7: before AND after each durable phase.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EPOCH_SWITCH_PHASES,
  type EpochSwitchJournal,
  type EpochSwitchPhase,
} from '@/modules/system-operations/domain/epochSwitch/model'
import { parseMigrationPlanDocument } from '@/modules/system-operations/domain/epochSwitch/documents'
import { parseGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { describeV3Providers } from './rfc395V3Harness'
import { q3SwitchFixture } from './rfc395Q3SwitchHarness'

export function describeQ3PhaseBoundary(phase: EpochSwitchPhase): void {
  describeV3Providers('Q-3 native phase boundary restart', (h) => {
    for (const restore of [false, true])
      for (const side of ['before', 'after'] as const)
        test(`${restore ? 'restore' : 'switch'} ${side} ${phase}: one run, generation and complete receipt`, async () => {
          const f = await q3SwitchFixture(h, restore)
          let fired = false
          let atBoundary: EpochSwitchJournal | undefined
          const cut = (next: EpochSwitchJournal, when: typeof side) => {
            if (!fired && phase === next.payload.phase && side === when) {
              fired = true
              atBoundary = next
              throw new Error(`q3-${side}-${phase}`)
            }
          }
          const create = f.deps.journal.create
          f.deps.journal.create = async (next) => {
            cut(next, 'before')
            const result = await create(next)
            cut(next, 'after')
            return result
          }
          const cas = f.deps.journal.compareAndSwap
          f.deps.journal.compareAndSwap = async (expected, next) => {
            const current = await f.deps.journal.read(expected.operationId)
            const transition = current!.payload.phase !== next.payload.phase
            if (transition) cut(next, 'before')
            const result = await cas(expected, next)
            if (transition) cut(next, 'after')
            return result
          }
          const finish = async () => {
            const app = f.reopen()
            let journal = await f.deps.journal.read(f.operationId)
            if (!journal) await f.initialPlan()
            else if (!journal.payload.plan) await app.plan({ operationId: f.operationId })
            journal = (await f.deps.journal.read(f.operationId))!
            if (
              EPOCH_SWITCH_PHASES.indexOf(journal.payload.phase) <
              EPOCH_SWITCH_PHASES.indexOf('activated')
            ) {
              const plan = parseMigrationPlanDocument(
                (await app.receipt({ operationId: f.operationId, kind: 'plan' })).json,
              )
              expect(plan.payload.blocks).toEqual([])
              expect(
                (await app.run({ operationId: f.operationId, approve: plan.approvalDigest })).phase,
              ).toBe('activated')
            }
            journal = (await f.deps.journal.read(f.operationId))!
            if (journal.payload.phase === 'activated')
              await app.verify({ operationId: f.operationId })
            return app.complete({ operationId: f.operationId })
          }
          try {
            // A committed boundary may legitimately be durable even when its response was lost.
            // The caller must still observe failure; it must never be told that the whole switch succeeded.
            await expect(finish()).rejects.toThrow()
            expect(fired).toBe(true)
            const boundary = atBoundary!
            const result = await finish()
            expect(result.phase).toBe('completed')
            expect(result.status).toBe('completed')
            expect(result.runId).toBe(boundary.payload.run!.runId)
            expect(result.targetGenerationId).toBe(boundary.payload.target.generationId!)
            expect(await f.deps.journal.list()).toHaveLength(1)
            const generations = await f.generations()
            expect(generations).toHaveLength(1)
            expect(generations[0]).toMatchObject({
              state: 'active',
              generation_id: result.targetGenerationId,
            })
            expect((await f.rows('tasks')).map((row) => row.id)).toEqual(['q3-retained-task'])
            expect((await f.rows('task_definitions')).map((row) => row.task_id)).toEqual([
              'q3-retained-task',
            ])
            expect(
              (await f.rows('maintenance_state')).find((row) => row.key === 'q3-byte-proof')?.value,
            ).toBe(' { "原文": "retained" }\r\n')
            for (const entry of f.retainedConfigurations) {
              const retained = await f.rows(entry.table)
              expect(retained).toHaveLength(1)
              expect(retained[0]).toMatchObject({
                id: 'q3-shared-employee-id',
                name: 'same retained name',
                draft_json: entry.draft,
              })
            }
            await f.assertSourceUnchanged()
            const pointer = readFileSync(f.pointerPath)
            expect(parseGenerationPointerV2(pointer.toString()).payload.generationId).toBe(
              result.targetGenerationId!,
            )
            const receipt = await f.reopen().receipt({ operationId: f.operationId, kind: 'switch' })
            expect(JSON.parse(receipt.json).payload.kind).toBe('completed')
            expect((await finish()).journal.payload.completion).toEqual(
              result.journal.payload.completion,
            )
            expect(
              (await f.reopen().receipt({ operationId: f.operationId, kind: 'switch' })).json,
            ).toBe(receipt.json)
            expect(readFileSync(f.pointerPath)).toEqual(pointer)
            if (restore) {
              expect(readFileSync(join(f.root, 'skills/proof'))).toEqual(
                Buffer.from([0xef, 0xbb, 0xbf, 0, 255]),
              )
              expect(readFileSync(join(f.root, 'config.json'), 'utf8')).toBe('{"restored":true}\n')
              expect(readFileSync(join(f.root, 'backup/skills/proof'))).toEqual(
                Buffer.from([0xef, 0xbb, 0xbf, 0, 255]),
              )
            }
          } finally {
            f.close()
          }
        })
  })
}
