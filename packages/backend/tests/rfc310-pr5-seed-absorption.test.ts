// RFC-310 PR-5 T59 —— seed 吸收（publication receipt）幂等落账（design §9.1 尾）。
//
// unique(planId, baselineSnapshotRef, receiptKind) 兜底 + 应用层幂等短路：
// 同 baseline 重放不产生第二行；不同 baseline（新 head 重跑）各自成行；读侧
// hasUploadPublicationReceipt 供 arm 幂等判定与事实投影。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { insertUploadPlan } from '../src/modules/development-automation/infrastructure/sqliteUploadPlanStore'
import {
  hasUploadPublicationReceipt,
  recordUploadPublicationReceipt,
} from '../src/modules/development-automation/infrastructure/uploadPublicationReceipt'
import { developmentMissions } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seededPlan(): { db: ReturnType<typeof createInMemoryDb>; planId: string } {
  const db = createInMemoryDb(MIGRATIONS)
  const now = Date.now()
  db.insert(developmentMissions)
    .values({
      id: 'm-1',
      revision: 0,
      epoch: 0,
      status: 'working',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-1',
      sourceKind: 'direct',
      deliveryKind: 'create-merge-request',
      launchIdempotencyKey: 'seed-absorb-1',
      createdBy: 'u-1',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  insertUploadPlan(db, {
    planId: 'plan-1',
    missionId: 'm-1',
    missionRevision: 0,
    repositoryId: 'repo-1',
    baselineSnapshotRef: `git:${'a'.repeat(40)}`,
    baselineSha: 'a'.repeat(40),
    planDigest: 'p'.repeat(64),
    entries: [
      {
        ordinal: 0,
        fileId: 'f-1',
        uploadBlobRef: 'b'.repeat(64),
        uploadSha256: 'b'.repeat(64),
        repositoryTargetPath: 'docs/spec.md',
        contentPolicy: 'preserve-upload',
        targetFileMode: 'regular',
        expectedTarget: { kind: 'absent' },
      },
    ],
    createdAt: now,
  })
  return { db, planId: 'plan-1' }
}

describe('rfc310 pr5 — upload publication receipt', () => {
  test('first publish records once; same-baseline replay is idempotent; new baseline records separately', () => {
    const { db, planId } = seededPlan()
    expect(hasUploadPublicationReceipt(db, planId)).toBe(false)

    const first = recordUploadPublicationReceipt(db, {
      planId,
      baselineSnapshotRef: `git:${'a'.repeat(40)}`,
      commitSha: 'c'.repeat(40),
      seedChangeRef: 'p'.repeat(64),
      seedTreeDigest: 's'.repeat(64),
      entries: [{ targetPath: 'docs/spec.md', sha256: 'b'.repeat(64) }],
      now: Date.now(),
    })
    expect(first.created).toBe(true)
    expect(hasUploadPublicationReceipt(db, planId)).toBe(true)

    const replay = recordUploadPublicationReceipt(db, {
      planId,
      baselineSnapshotRef: `git:${'a'.repeat(40)}`,
      commitSha: 'c'.repeat(40),
      seedChangeRef: 'p'.repeat(64),
      seedTreeDigest: 's'.repeat(64),
      entries: [{ targetPath: 'docs/spec.md', sha256: 'b'.repeat(64) }],
      now: Date.now(),
    })
    expect(replay.created).toBe(false)
    expect(replay.receiptId).toBe(first.receiptId)

    // 新 head 上的重发布是另一次吸收事实（restart-action-from-new-head 语义）。
    const rebased = recordUploadPublicationReceipt(db, {
      planId,
      baselineSnapshotRef: `git:${'d'.repeat(40)}`,
      commitSha: 'e'.repeat(40),
      seedChangeRef: 'p'.repeat(64),
      seedTreeDigest: 's'.repeat(64),
      entries: [{ targetPath: 'docs/spec.md', sha256: 'b'.repeat(64) }],
      now: Date.now(),
    })
    expect(rebased.created).toBe(true)
    expect(rebased.receiptId).not.toBe(first.receiptId)
  })
})
