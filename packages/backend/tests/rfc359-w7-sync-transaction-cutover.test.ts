// RFC-359 W7 —— 资源包 BundleApply 引擎的四笔 **journal 事务**从 bun:sqlite 独有的同步
// `dbTxSync` 切到中立事务原语（`databaseSessionFor(db).transaction`）后的行为锁。
//
// 为什么这些用例存在：这是**行为改动**，不是纯搬运。`dbTxSync` 的事务体在类型层就不许
// `await`（RFC-093 把 Promise 回调塌成 `never`），整笔写落在同一个 tick 里；换成中立原语后
// 事务体可以 `await`，于是「中间态会不会被别人看见」成了一个真问题
// （`docs/dev-gotchas.md`「合一『两笔同步写』成『两笔异步事务』时，先找可见性缝」）。
// 四个站点各自锁住它的**原子性判据**与 **CAS 判据**：
//
//   ① claim 事务    —— duplicate 查询 + `claimInTx` + journal 插入必须同生共死；
//                      三态重放（committed / failed / prepared）是它的读侧契约。
//   ② recordArtifact —— I14 record-before-act：journal 落库**先于**副作用。切成异步后
//                      调用方必须 `await`；漏掉 await 的话这一条会红（变异已验证）。
//   ③ settleFailed  —— pre-commit 失败 ⇒ journal 终态化成 failed 且带原因。
//   ④ 收敛 CAS      —— 判据挂在 `state` 上（`affectedRows(...) === 1`），
//                      active / 10 分钟下限的行不得被收割。
//
// 两个引擎各跑一遍：这四笔事务体在切换后只用中立查询面（无 `.get()` / `.run()`），
// 所以它们**本身**是 provider 中立的；本文件用注入的 stub mutation runtime 把引擎的
// SQLite 专属部分（`sqliteMembers` 窄化交给的那批同步 `*InTx` 成员）挡在外面。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { resourceBundleApplies } from '@/db/schema'
import {
  applyResourceBundle,
  convergeResourceBundleApplies,
  type BundleApplyDeps,
  type ResourcePackageMutationRuntime,
  type ResourcePackageMutationRuntimeFactory,
} from '@/services/bundle/apply'
import type { BundleApplyProvider, BundleArtifact, BundleReceipt } from '@/services/bundle/provider'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  ResourcePackageApplyScenarioProvider,
  ResourcePackageApplyTx,
} from '@/modules/resource-catalog/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const CONVERGE_MIN_AGE_MS = 10 * 60 * 1000

// I14 的**生产链**兜底（源码层文本断言，CLAUDE.md §Test-with-every-change 允许的最低限度形态）。
//
// 为什么需要它：`recordArtifact` 从同步 `dbTxSync` 改成中立异步事务之后，生产链上
// （`legacyResourcePackageMutationParticipants.ts` 的 `prestage`）**漏掉一个 await 不会让
// 任何既有测试变红**——2026-09-07 实测：把三处 `await context.recordArtifact(...)` 改成
// `void context.recordArtifact(...)`，rfc271-bundle-engine / -recovery-hardening /
// rfc294-apply-replay-recovery-parity 全绿。原因是那些断言都在 apply **返回之后**才读
// journal，那时 fire-and-forget 的写早就落库了；真正被打破的是「副作用之前 journal 已落库」
// 这一条**时序**不变量，而它只在崩溃 / SIGKILL 的窗口里可见。
//
// `bun run lint:promises`（no-floating-promises）挡得住**裸**调用（实测会报 861:9），
// 但挡不住显式 `void`。这条断言补上那个缺口。
const PRESTAGE_ADAPTER = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'aggregateAdapters',
  'legacyResourcePackageMutationParticipants.ts',
)

