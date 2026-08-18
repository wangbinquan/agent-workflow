// RFC-310 PR-3 T36 —— 上传会话生命周期与 launch 原子 claim。
//
// 锁 design §12.1/§12.3 的会话合同：①createUpload 按 (actor, idempotencyKey)
// 幂等复用（断线重试不产生无法辨认的重复 blob 行）；②DELETE 只对本人 pending
// 生效，他人/已 claim 与不存在同形 404；③claim 全有或全无——任一 ref 被别的
// mission 拿走则零消费；④同 mission 重放 claim 幂等；⑤TTL 过期拒 claim、
// sweep 只清 pending；⑥launch 事务整体性：claim 失败 ⇒ mission 行也整体回滚
// （零 mission 零消费），成功 ⇒ 行 claimed + plan 落库 + uploadPlanRef 回填。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  developmentMissions,
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
} from '../src/db/schema'
import {
  createSqliteUploadSessionStore,
  UPLOAD_SESSION_TTL_MS,
} from '../src/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import { insertUploadPlan } from '../src/modules/development-automation/infrastructure/sqliteUploadPlanStore'
import type { UploadSessionStore } from '../src/modules/development-automation/application/ports/uploadSessionStore'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

const T0 = 1_700_000_000_000

function mk(db: DbClient) {
  return createSqliteUploadSessionStore(db)
}

function put(
  store: UploadSessionStore,
  overrides: Partial<{
    actorUserId: string | null
    originalName: string
    idempotencyKey: string | null
    now: number
    sha256: string
  }> = {},
) {
  return store.createUpload({
    actorUserId: overrides.actorUserId ?? 'u-1',
    originalName: overrides.originalName ?? 'spec.md',
    bytes: 4,
    sha256: overrides.sha256 ?? 'a'.repeat(64),
    blobRef: overrides.sha256 ?? 'a'.repeat(64),
    idempotencyKey: overrides.idempotencyKey ?? null,
    now: overrides.now ?? T0,
  })
}

