// RFC-304 §7.2 — the RESTART half of publish-intent recovery.
//
// The design names the mechanism: 「重启恢复时，对处于『意图已写、结果未写』的批次按
// `batchId` 核对远端…已存在则补齐 id，不存在才重发」. What shipped reconciles per
// ANCHOR immediately before each publish, which covers the harm the design names —
// a second round posting every finding twice.
//
// This closes the case that path cannot reach: the merge request that never gets
// another round. Its intent row stays `pending` for good, and on GitLab the orphan
// drafts of the interrupted batch wait for a cleanup that never comes. Nobody is
// reviewing it, so nothing ever notices.
//
// The cases below pin the sweep's judgement rather than its plumbing — what it
// reconciles, what it deliberately leaves alone, and that its bound is visible.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codePublishIntents, webhookEndpoints } from '../src/db/schema'
import {
  BOOT_RECOVERY_ANCHOR_LIMIT,
  recoverPublishIntentsOnBoot,
} from '../src/modules/code-capability/application/recoverPublishIntentsOnBoot'
import type { CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

/** A host that reports the given comments, and records what it was asked. */
function hostWith(comments: Array<{ id: string; body: string }>): {
  port: CodeHostPort
  paths: string[]
} {
  const paths: string[] = []
  const port = {
    call: async (call: { action: string; params: Record<string, unknown> }) => {
      paths.push(`${call.action} ${String(call.params.mr ?? '')}`)
      if (call.action === 'comment.list') {
        return { ok: true, status: 200, body: JSON.stringify(comments), truncated: false }
      }
      return { ok: true, status: 200, body: '[]', truncated: false }
    },
  } as unknown as CodeHostPort
  return { port, paths }
}

describe('RFC-304 §7.2 — reconciling interrupted publish batches at boot', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_recovery',
      secretEnc: 'sealed',
      enabled: true,
    })
  })
  afterEach(() => db.$client.close())

  const seedIntent = async (over: Partial<typeof codePublishIntents.$inferInsert> = {}) => {
    await db.insert(codePublishIntents).values({
      batchId: 'batch-1',
      roundId: 'round-1',
      anchorRef: 'ep-1:41823:mr:412',
      fingerprintsJson: JSON.stringify(['fp-a']),
      state: 'pending',
      epoch: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    } as typeof codePublishIntents.$inferInsert)
  }

  test('a batch whose comments ARE on the merge request is settled, not re-posted', async () => {
    // The whole reason an intent exists. Re-posting would show the author the
    // same finding twice, which is the failure §7.2 opens with.
    await seedIntent()
    const { port, paths } = hostWith([{ id: '9001', body: 'a finding <!-- aw-fp:fp-a -->' }])

    const result = await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port, now: NOW })

    expect(result.anchors).toBe(1)
    // It READ the merge request rather than writing to it.
    expect(paths.some((p) => p.startsWith('comment.list'))).toBe(true)
    expect(paths.some((p) => p.startsWith('comment.create'))).toBe(false)
  })

  test('a host that cannot be read leaves the batch PENDING rather than settling it', async () => {
    // Settling on a failed read would mark a batch recovered with nobody having
    // looked at the merge request — the one outcome worse than not recovering.
    await seedIntent()
    const port = {
      call: async () => ({
        ok: false,
        status: 502,
        body: '',
        truncated: false,
        code: 'x',
        message: 'down',
      }),
    } as unknown as CodeHostPort

    await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port, now: NOW })

    const [row] = await db.select().from(codePublishIntents)
    expect(row?.state).toBe('pending')
  })

  test('a settled batch is not swept again', async () => {
    await seedIntent({ state: 'settled' })
    const { port, paths } = hostWith([])
    const result = await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port })
    expect(result.anchors).toBe(0)
    expect(paths).toEqual([])
  })

  test('an anchor whose endpoint was deleted is skipped, not crashed on', async () => {
    // Nothing can address that merge request any more. The row stays as the
    // record that it happened; a boot sweep must not die on it.
    await seedIntent({ anchorRef: 'ep-gone:41823:mr:412' })
    const { port } = hostWith([])
    const result = await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port })
    expect(result.anchors).toBe(1)
    expect(result.recovered).toBe(0)
  })

  test('an unreadable anchor ref is skipped by shape, not by exception', async () => {
    await seedIntent({ anchorRef: 'nonsense' })
    const { port, paths } = hostWith([])
    await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port })
    expect(paths).toEqual([])
  })

  test('an issue anchor is not swept — there is no draft batch on an issue', async () => {
    await seedIntent({ anchorRef: 'ep-1:41823:issue:7' })
    const { port, paths } = hostWith([])
    await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port })
    expect(paths).toEqual([])
  })

  test('several batches on ONE merge request cost one read, not one each', async () => {
    // Recovery is per anchor because the read is per anchor: three interrupted
    // batches on one merge request are answered by one listing.
    await seedIntent({ batchId: 'b1' })
    await seedIntent({ batchId: 'b2' })
    await seedIntent({ batchId: 'b3' })
    const { port, paths } = hostWith([])

    const result = await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port, now: NOW })

    expect(result.anchors).toBe(1)
    expect(paths.filter((p) => p.startsWith('comment.list'))).toHaveLength(1)
  })

  test('the bound is REPORTED, so a partial sweep cannot read as a complete one', async () => {
    // The repo rule against silent caps. A sweep that quietly did 2 of 40 looks
    // exactly like a sweep that found only 2 — and the difference is whether
    // thirty-eight merge requests are still carrying orphan drafts.
    for (let i = 0; i < 5; i++) {
      await seedIntent({ batchId: `b${String(i)}`, anchorRef: `ep-1:41823:mr:${String(400 + i)}` })
    }
    const { port } = hostWith([])

    const result = await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port, limit: 2 })

    expect(result.anchors).toBe(2)
    expect(result.deferred).toBe(3)
  })

  test('the default bound is small — a boot with hundreds pending is a symptom, not a workload', async () => {
    expect(BOOT_RECOVERY_ANCHOR_LIMIT).toBeLessThanOrEqual(50)
  })

  test('the daemon actually calls it at boot — otherwise it is a sweep nobody runs', async () => {
    // The defect class this RFC has spent itself on: a function with a
    // docstring and no caller. Source-level because the alternative is booting
    // a daemon in a unit test.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    expect(src).toContain('recoverPublishIntentsOnBoot')
  })

  test('nothing pending is not an error, and costs no calls', async () => {
    const { port, paths } = hostWith([])
    expect(await recoverPublishIntentsOnBoot({ db, codeHostFor: () => port })).toEqual({
      anchors: 0,
      recovered: 0,
      deferred: 0,
    })
    expect(paths).toEqual([])
  })
})
