// RFC-294 P0-B/W6 pre-refactor characterization.
//
// 立项时 Intent Apply 与 BundleApply 是两台引擎，这几条锁的是两台都必须保住的
// 用户可见生命周期：新工作不被回收、崩溃残留只收敛一次、失败的尝试绝不重跑、
// 已提交的收据在周围可变状态变了之后仍然可重放。
//
// RFC-359 —— **两边各自的两台引擎都已合一**（`§5dy` 收掉通用 bundle 引擎、`§5ea` 收掉
// intent apply 引擎），所以这个文件不再是「两台之间的对拍」。它留着的理由变了但仍然充分：
// 这四条是**合一前后都不许变**的用户可见行为，正是合一最容易悄悄改掉的那一类
// （回收阈值、收敛的幂等性、失败重放的语义）。任何一条红都说明合一动了不该动的东西。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, intentApplyJournal, intentSessions, resourceBundleApplies } from '@/db/schema'
import {
  applyIntentChangeset,
  convergeIntentApplyJournal,
  type IntentApplyReceipt,
} from '@/modules/intent/composition/apply'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeSqliteResourcePackageApplyMaintenance } from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { encodeZip } from '@/util/zip'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const OWNER_ID = 'rfc294-apply-owner'

let db: ProviderNeutralDatabase
let appHome: string
let sessionId: string

function actorOf(id: string): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

/**
 * RFC-359（plan §5dy）—— 资源包那一半改走**生产在用的统一 apply 引擎**。
 *
 * 通用 bundle 引擎（`services/bundle/apply.ts`）随合一退役，于是这份对拍里
 * 「资源包侧」的三件事各换了执行者，**判据一条没改**：
 *   · 收敛 → `composeSqliteResourcePackageApplyMaintenance(...).command.converge`
 *     （中立的 converge 命令，两个 provider 共用）；
 *   · 重放 → 真的走一次 apply：拿一个 `importId` 等于 journal `key` 的 preview token 提交，
 *     引擎在 duplicate lookup 那一步就回放 / 拒绝，**根本走不到写；**
 *   · journal 的 scope 固定是 `'package'`（统一引擎不再让调用方自选 scope）。
 */
const PACKAGE_SCOPE = 'package'

/** 一个最小的、能被 parse 的空包：重放路径在 duplicate lookup 就返回，内容不重要。 */
function minimalPackageZip(): Uint8Array {
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-parity
  type: agent
  name: parity
resources:
  - slug: agent-parity
    type: agent
    name: parity
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: 'agent-parity',
              payload: {
                name: 'parity',
                description: '',
                outputs: [],
                syncOutputsOnIterate: true,
                permission: {},
                skills: [],
                dependsOn: [],
                mcp: [],
                plugins: [],
                frontmatterExtra: {},
                bodyMd: '',
              },
            },
          ],
          rootRef: 'local:agent-parity',
        }),
      ),
    },
  ])
}

/** 用与 journal `key` 相同的 `importId` 提交一次——命中 duplicate lookup。 */
async function replayPackageApply(importId: string): Promise<unknown> {
  const pkg = await parseResourcePackage(minimalPackageZip())
  const preview = await buildPackagePreview(db, actorOf(OWNER_ID), pkg, { box, importId })
  return commitResourcePackageForTest({ db, appHome, box }, actorOf(OWNER_ID), {
    pkg,
    previewToken: preview.previewToken,
    decisions: [{ localSlug: 'agent-parity', action: 'new' }],
  })
}

function convergePackageApplies(): Promise<{ failed: number; rolledForward: number }> {
  const maintenance = composeSqliteResourcePackageApplyMaintenance({
    db,
    appHome,
    pluginsDir: join(appHome, 'plugins'),
    activitySource: { activeApplyIds: () => [] },
  })
  return maintenance.command
    .converge({ activeApplyIds: [] })
    .then((receipt) => ({ failed: receipt.failed, rolledForward: receipt.rolledForward }))
}

async function seedFixture(harness: ProviderHarness): Promise<void> {
  db = harness.db
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc294-apply-parity-'))
  sessionId = ulid()
  const now = Date.now()
  await db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER_ID,
    title: 'RFC-294 apply parity',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
}

afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

interface PairIds {
  intentId: string
  intentKey: string
  bundleId: string
  bundleScope: string
  bundleKey: string
}

async function seedPair(
  suffix: string,
  state: 'prepared' | 'applying' | 'committed' | 'failed',
  updatedAt: number,
  receipts?: { intent: IntentApplyReceipt; bundle: Record<string, unknown> },
): Promise<PairIds> {
  const intentId = ulid()
  const intentKey = `intent-${suffix}`
  const bundleId = ulid()
  const bundleScope = PACKAGE_SCOPE
  const bundleKey = `bundle-${suffix}`
  await db.insert(intentApplyJournal).values({
    id: intentId,
    sessionId,
    clientMutationId: intentKey,
    draftId: `draft-${suffix}`,
    draftHash: `sha256:${suffix}`,
    state,
    preparedArtifactsJson: '[]',
    receiptJson: receipts === undefined ? null : JSON.stringify(receipts.intent),
    error: state === 'failed' ? 'seeded failure' : null,
    createdAt: updatedAt,
    updatedAt,
  })
  await db.insert(resourceBundleApplies).values({
    id: bundleId,
    scope: bundleScope,
    key: bundleKey,
    actorUserId: OWNER_ID,
    state,
    preparedArtifactsJson: '[]',
    receiptJson: receipts === undefined ? null : JSON.stringify(receipts.bundle),
    error: state === 'failed' ? 'seeded failure' : null,
    createdAt: updatedAt,
    updatedAt,
  })
  return { intentId, intentKey, bundleId, bundleScope, bundleKey }
}