describe('I14 record-before-act —— 生产 prestage 链的每一处 recordArtifact 都必须 await', () => {
  test('legacyResourcePackageMutationParticipants.ts 里没有未 await 的 recordArtifact', () => {
    const source = readFileSync(PRESTAGE_ADAPTER, 'utf8')
    const calls = [...source.matchAll(/(\S*\s*)context\.recordArtifact\(/g)]
    expect(
      calls.length,
      '语料失效：适配器里一处 recordArtifact 调用都没扫到',
    ).toBeGreaterThanOrEqual(3)
    for (const call of calls) {
      expect(
        call[1],
        `recordArtifact 必须写成 \`await context.recordArtifact(...)\`；` +
          `丢掉 await（含显式 \`void\`）会让副作用跑在 journal 落库之前，而既有测试不会红`,
      ).toBe('await ')
    }
  })
})

const actorOf = (id: string) =>
  buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
  })

function makeProvider(over: Partial<BundleApplyProvider> = {}): BundleApplyProvider {
  return {
    idempotencyKey: { scope: 'package', key: ulid() },
    serializationKey: ulid(),
    actor: actorOf('u1'),
    resolveExternal: async (ref: string) => ref.slice('external:'.length),
    readSkillFile: () => new Uint8Array(),
    ...over,
  }
}

const bundleOf = (ops: unknown[]): ResourceBundle =>
  ({ bundleVersion: 1, ops, rootRef: null }) as unknown as ResourceBundle

