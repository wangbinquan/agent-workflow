// RFC-359 W9 —— Intent apply 的 9 笔 **journal 事务**从 bun:sqlite 独有的同步 `dbTxSync`
// 切到中立事务原语（`databaseSessionFor(db).transaction`）之后的行为锁。
//
// # 为什么这些用例存在
//
// 这是**行为改动**，不是纯搬运。`dbTxSync` 的事务体在类型层就不许 `await`（RFC-093 把 Promise
// 回调塌成 `never`），整笔写落在同一个 tick 里；换成中立原语后事务体可以 `await`，于是
// 「中间态会不会被别人看见」「调用方有没有等这一笔落库」都成了真问题。九个站点分三类：
//
//   ① claim（1 笔，唯一的多语句事务）—— 四道读判据 + journal 认领必须同生共死。
//   ② apply 期的三笔单语句写 —— recordArtifact（I14 record-before-act）/ settleFailed /
//      keepRetryable。它们的判据不是「最终一致」，而是「`apply()` 落地时**已经**落库」：
//      调用方漏掉 await 时，行会在 reject 之后才出现，既有的「事后读一次」断言全绿。
//   ③ 收敛的五笔 —— 解码失败写回 / 补偿未完成写回 / 收割 CAS / committed 清错 /
//      committed 前滚未完成写回。CAS 判据从 `.run().changes` 换成中立的 `affectedRows`。
//
// 顺带把大事务体内的四条裸 `.run()` 也改成了 `await`（它们不是 `dbTxSync` 调用点，不进
// 高水位账本，但它们是 bun:sqlite 独有的同步执行面：drizzle 的查询构建器是**惰性**的
// `QueryPromise`，`.run()` 当场执行、`await` 也当场执行，而**既不 `.run()` 也不 `await`**
// 的写在两个引擎上都一条都不会发生。CAS 那条更毒——PG 上 `.run()` 回的是没被 await 的
// Promise，`changes` 恒为 undefined，判据静默失真）。
//
// # 为什么两个引擎各跑一遍
//
// 切换之后这个编排层**整体是 provider 中立的**：claim / 大事务 / 收敛的每一条语句都只用
// 中立查询面（无 `.get()` / `.run()`），CAS 走 `affectedRows`。锁死在 SQLite 上的只剩注入
// 进来的**资源会话**（legacy RC 的六条同步提交臂），本文件用替身把它挡在外面——于是
// `applyIntentChangeset` / `convergeIntentApplyJournal` 这两个「SQLite 命名」的函数在
// PostgreSQL 上照跑，这本身就是切换成功的判据。漏一个 await 时 SQLite 侧往往照样绿
// （同步驱动的 thenable 在微任务里当场 resolve），**只有 PG 才炸**——所以双引擎是判据的一半。
//
// 生产链的 I14 兜底（`legacyIntentApplyResourceParticipants.ts` 的三处 `await
// context.recordArtifact`）是源码层文本断言：漏掉 await 不会让任何既有测试变红，
// 而 `bun run lint:promises` 挡得住裸调用、挡不住显式 `void`。

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  INTENT_CHANGESET_SCHEMA_VERSION,
  canonicalIntentJson,
  parseIntentChangeset,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  users,
} from '@/db/schema'
import type { IntentJournalArtifactV1 } from '@/modules/intent/domain/journalArtifacts'
import {
  applyIntentChangeset,
  convergeIntentApplyJournal,
  type ApplyIntentFaults,
  type ApplyIntentInput,
  type IntentApplyReceipt,
  type IntentApplyResourceSession,
} from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { Logger } from '@/util/log'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

// ─────────────────────────────────────────────────────────────────────────────
// I14 的生产链兜底（源码层文本断言）
// ─────────────────────────────────────────────────────────────────────────────

const PRESTAGE_ADAPTER = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'aggregateAdapters',
  'legacyIntentApplyResourceParticipants.ts',
)

