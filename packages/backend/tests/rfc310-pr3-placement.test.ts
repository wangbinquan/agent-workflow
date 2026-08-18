// RFC-310 PR-3 T36a —— upload seed placement（immutable SeedChangeRef 物化）。
//
// 锁 design §5.4 的 placement 合同：①seed 根 = planDigest（内容寻址幂等键），
// 重复 place 复用不重建；②中断残留（seed 内容与 receipt digest 不符）废弃重建
// 到 byte-identical；③already-present entry 不物化（不制造伪 diff）；④全
// already-present ⇒ seedChangeRef=null + baseline-observed fulfillment，绝不
// 伪造 change；⑤blob 缺失显式抛；⑥reconciler provider 把失败折叠为
// configuration/PortOutcome，不抛穿。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { developmentMissions, developmentRepositoryUploadReceipts } from '../src/db/schema'
import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import { insertUploadPlan } from '../src/modules/development-automation/infrastructure/sqliteUploadPlanStore'
import {
  createUploadPlacementProvider,
  placeUploadSeed,
  seedTreeDigestOf,
} from '../src/modules/development-automation/infrastructure/uploadPlacement'
import type { ResolvedPlanEntry } from '../src/modules/development-automation/application/uploadPlan'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')
const T0 = 1_700_000_000_000

interface Rig {
  db: DbClient
  evidence: EvidenceStore
  seedsRoot: string
  root: string
  putBlob: (content: string) => Promise<string>
  plant: (planId: string, entries: ResolvedPlanEntry[]) => void
  deps: { db: DbClient; evidence: EvidenceStore; seedsRoot: string; now: () => number }
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'aw-place-'))
  const db = createInMemoryDb(MIGRATIONS)
  const evidence = new EvidenceStore(join(root, 'evidence'))
  const seedsRoot = join(root, 'seeds')
  mkdirSync(seedsRoot, { recursive: true })
  db.insert(developmentMissions)
    .values({
      id: 'm-1',
      status: 'working',
      repositoryId: 'repo-1',
      sourceKind: 'direct',
      deliveryKind: 'create-merge-request',
      launchIdempotencyKey: 'idem-1',
      createdAt: T0,
      updatedAt: T0,
    })
    .run()
  return {
    db,
    evidence,
    seedsRoot,
    root,
    async putBlob(content: string) {
      const tmp = join(root, `blob-src-${Math.abs(content.length)}-${content.slice(0, 4)}`)
      writeFileSync(tmp, content)
      const { sha256 } = await evidence.putBlobFromFile(tmp)
      return sha256
    },
    plant(planId: string, entries: ResolvedPlanEntry[]) {
      insertUploadPlan(db, {
        planId,
        missionId: 'm-1',
        missionRevision: 0,
        repositoryId: 'repo-1',
        baselineSnapshotRef: `git:${'f'.repeat(40)}`,
        baselineSha: 'f'.repeat(40),
        planDigest: `digest-${planId}`,
        createdAt: T0,
        entries,
      })
    },
    deps: { db, evidence, seedsRoot, now: () => T0 },
  }
}

function entryOf(
  ordinal: number,
  fileId: string,
  sha: string,
  target: string,
  expected: ResolvedPlanEntry['expectedTarget'],
): ResolvedPlanEntry {
  return {
    ordinal,
    fileId,
    uploadBlobRef: sha,
    uploadSha256: sha,
    repositoryTargetPath: target,
    contentPolicy: 'preserve-upload',
    targetFileMode: 'regular',
    expectedTarget: expected,
  }
}