describe('rfc310 pr3 upload session store', () => {
  test('createUpload is idempotent per (actor, idempotencyKey); distinct actors get distinct rows', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const first = put(store, { idempotencyKey: 'retry-1' })
    const replay = put(store, { idempotencyKey: 'retry-1' })
    expect(replay.id).toBe(first.id)
    const other = put(store, { idempotencyKey: 'retry-1', actorUserId: 'u-2' })
    expect(other.id).not.toBe(first.id)
    const noKey = put(store)
    expect(noKey.id).not.toBe(first.id)
  })

  test('deleteUpload: own pending deletes; foreign/claimed/missing are the same 404 shape', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const mine = put(store)
    const foreign = put(store, { actorUserId: 'u-2' })
    const claimed = put(store)
    store.claimUploads({ missionId: 'm-1', actorUserId: 'u-1', uploadRefs: [claimed.id], now: T0 })

    store.deleteUpload(mine.id, 'u-1')
    expect(store.getUpload(mine.id)).toBeNull()

    for (const ref of [foreign.id, claimed.id, 'does-not-exist']) {
      try {
        store.deleteUpload(ref, 'u-1')
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('upload-not-found')
      }
    }
    // 未被误删。
    expect(store.getUpload(foreign.id)).not.toBeNull()
    expect(store.getUpload(claimed.id)!.state).toBe('claimed')
  })

  test('claim is all-or-nothing: one foreign-claimed ref leaves every other ref untouched', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const a = put(store)
    const b = put(store)
    const stolen = put(store)
    store.claimUploads({ missionId: 'm-x', actorUserId: 'u-1', uploadRefs: [stolen.id], now: T0 })

    try {
      store.claimUploads({
        missionId: 'm-y',
        actorUserId: 'u-1',
        uploadRefs: [a.id, b.id, stolen.id],
        now: T0,
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('upload-already-claimed')
    }
    expect(store.getUpload(a.id)!.state).toBe('pending')
    expect(store.getUpload(b.id)!.state).toBe('pending')
    expect(store.getUpload(stolen.id)!.claimedByMissionId).toBe('m-x')
  })

  test('claim replay by the same mission is idempotent; expiry rejects with upload-not-claimable', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const row = put(store)
    store.claimUploads({ missionId: 'm-1', actorUserId: 'u-1', uploadRefs: [row.id], now: T0 })
    const replay = store.claimUploads({
      missionId: 'm-1',
      actorUserId: 'u-1',
      uploadRefs: [row.id],
      now: T0,
    })
    expect(replay[0]!.claimedByMissionId).toBe('m-1')

    const expiring = put(store)
    try {
      store.claimUploads({
        missionId: 'm-2',
        actorUserId: 'u-1',
        uploadRefs: [expiring.id],
        now: T0 + UPLOAD_SESSION_TTL_MS + 1,
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('upload-not-claimable')
    }
  })

  test('foreign refs are indistinguishable from missing on claim (no existence oracle)', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const foreign = put(store, { actorUserId: 'u-2' })
    for (const ref of [foreign.id, 'no-such-ref']) {
      try {
        store.claimUploads({ missionId: 'm-1', actorUserId: 'u-1', uploadRefs: [ref], now: T0 })
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('upload-not-found')
      }
    }
  })

  test('sweepExpired removes only expired pending rows', () => {
    const store = mk(createInMemoryDb(MIGRATIONS))
    const fresh = put(store, { now: T0 + UPLOAD_SESSION_TTL_MS })
    const stale = put(store, { now: T0 })
    const claimedStale = put(store, { now: T0 })
    store.claimUploads({
      missionId: 'm-1',
      actorUserId: 'u-1',
      uploadRefs: [claimedStale.id],
      now: T0,
    })
    const removed = store.sweepExpired(T0 + UPLOAD_SESSION_TTL_MS + 1)
    expect(removed).toBe(1)
    expect(store.getUpload(stale.id)).toBeNull()
    expect(store.getUpload(fresh.id)).not.toBeNull()
    expect(store.getUpload(claimedStale.id)!.state).toBe('claimed')
  })

  test('insertUploadPlan persists plan + ordered entries with expectedTarget projection', () => {
    const db = createInMemoryDb(MIGRATIONS)
    // plans 表带 mission FK：先立 mission 行。
    db.insert(developmentMissions)
      .values({
        id: 'm-plan',
        status: 'working',
        repositoryId: 'repo-1',
        sourceKind: 'direct',
        deliveryKind: 'create-merge-request',
        launchIdempotencyKey: 'idem-plan-1',
        createdAt: T0,
        updatedAt: T0,
      })
      .run()
    insertUploadPlan(db, {
      planId: 'plan-1',
      missionId: 'm-plan',
      missionRevision: 0,
      repositoryId: 'repo-1',
      baselineSnapshotRef: `git:${'f'.repeat(40)}`,
      baselineSha: 'f'.repeat(40),
      planDigest: 'd'.repeat(64),
      createdAt: T0,
      entries: [
        {
          ordinal: 0,
          fileId: 'up-1',
          uploadBlobRef: 'a'.repeat(64),
          uploadSha256: 'a'.repeat(64),
          repositoryTargetPath: 'docs/a.md',
          contentPolicy: 'preserve-upload',
          targetFileMode: 'regular',
          expectedTarget: { kind: 'absent' },
        },
        {
          ordinal: 1,
          fileId: 'up-2',
          uploadBlobRef: 'b'.repeat(64),
          uploadSha256: 'b'.repeat(64),
          repositoryTargetPath: 'docs/b.md',
          contentPolicy: 'agent-editable',
          targetFileMode: 'executable',
          expectedTarget: { kind: 'exact-file', sha256: 'c'.repeat(64), fileMode: 'regular' },
        },
      ],
    })
    const plan = db
      .select()
      .from(developmentRepositoryUploadPlans)
      .where(eq(developmentRepositoryUploadPlans.id, 'plan-1'))
      .get()!
    expect(plan.planDigest).toBe('d'.repeat(64))
    const entries = db
      .select()
      .from(developmentRepositoryUploadPlanEntries)
      .where(eq(developmentRepositoryUploadPlanEntries.planId, 'plan-1'))
      .all()
      .sort((a, b) => a.ordinal - b.ordinal)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.expectedTargetKind).toBe('absent')
    expect(entries[0]!.expectedTargetSha256).toBeNull()
    expect(entries[1]!.expectedTargetKind).toBe('exact-file')
    expect(entries[1]!.expectedTargetSha256).toBe('c'.repeat(64))
    expect(entries[1]!.expectedTargetFileMode).toBe('regular')
  })
})