const agentCreate = (slug: string) => ({
  opId: `op-${slug}`,
  kind: 'agent-create',
  slug,
  payload: {
    name: slug,
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
})

/**
 * 引擎的 mutation runtime 替身。真实的那一份把事务句柄窄化给一批**同步** `*InTx` 成员
 * （`sqliteMembers`），因此只在 bun:sqlite 上跑得动；这里把它整体换掉，剩下的就只有
 * 本次改造的四笔 journal 事务——那部分两个引擎共用同一条实现。
 */
function stubRuntimeFactory(hooks: {
  onPrestage?: (recordArtifact: (a: BundleArtifact) => Promise<void>) => Promise<void>
}): ResourcePackageMutationRuntimeFactory {
  const runtime: ResourcePackageMutationRuntime = {
    provider: {
      participants: {
        agents: {
          prepare: async (mutation: unknown) => ({ mutation }),
        },
      },
    } as unknown as ResourcePackageApplyScenarioProvider,
    async prestage(_prepared, context) {
      await hooks.onPrestage?.(context.recordArtifact)
    },
    assertUpdateTargetsOwnedInTx() {},
    bindApplyTx: () =>
      ({
        agents: {
          commit: (item: { mutation: { opId?: string } }) => ({
            operationId: item.mutation.opId ?? 'op',
            resourceType: 'agent',
            resourceId: ulid(),
            action: 'create',
            name: 'stub',
          }),
        },
        events: { resourceApplied() {} },
        audit: { recordResourceApplied() {} },
      }) as unknown as ResourcePackageApplyTx,
    rollForwardCommitted() {},
    broadcastCommitted() {},
  }
  return { create: () => runtime }
}

function depsOf(db: ProviderNeutralDatabase, over: Partial<BundleApplyDeps> = {}): BundleApplyDeps {
  return {
    db: db as unknown as DbClient,
    appHome: '/nonexistent/aw-rfc359-w7',
    resourcePackageMutations: stubRuntimeFactory({}),
    ...over,
  }
}

async function journalRow(
  db: ProviderNeutralDatabase,
  scope: string,
  key: string,
): Promise<typeof resourceBundleApplies.$inferSelect | undefined> {
  return (
    await db
      .select()
      .from(resourceBundleApplies)
      .where(and(eq(resourceBundleApplies.scope, scope), eq(resourceBundleApplies.key, key)))
      .limit(1)
  )[0]
}

async function seedJournal(
  db: ProviderNeutralDatabase,
  row: Partial<typeof resourceBundleApplies.$inferInsert> & { key: string },
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(resourceBundleApplies).values({
    id,
    scope: 'package',
    actorUserId: 'u1',
    state: 'prepared',
    preparedArtifactsJson: '[]',
    createdAt: now,
    updatedAt: now,
    ...row,
  })
  return id
}

describeEachProvider('RFC-359 W7 —— BundleApply journal 事务切到中立原语', (harness) => {
  // ── ① claim 事务 ────────────────────────────────────────────────────────
  describe('① claim 事务：duplicate 查询 + claimInTx + 插入同生共死', () => {
    test('新 key ⇒ 插入 prepared 行，随后走完整条链落 committed', async () => {
      const provider = makeProvider()
      const receipt = await applyResourceBundle(depsOf(harness.db), {
        bundle: bundleOf([agentCreate('a')]),
        provider,
      })
      const row = await journalRow(harness.db, 'package', provider.idempotencyKey.key)
      expect(row?.state).toBe('committed')
      expect(row?.id).toBe(receipt.journalId)
    })

    test('claimInTx 抛错 ⇒ 整笔回滚，journal 行零可见（同步事务改异步后仍原子）', async () => {
      const provider = makeProvider({
        claimInTx: () => {
          throw new Error('claim-scenario-check-failed')
        },
      })
      await expect(
        applyResourceBundle(depsOf(harness.db), { bundle: bundleOf([]), provider }),
      ).rejects.toThrow('claim-scenario-check-failed')
      // 插入语句排在 claimInTx **之后**，所以「没有行」也可能只是没跑到；
      // 真正的判据是：这个 key 之后还能被一次干净的 apply 认领（没有半截行挡路）。
      expect(await journalRow(harness.db, 'package', provider.idempotencyKey.key)).toBeUndefined()
      const retry = await applyResourceBundle(depsOf(harness.db), {
        bundle: bundleOf([]),
        provider: makeProvider({ idempotencyKey: provider.idempotencyKey }),
      })
      expect(retry.applied).toEqual([])
      expect((await journalRow(harness.db, 'package', provider.idempotencyKey.key))?.state).toBe(
        'committed',
      )
    })

    test('committed 重放 ⇒ 原 receipt（duplicate 查询先于一切业务校验）', async () => {
      const key = ulid()
      const receipt: BundleReceipt = {
        journalId: 'seeded',
        applied: [
          { opId: 'op-a', resourceType: 'agent', resourceId: 'ag1', action: 'create', name: 'a' },
        ],
      }
      await seedJournal(harness.db, {
        key,
        state: 'committed',
        receiptJson: JSON.stringify(receipt),
      })
      const replayed = await applyResourceBundle(depsOf(harness.db), {
        bundle: bundleOf([agentCreate('a')]),
        provider: makeProvider({ idempotencyKey: { scope: 'package', key } }),
      })
      expect(replayed).toEqual(receipt)
    })

    test('failed 重放 ⇒ bundle-apply-failed-replay', async () => {
      const key = ulid()
      await seedJournal(harness.db, { key, state: 'failed', error: 'boom' })
      const err = await applyResourceBundle(depsOf(harness.db), {
        bundle: bundleOf([]),
        provider: makeProvider({ idempotencyKey: { scope: 'package', key } }),
      }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      )
      expect(err?.code).toBe('bundle-apply-failed-replay')
    })

    test('prepared 重放 ⇒ bundle-apply-unsettled（未结的一次尝试，拒绝而不是猜）', async () => {
      const key = ulid()
      await seedJournal(harness.db, { key, state: 'prepared' })
      const err = await applyResourceBundle(depsOf(harness.db), {
        bundle: bundleOf([]),
        provider: makeProvider({ idempotencyKey: { scope: 'package', key } }),
      }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      )
      expect(err?.code).toBe('bundle-apply-unsettled')
    })
  })

  // ── ② recordArtifact（I14 record-before-act） ───────────────────────────
  describe('② recordArtifact：journal 落库先于副作用', () => {
    test('recordArtifact 返回时 artifact 已经在库里（调用方 await 了它）', async () => {
      const provider = makeProvider()
      // 收进数组而不是 `let x: T | null`：赋值发生在回调里，TS 的控制流分析看不见它，
      // 断言处会把变量窄化成 `null` 并报 TS2769。
      const seenDuringPrestage: BundleArtifact[][] = []
      const artifact: BundleArtifact = {
        kind: 'plugin-install',
        pluginId: 'pl1',
        generationId: 'g1',
        generationDir: '/nonexistent/g1',
      }
      await applyResourceBundle(
        depsOf(harness.db, {
          resourcePackageMutations: stubRuntimeFactory({
            onPrestage: async (recordArtifact) => {
              await recordArtifact(artifact)
              // 副作用（npm 安装 / 技能暂存）就发生在这一行的位置：此刻 journal
              // 必须已经带着足以补偿它的信息。漏掉调用方的 await 时这里读到的是 `[]`。
              const row = await journalRow(harness.db, 'package', provider.idempotencyKey.key)
              seenDuringPrestage.push(
                JSON.parse(row?.preparedArtifactsJson ?? '[]') as BundleArtifact[],
              )
            },
          }),
        }),
        { bundle: bundleOf([agentCreate('a')]), provider },
      )
      expect(seenDuringPrestage).toEqual([[artifact]])
    })
  })

  // ── ③ settleFailed ─────────────────────────────────────────────────────
  describe('③ settleFailed：pre-commit 失败 ⇒ journal 终态化', () => {
    test('big tx 之前抛错 ⇒ journal failed 且 error 带原因，原错误照抛', async () => {
      const provider = makeProvider()
      await expect(
        applyResourceBundle(
          depsOf(harness.db, {
            faults: {
              beforeTx: () => {
                throw new Error('staging exploded')
              },
            },
          }),
          { bundle: bundleOf([agentCreate('a')]), provider },
        ),
      ).rejects.toThrow('staging exploded')
      const row = await journalRow(harness.db, 'package', provider.idempotencyKey.key)
      expect(row?.state).toBe('failed')
      expect(row?.error).toContain('staging exploded')
    })
  })

  // ── ④ 收敛 CAS ─────────────────────────────────────────────────────────
  describe('④ 收敛 CAS：判据挂在 state 上，active 行不得被收割', () => {
    test('陈旧 prepared 行 ⇒ 收成 failed，计数为 1', async () => {
      const key = ulid()
      await seedJournal(harness.db, {
        key,
        state: 'prepared',
        updatedAt: Date.now() - CONVERGE_MIN_AGE_MS - 60_000,
      })
      const out = await convergeResourceBundleApplies(
        harness.db as unknown as DbClient,
        '/nonexistent/aw-rfc359-w7',
      )
      expect(out.failed).toBe(1)
      const row = await journalRow(harness.db, 'package', key)
      expect(row?.state).toBe('failed')
      expect(row?.error).toBe('converged: crashed before commit')
    })

    test('10 分钟下限内的 prepared 行 ⇒ 不收割', async () => {
      const key = ulid()
      await seedJournal(harness.db, { key, state: 'prepared', updatedAt: Date.now() })
      const out = await convergeResourceBundleApplies(
        harness.db as unknown as DbClient,
        '/nonexistent/aw-rfc359-w7',
      )
      expect(out.failed).toBe(0)
      expect((await journalRow(harness.db, 'package', key))?.state).toBe('prepared')
    })

    test('activeApplyIds 命中的陈旧行 ⇒ 不收割（正在跑，不是崩溃残留）', async () => {
      const key = ulid()
      const id = await seedJournal(harness.db, {
        key,
        state: 'applying',
        updatedAt: Date.now() - CONVERGE_MIN_AGE_MS - 60_000,
      })
      const out = await convergeResourceBundleApplies(
        harness.db as unknown as DbClient,
        '/nonexistent/aw-rfc359-w7',
        undefined,
        { activeApplyIds: [id] },
      )
      expect(out.failed).toBe(0)
      expect((await journalRow(harness.db, 'package', key))?.state).toBe('applying')
    })

    test('committed 行 ⇒ 只重放幂等尾，状态不变、不计入 failed', async () => {
      const key = ulid()
      await seedJournal(harness.db, {
        key,
        state: 'committed',
        receiptJson: JSON.stringify({ journalId: 'x', applied: [] }),
        updatedAt: Date.now() - CONVERGE_MIN_AGE_MS - 60_000,
      })
      const out = await convergeResourceBundleApplies(
        harness.db as unknown as DbClient,
        '/nonexistent/aw-rfc359-w7',
      )
      expect(out).toEqual({ failed: 0, rolledForward: 1 })
      expect((await journalRow(harness.db, 'package', key))?.state).toBe('committed')
    })
  })
})