describe('I14 record-before-act —— Intent 生产 prestage 链的每一处 recordArtifact 都必须 await', () => {
  test('legacyIntentApplyResourceParticipants.ts 里没有未 await 的 recordArtifact', () => {
    const source = readFileSync(PRESTAGE_ADAPTER, 'utf8')
    const calls = [...source.matchAll(/(\S*\s*)context\.recordArtifact\(/g)]
    expect(
      calls.length,
      '语料失效：适配器里一处 recordArtifact 调用都没扫到',
    ).toBeGreaterThanOrEqual(3)
    for (const call of calls) {
      expect(
        call[1],
        'recordArtifact 必须写成 `await context.recordArtifact(...)`；丢掉 await（含显式 ' +
          '`void`）会让副作用跑在 journal 落库之前，而既有测试不会红',
      ).toBe('await ')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'user_rfc359_w9_apply_owner'
const STALE_MS = 11 * 60 * 1000

const actor: Actor = {
  user: {
    id: OWNER,
    username: 'w9-owner',
    displayName: 'W9 owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}
const authority = Object.freeze({}) as ResourceRequestContext

const ARTIFACT: IntentJournalArtifactV1 = Object.freeze({
  kind: 'plugin-install',
  pluginId: 'w9-plugin',
  generationId: 'w9-gen',
  generationDir: '/tmp/w9-plugin/w9-gen',
})

function silentLog(): Logger {
  const log: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return log
    },
  }
  return log
}

function changeset(name: string) {
  return {
    $schema_version: INTENT_CHANGESET_SCHEMA_VERSION,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'agent',
        tempRef: '$new:worker',
        payload: {
          name,
          description: 'w9 cutover worker',
          outputs: ['out'],
          skills: [],
          mcp: [],
          plugins: [],
          dependsOn: [],
          bodyMd: 'You work.',
        },
      },
    ],
  }
}

interface SessionFixture {
  readonly sessionId: string
  readonly draftId: string
  readonly draftRevision: number
  readonly draftHash: string
}

async function seedSession(harness: ProviderHarness, name: string): Promise<SessionFixture> {
  const now = Date.now()
  const sessionId = ulid()
  const draftId = ulid()
  await harness.db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER,
    title: 'RFC-359 W9 apply',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof intentSessions.$inferInsert)

  const parsed = parseIntentChangeset(JSON.stringify(changeset(name)))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  await harness.db.insert(intentDrafts).values({
    id: draftId,
    sessionId,
    revision: 1,
    changesetJson: canonical,
    validationJson: '{"errors":[],"credentialFindings":[]}',
    draftHash,
    contextRevision: 0,
    createdAt: now,
  } as typeof intentDrafts.$inferInsert)
  await harness.db
    .update(intentSessions)
    .set({ currentDraftId: draftId })
    .where(eq(intentSessions.id, sessionId))
  return { sessionId, draftId, draftRevision: 1, draftHash }
}

function command(fixture: SessionFixture, clientMutationId = ulid()): ApplyIntentInput {
  return {
    sessionId: fixture.sessionId,
    clientMutationId,
    draftRevision: fixture.draftRevision,
    draftHash: fixture.draftHash,
    decisions: [],
  }
}

async function journalRows(harness: ProviderHarness, sessionId: string) {
  return await harness.db
    .select()
    .from(intentApplyJournal)
    .where(eq(intentApplyJournal.sessionId, sessionId))
}

async function journalRow(harness: ProviderHarness, journalId: string) {
  const [row] = await harness.db
    .select()
    .from(intentApplyJournal)
    .where(eq(intentApplyJournal.id, journalId))
    .limit(1)
  return row
}

async function seedJournal(
  harness: ProviderHarness,
  fixture: SessionFixture,
  input: {
    readonly state: 'prepared' | 'applying' | 'committed'
    readonly preparedArtifactsJson: string
    readonly error?: string
  },
): Promise<string> {
  const id = ulid()
  const at = Date.now() - STALE_MS
  await harness.db.insert(intentApplyJournal).values({
    id,
    sessionId: fixture.sessionId,
    clientMutationId: ulid(),
    draftId: fixture.draftId,
    draftHash: fixture.draftHash,
    state: input.state,
    preparedArtifactsJson: input.preparedArtifactsJson,
    receiptJson:
      input.state === 'committed'
        ? JSON.stringify({ journalId: id, commitSeq: 1, applied: [] })
        : null,
    error: input.error ?? null,
    createdAt: at,
    updatedAt: at,
  } as typeof intentApplyJournal.$inferInsert)
  return id
}

interface PortOptions {
  /** prestage 期登记的工件（record-then-act 的可观测锚点）。 */
  readonly artifact?: IntentJournalArtifactV1
  /** prestage 里、recordArtifact **返回之后**跑的钩子——I14 的观测点。 */
  readonly afterRecord?: () => Promise<void>
  readonly faults?: ApplyIntentFaults
  readonly compensate?: (artifact: unknown) => Promise<void>
  readonly rollForward?: () => Promise<boolean>
}

interface ApplyPort {
  apply(input: ApplyIntentInput): Promise<IntentApplyReceipt>
  converge(options?: {
    readonly activeJournalIds?: readonly string[]
  }): Promise<{ failed: number; rolledForward: number }>
  readonly prestaged: () => number
}

/**
 * 生产装配的那条 apply 编排，资源会话换成替身。替身把 SQLite 专属的六条同步提交臂挡在外面，
 * 于是剩下的编排层（claim / 三笔写 / 大事务 / 收敛）在两个引擎上跑的是**同一段代码**。
 */
function applyPortFor(
  harness: ProviderHarness,
  appHome: string,
  options: PortOptions = {},
): ApplyPort {
  let prestaged = 0
  const session: IntentApplyResourceSession = {
    async preflight() {
      return Object.freeze({
        occupiedNames: new Map(),
        copyOnlyTargets: new Map<string, string>(),
      })
    },
    async prepare() {},
    async prestage(_plan, context) {
      prestaged += 1
      if (options.artifact !== undefined) await context.recordArtifact(options.artifact)
      if (options.afterRecord !== undefined) await options.afterRecord()
    },
    participantInTransaction() {
      return {
        authorizeAndCommit: async () => ({
          kind: 'agent',
          operationId: 'op-1',
          resourceId: 'r',
          action: 'create',
          revision: {},
        }),
      } as never
    },
    broadcastCommitted() {},
  }
  const artifacts = {
    compensate: options.compensate ?? (async () => {}),
    rollForward: options.rollForward ?? (async () => true),
  }
  const db = harness.db as DbClient
  return {
    apply: (input) =>
      applyIntentChangeset(
        {
          db,
          appHome,
          actor,
          authority,
          resourceApply: { createSession: () => session },
          artifacts: artifacts as never,
          log: silentLog(),
          ...(options.faults === undefined ? {} : { faults: options.faults }),
        },
        { ...input, decisions: [...input.decisions] },
      ),
    converge: (convergeOptions) =>
      convergeIntentApplyJournal(db, artifacts as never, silentLog(), convergeOptions ?? {}),
    prestaged: () => prestaged,
  }
}

let appHome: string

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w9-apply-'))
})

afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describeEachProvider('RFC-359 W9 Intent apply 同步事务切换', (harness) => {
  beforeEach(async () => {
    const now = Date.now()
    await harness.db.insert(users).values({
      id: OWNER,
      username: 'w9-owner',
      displayName: 'W9 owner',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as typeof users.$inferInsert)
  })

  // ── ① claim（唯一的多语句 journal 事务）────────────────────────────────────

  test('claim 事务：认领成功 ⇒ 恰好一行 prepared，随后整条管线提交', async () => {
    const fixture = await seedSession(harness, 'w9-claim-ok')
    const port = applyPortFor(harness, appHome)

    const receipt = await port.apply(command(fixture))

    const rows = await journalRows(harness, fixture.sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(receipt.journalId)
    expect(rows[0]?.state).toBe('committed')
    expect(JSON.parse(rows[0]?.receiptJson ?? 'null')).toEqual(receipt)

    // 大事务体内那四条从 `.run()` 改成 `await` 的写：不 await 的惰性 QueryPromise 一条都不会
    // 发生，所以 provenance 行 / 会话代次关闭同时也是那条改动的判据。
    const provenance = await harness.db
      .select()
      .from(intentProvenance)
      .where(eq(intentProvenance.commitId, receipt.journalId))
    expect(provenance).toHaveLength(1)
    const [session] = await harness.db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, fixture.sessionId))
      .limit(1)
    expect(session?.commitSeq).toBe(1)
    expect(session?.currentDraftId).toBeNull()
  })

  test('claim 事务的原子性：认领之后抛 ⇒ journal 整笔回滚，零行残留', async () => {
    const fixture = await seedSession(harness, 'w9-claim-rollback')
    const port = applyPortFor(harness, appHome, {
      faults: {
        inClaimTxAfterJournal() {
          throw new Error('crash inside the claim transaction')
        },
      },
    })

    await expect(port.apply(command(fixture))).rejects.toThrow('crash inside the claim transaction')
    // 认领行必须随事务一起消失：留下来的话这个 clientMutationId 会永远重放一个不存在的收据。
    expect(await journalRows(harness, fixture.sessionId)).toEqual([])
    // 抛在 claim 里 ⇒ 一次资源动作都没发生。
    expect(port.prestaged()).toBe(0)
  })

  test('claim 事务的读侧：同一个 clientMutationId 重放收据且不新增行', async () => {
    const fixture = await seedSession(harness, 'w9-claim-replay')
    const port = applyPortFor(harness, appHome)
    const mutationId = ulid()

    const first = await port.apply(command(fixture, mutationId))
    const second = await port.apply(command(fixture, mutationId))

    expect(second).toEqual(first)
    expect(await journalRows(harness, fixture.sessionId)).toHaveLength(1)
    // 重放在 claim 那一笔事务里就返回：prestage 只跑过第一次。
    expect(port.prestaged()).toBe(1)
  })

  // ── ② apply 期的三笔单语句写 ───────────────────────────────────────────────

  test('recordArtifact：I14 record-before-act —— 登记返回时工件**已经**落库', async () => {
    const fixture = await seedSession(harness, 'w9-record-before-act')
    let seenDuringPrestage: string | null = null
    const port = applyPortFor(harness, appHome, {
      artifact: ARTIFACT,
      afterRecord: async () => {
        const [row] = await journalRows(harness, fixture.sessionId)
        seenDuringPrestage = row?.preparedArtifactsJson ?? null
      },
    })

    await port.apply(command(fixture))

    // 判据是「登记 await 返回的那一刻」的库内状态，不是 apply 结束后的最终状态——
    // 漏掉 await 时后者照样对（写最终会落库），前者是 '[]'，而崩溃窗口里可见的正是前者。
    expect(seenDuringPrestage).not.toBeNull()
    expect(JSON.parse(seenDuringPrestage ?? 'null')).toEqual({
      version: 1,
      artifacts: [ARTIFACT],
    })
  })

  test('settleFailed：提交前失败 ⇒ apply 落地时 journal **已经**是 failed', async () => {
    const fixture = await seedSession(harness, 'w9-settle-failed')
    const compensated: unknown[] = []
    const port = applyPortFor(harness, appHome, {
      artifact: ARTIFACT,
      compensate: async (artifact) => {
        compensated.push(artifact)
      },
      faults: {
        beforeTx() {
          throw new Error('boom before the big transaction')
        },
      },
    })

    await expect(port.apply(command(fixture))).rejects.toThrow('boom before the big transaction')
    expect(compensated).toEqual([ARTIFACT])
    const [row] = await journalRows(harness, fixture.sessionId)
    expect(row?.state).toBe('failed')
    expect(row?.error).toContain('boom before the big transaction')
  })

  test('keepRetryable：补偿失败 ⇒ apply 落地时说明**已经**写回，行不终态化', async () => {
    const fixture = await seedSession(harness, 'w9-keep-retryable')
    const port = applyPortFor(harness, appHome, {
      artifact: ARTIFACT,
      compensate: async () => {
        throw new Error('cleanup unavailable')
      },
      faults: {
        beforeTx() {
          throw new Error('boom')
        },
      },
    })

    await expect(port.apply(command(fixture))).rejects.toThrow('boom')
    const [row] = await journalRows(harness, fixture.sessionId)
    expect(row?.state).toBe('prepared')
    expect(row?.error).toBe(
      'retryable after apply error: boom; compensation incomplete: cleanup unavailable',
    )
  })

  // ── 大事务的 CAS（`.run().changes` → `affectedRows`）───────────────────────

  test('大事务 CAS：认领在 prestage 期间被抢走 ⇒ intent-apply-unsettled', async () => {
    const fixture = await seedSession(harness, 'w9-cas-lost')
    const port = applyPortFor(harness, appHome, {
      afterRecord: async () => {
        // 把 journal 挪出 'prepared'：大事务的 prepared→applying CAS 于是命中 0 行。
        await harness.db
          .update(intentApplyJournal)
          .set({ state: 'failed' })
          .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
      },
    })

    await expect(port.apply(command(fixture))).rejects.toThrow('journal claim lost')
  })

  // ── ③ 收敛的五笔 ──────────────────────────────────────────────────────────

  test('收敛①：工件列解不开 ⇒ 写回 retryable 说明且绝不终态化', async () => {
    const fixture = await seedSession(harness, 'w9-converge-corrupt')
    const port = applyPortFor(harness, appHome)
    const journalId = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: 'not json at all',
    })

    expect(await port.converge()).toEqual({ failed: 0, rolledForward: 0 })
    const row = await journalRow(harness, journalId)
    expect(row?.state).toBe('prepared')
    expect(row?.error).toStartWith('retryable: artifact decode failed:')
  })

  test('收敛②：补偿未完成 ⇒ 写回 retryable 说明，行留在原状态', async () => {
    const fixture = await seedSession(harness, 'w9-converge-compensation')
    const port = applyPortFor(harness, appHome, {
      compensate: async () => {
        throw new Error('cleanup unavailable')
      },
    })
    const journalId = await seedJournal(harness, fixture, {
      state: 'applying',
      preparedArtifactsJson: JSON.stringify([ARTIFACT]),
    })

    expect(await port.converge()).toEqual({ failed: 0, rolledForward: 0 })
    const row = await journalRow(harness, journalId)
    expect(row?.state).toBe('applying')
    expect(row?.error).toBe('retryable: compensation incomplete: cleanup unavailable')
  })

  test('收敛③：收割 CAS 恰好一行 ⇒ 计数 1；再收一次幂等（affectedRows 判据）', async () => {
    const fixture = await seedSession(harness, 'w9-converge-cas')
    const compensated: unknown[] = []
    const port = applyPortFor(harness, appHome, {
      compensate: async (artifact) => {
        compensated.push(artifact)
      },
    })
    const journalId = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: JSON.stringify([ARTIFACT]),
    })

    // `affectedRows` 缺失按 0 计：判据失真时这里会读到 0，计数直接对不上。
    expect(await port.converge()).toEqual({ failed: 1, rolledForward: 0 })
    expect(compensated).toEqual([ARTIFACT])
    const row = await journalRow(harness, journalId)
    expect(row?.state).toBe('failed')
    expect(row?.error).toBe('daemon-restart before commit')

    expect(await port.converge()).toEqual({ failed: 0, rolledForward: 0 })
  })

  test('收敛③b：活跃 / 未过下限的行不被收割（CAS 之前的两道闸）', async () => {
    const fixture = await seedSession(harness, 'w9-converge-active')
    const port = applyPortFor(harness, appHome)
    const journalId = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: '[]',
    })

    expect(await port.converge({ activeJournalIds: [journalId] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect((await journalRow(harness, journalId))?.state).toBe('prepared')
  })

  test('收敛④：committed 前滚完成 ⇒ 清掉旧的 retryable 说明', async () => {
    const fixture = await seedSession(harness, 'w9-converge-clear')
    const port = applyPortFor(harness, appHome, { rollForward: async () => true })
    const journalId = await seedJournal(harness, fixture, {
      state: 'committed',
      preparedArtifactsJson: JSON.stringify([ARTIFACT]),
      error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
    })

    expect(await port.converge()).toEqual({ failed: 0, rolledForward: 1 })
    const row = await journalRow(harness, journalId)
    expect(row?.state).toBe('committed')
    expect(row?.error).toBeNull()
  })

  test('收敛⑤：committed 前滚未完成 ⇒ 写回 retryable 说明，行留 committed', async () => {
    const fixture = await seedSession(harness, 'w9-converge-incomplete')
    const port = applyPortFor(harness, appHome, { rollForward: async () => false })
    const journalId = await seedJournal(harness, fixture, {
      state: 'committed',
      preparedArtifactsJson: JSON.stringify([ARTIFACT]),
    })

    expect(await port.converge()).toEqual({ failed: 0, rolledForward: 0 })
    const row = await journalRow(harness, journalId)
    expect(row?.state).toBe('committed')
    expect(row?.error).toBe(
      'retryable: committed roll-forward incomplete; inspect intent apply logs',
    )
  })
})
