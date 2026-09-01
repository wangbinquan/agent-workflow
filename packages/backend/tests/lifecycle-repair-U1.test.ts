// LOCKS: RFC-057 — U1 repair options (multiple active runs sharing key).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertNodeRun,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

async function setupDuplicateActives(opts: {
  taskStatus?: 'awaiting_review' | 'awaiting_human'
  count?: number
}): Promise<{ h: RepairHarness; runIds: string[]; alertId: string }> {
  const h = await buildHarness({ taskStatus: opts.taskStatus ?? 'awaiting_review' })
  const count = opts.count ?? 2
  const runIds: string[] = []
  for (let i = 0; i < count; i++) {
    runIds.push(
      await insertNodeRun(h.db, h.taskId, {
        nodeId: 'rev_1',
        status: opts.taskStatus === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review',
        retryIndex: i,
      }),
    )
  }
  // ulids sort lexicographically by insert order — sortedAsc[0] is oldest.
  const alertId = await insertAlert(h.db, h.taskId, {
    rule: 'U1',
    detail: {
      rule: 'U1',
      key: 'rev_1|0|0|',
      nodeRunIds: runIds,
      statuses: runIds.map(() =>
        opts.taskStatus === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review',
      ),
    },
  })
  return { h, runIds, alertId }
}

describe('RFC-057 — U1.cancel-older-keep-newest', () => {
  let h: RepairHarness | undefined
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: 2 awaiting rows → newest kept, older canceled', async () => {
    const setup = await setupDuplicateActives({ count: 2 })
    h = setup.h
    const sorted = [...setup.runIds].sort()
    const keep = sorted[sorted.length - 1]!
    const toCancel = sorted.slice(0, -1)
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId: setup.alertId,
      optionId: 'U1.cancel-older-keep-newest',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, keep)).toBe('awaiting_review')
    for (const id of toCancel) {
      expect(await readNodeRunStatus(h.db, id)).toBe('canceled')
    }
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ keep, canceled: toCancel })
  })

  test('happy variant: 3 rows → newest kept, 2 oldest canceled', async () => {
    const setup = await setupDuplicateActives({ count: 3 })
    h = setup.h
    const sorted = [...setup.runIds].sort()
    const keep = sorted[sorted.length - 1]!
    const toCancel = sorted.slice(0, -1)
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId: setup.alertId,
      optionId: 'U1.cancel-older-keep-newest',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, keep)).toBe('awaiting_review')
    expect(toCancel).toHaveLength(2)
    for (const id of toCancel) {
      expect(await readNodeRunStatus(h.db, id)).toBe('canceled')
    }
  })

  test('preflight-stale: only 1 active row remaining → option unavailable', async () => {
    const setup = await setupDuplicateActives({ count: 2 })
    h = setup.h
    // Drift: cancel one of them manually before the operator clicks apply.
    const { transitionNodeRunStatus } = await import('../src/services/lifecycle')
    await transitionNodeRunStatus({
      db: h.db,
      nodeRunId: setup.runIds[0]!,
      event: { kind: 'cancel-by-supersede', reason: 'test-drift' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId: setup.alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'U1.cancel-older-keep-newest')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.U1.unavailable.notMultipleActive')
  })
})

describe('RFC-057 — U1.cancel-newer-keep-oldest', () => {
  let h: RepairHarness | undefined
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: 2 rows → oldest kept, newer canceled', async () => {
    const setup = await setupDuplicateActives({ count: 2 })
    h = setup.h
    const sorted = [...setup.runIds].sort()
    const keep = sorted[0]!
    const toCancel = sorted.slice(1)
    const res = await applyRepairOption({
      db: h.db,
      operations: h.operations,
      taskId: h.taskId,
      alertId: setup.alertId,
      optionId: 'U1.cancel-newer-keep-oldest',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, keep)).toBe('awaiting_review')
    for (const id of toCancel) {
      expect(await readNodeRunStatus(h.db, id)).toBe('canceled')
    }
  })

  test('preflight-stale: detail missing nodeRunIds', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'U1',
      detail: { rule: 'U1' /* nodeRunIds missing */ },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'U1.cancel-newer-keep-oldest')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.U1.unavailable.detailMissingIds')
  })

  test('option has medium risk (default vs newest-keep)', async () => {
    const setup = await setupDuplicateActives({ count: 2 })
    h = setup.h
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId: setup.alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const newest = list.options.find((o) => o.id === 'U1.cancel-older-keep-newest')
    const oldest = list.options.find((o) => o.id === 'U1.cancel-newer-keep-oldest')
    expect(newest?.risk).toBe('low')
    expect(oldest?.risk).toBe('medium')
  })
})