describe('rfc310 pr3 upload placement', () => {
  test('materializes create+replace entries byte-identically; already-present is skipped', async () => {
    const r = rig()
    const shaNew = await r.putBlob('new file body\n')
    const shaReplace = await r.putBlob('replacement body\n')
    const shaSame = await r.putBlob('unchanged\n')
    r.plant('p1', [
      entryOf(0, 'u1', shaNew, 'docs/new.md', { kind: 'absent' }),
      entryOf(1, 'u2', shaReplace, 'src/app.ts', {
        kind: 'exact-file',
        sha256: 'e'.repeat(64),
        fileMode: 'regular',
      }),
      entryOf(2, 'u3', shaSame, 'docs/same.md', {
        kind: 'already-present',
        sha256: shaSame,
        fileMode: 'regular',
      }),
    ])
    const result = await placeUploadSeed(r.deps, { planId: 'p1' })
    expect(result.seedChangeRef).toBe('digest-p1')
    expect(result.dispositions).toEqual([
      { fileId: 'u1', disposition: 'created' },
      { fileId: 'u2', disposition: 'replaced' },
      { fileId: 'u3', disposition: 'already-present' },
    ])
    const seedRoot = join(r.seedsRoot, 'digest-p1')
    expect(readFileSync(join(seedRoot, 'docs/new.md'), 'utf8')).toBe('new file body\n')
    expect(readFileSync(join(seedRoot, 'src/app.ts'), 'utf8')).toBe('replacement body\n')
    // already-present 不物化。
    expect(readdirSync(join(seedRoot, 'docs'))).toEqual(['new.md'])
    expect(result.seedTreeDigest).toBe(seedTreeDigestOf(seedRoot))
    // receipt 落库（placement kind、seedChangeRef=planDigest）。
    const receipts = r.db.select().from(developmentRepositoryUploadReceipts).all()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!).toMatchObject({
      planId: 'p1',
      receiptKind: 'placement',
      seedChangeRef: 'digest-p1',
      fulfillmentKind: null,
    })
  })

  test('replay reuses the existing seed; corrupted residue is rebuilt byte-identical', async () => {
    const r = rig()
    const sha = await r.putBlob('stable content\n')
    r.plant('p2', [entryOf(0, 'u1', sha, 'a.md', { kind: 'absent' })])
    const first = await placeUploadSeed(r.deps, { planId: 'p2' })
    const seedFile = join(r.seedsRoot, 'digest-p2', 'a.md')

    // 重放：digest 不变、receipt 不重复。
    const replay = await placeUploadSeed(r.deps, { planId: 'p2' })
    expect(replay.seedTreeDigest).toBe(first.seedTreeDigest)
    expect(r.db.select().from(developmentRepositoryUploadReceipts).all()).toHaveLength(1)

    // 篡改残留：重放检测 digest 漂移 → 废弃重建 → byte-identical 恢复。
    writeFileSync(seedFile, 'tampered')
    const rebuilt = await placeUploadSeed(r.deps, { planId: 'p2' })
    expect(rebuilt.seedTreeDigest).toBe(first.seedTreeDigest)
    expect(readFileSync(seedFile, 'utf8')).toBe('stable content\n')
  })

  test('all already-present ⇒ null seed + baseline-observed fulfillment at the baseline sha', async () => {
    const r = rig()
    const sha = await r.putBlob('already there\n')
    r.plant('p3', [
      entryOf(0, 'u1', sha, 'docs/x.md', {
        kind: 'already-present',
        sha256: sha,
        fileMode: 'regular',
      }),
    ])
    const result = await placeUploadSeed(r.deps, { planId: 'p3' })
    expect(result.seedChangeRef).toBeNull()
    const receipts = r.db.select().from(developmentRepositoryUploadReceipts).all()
    expect(receipts[0]!).toMatchObject({
      receiptKind: 'placement',
      seedChangeRef: null,
      fulfillmentKind: 'baseline-observed',
      commitSha: 'f'.repeat(40),
    })
    // seed 目录不产生。
    expect(readdirSync(r.seedsRoot)).toEqual([])
    // 重放幂等：不再写第二张 receipt。
    await placeUploadSeed(r.deps, { planId: 'p3' })
    expect(r.db.select().from(developmentRepositoryUploadReceipts).all()).toHaveLength(1)
  })

  test('missing blob fails loudly and leaves no seed root behind', async () => {
    const r = rig()
    r.plant('p4', [entryOf(0, 'u1', '9'.repeat(64), 'a.md', { kind: 'absent' })])
    try {
      await placeUploadSeed(r.deps, { planId: 'p4' })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('upload blob missing')
    }
    expect(readdirSync(r.seedsRoot)).toEqual([])
  })

  test('placement provider folds failures into a configuration PortOutcome (never throws)', async () => {
    const r = rig()
    const provider = createUploadPlacementProvider(r.deps)
    const missingPlan = await provider.place({ missionId: 'm-1', uploadPlanRef: 'nope' })
    expect(missingPlan.ok).toBe(false)
    if (!missingPlan.ok) {
      expect(missingPlan.failure.category).toBe('configuration')
      expect(missingPlan.failure.code).toBe('upload-placement-failed')
    }
    const sha = await r.putBlob('ok\n')
    r.plant('p5', [entryOf(0, 'u1', sha, 'a.md', { kind: 'absent' })])
    const ok = await provider.place({ missionId: 'm-1', uploadPlanRef: 'p5' })
    expect(ok.ok).toBe(true)
    rmSync(r.root, { recursive: true, force: true })
  })
})