async function intentState(id: string) {
  return db.select().from(intentApplyJournal).where(eq(intentApplyJournal.id, id)).get()
}

async function bundleState(id: string) {
  return db.select().from(resourceBundleApplies).where(eq(resourceBundleApplies.id, id)).get()
}

// RFC-359（AC-6）—— 改成双引擎。此前钉死在 `createInMemoryDb` 上不是因为判据与引擎有关，
// 而是因为两条 apply 路径的生产签名当时都只收 `DbClient`；§5dy / §5ea 合一之后限制没了。
describeEachProvider('RFC-294 apply 重放 / 恢复平价（双引擎）', (harness) => {
  beforeEach(async () => {
    await seedFixture(harness)
  })

  describe('RFC-294 AtomicApply migration parity', () => {
    test('fresh work survives a sweep; after restart-age it converges failed and replay stays side-effect free', async () => {
      const pair = await seedPair('crash', 'applying', Date.now())

      expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      expect(await convergePackageApplies()).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      expect((await intentState(pair.intentId))?.state).toBe('applying')
      expect((await bundleState(pair.bundleId))?.state).toBe('applying')

      const stale = Date.now() - 11 * 60 * 1000
      await db
        .update(intentApplyJournal)
        .set({ updatedAt: stale })
        .where(eq(intentApplyJournal.id, pair.intentId))
      await db
        .update(resourceBundleApplies)
        .set({ updatedAt: stale })
        .where(eq(resourceBundleApplies.id, pair.bundleId))

      expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
        failed: 1,
        rolledForward: 0,
      })
      expect(await convergePackageApplies()).toEqual({
        failed: 1,
        rolledForward: 0,
      })
      expect((await intentState(pair.intentId))?.state).toBe('failed')
      expect((await bundleState(pair.bundleId))?.state).toBe('failed')

      await expect(
        applyIntentChangeset(
          {
            db,
            appHome,
            actor: actorOf(OWNER_ID),
            ...intentApplyResourceBinding(db, actorOf(OWNER_ID)),
          },
          {
            sessionId,
            clientMutationId: pair.intentKey,
            draftRevision: 1,
            draftHash: 'sha256:crash',
            decisions: [],
          },
        ),
      ).rejects.toMatchObject({ code: 'intent-apply-failed-replay' })
      await expect(replayPackageApply(pair.bundleKey)).rejects.toMatchObject({
        code: 'bundle-apply-failed-replay',
      })

      expect(await db.select().from(agents)).toEqual([])
      expect(await db.select().from(intentApplyJournal)).toHaveLength(1)
      expect(await db.select().from(resourceBundleApplies)).toHaveLength(1)
    })

    test('committed receipts replay exactly even after mutable admission state changes', async () => {
      const intentReceipt: IntentApplyReceipt = {
        journalId: 'intent-receipt',
        commitSeq: 7,
        applied: [],
      }
      // 统一引擎的回执信封（`ReceiptSchema`，strict）：`applied[]` 逐条用 `operationId`。
      // 空 applied 两种命名下同形，这里正好不用分心。
      const bundleReceipt = { journalId: 'bundle-receipt', applied: [] }
      const pair = await seedPair('committed', 'committed', Date.now(), {
        intent: intentReceipt,
        bundle: bundleReceipt,
      })

      // A byte-identical successful request may be retried after the UI archived
      // its Intent session or after a package preview expired. Duplicate lookup
      // must win over those mutable validations; actor/request mismatches are a
      // separate P0/W6 blocker and are deliberately not characterized as green.
      await db
        .update(intentSessions)
        .set({ status: 'archived', inFlightTurnId: ulid() })
        .where(eq(intentSessions.id, sessionId))

      const intentReplay = await applyIntentChangeset(
        {
          db,
          appHome,
          actor: actorOf(OWNER_ID),
          ...intentApplyResourceBinding(db, actorOf(OWNER_ID)),
        },
        {
          sessionId,
          clientMutationId: pair.intentKey,
          draftRevision: 1,
          draftHash: 'sha256:committed',
          decisions: [],
        },
      )
      const bundleReplay = await replayPackageApply(pair.bundleKey)

      expect(intentReplay).toEqual(intentReceipt)
      expect(bundleReplay).toEqual(bundleReceipt)
      expect((await intentState(pair.intentId))?.state).toBe('committed')
      expect((await bundleState(pair.bundleId))?.state).toBe('committed')
    })

    test('Intent replay remains owner-scoped and does not reveal another user receipt', async () => {
      const intentReceipt: IntentApplyReceipt = {
        journalId: 'private-intent-receipt',
        commitSeq: 1,
        applied: [],
      }
      const pair = await seedPair('private', 'committed', Date.now(), {
        intent: intentReceipt,
        bundle: { journalId: 'unused-bundle-receipt', applied: [] },
      })

      await expect(
        applyIntentChangeset(
          {
            db,
            appHome,
            actor: actorOf('rfc294-other-user'),
            ...intentApplyResourceBinding(db, actorOf('rfc294-other-user')),
          },
          {
            sessionId,
            clientMutationId: pair.intentKey,
            draftRevision: 1,
            draftHash: 'sha256:private',
            decisions: [],
          },
        ),
      ).rejects.toMatchObject({ code: 'intent-session-not-found' })
      expect((await intentState(pair.intentId))?.receiptJson).toBe(JSON.stringify(intentReceipt))
    })
  })
})
