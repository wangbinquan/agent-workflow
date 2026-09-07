// RFC-359 W7 —— Intent apply **编排**（`IntentApplyOperations`）的双引擎对拍。
//
// # 为什么是对拍而不是「合一后的回归」
//
// `sqliteIntentApplyOperations.ts`(706) / `postgresqlIntentApplyOperations.ts`(541) 的**管线骨架**
// 确实是同一套：claim → preflight → prepare → 图校验 → prestage → 大事务 → 前滚 → 收敛，
// 判据也早已搬进共享的 `domain/applyClaim` / `application/{applyCommitPlan,journalConvergence,…}`。
// 但两份挂的是**两套不同的资源会话协议**，而那两套协议背后是两套不同的技能 / 插件暂存机制：
//
//                       SQLite（legacy RC 会话）        PostgreSQL（PG RC 会话）
//   提交期句柄          participantInTransaction        createTransactionAttempt → {participant, commitSucceeded}
//   提交后资源尾巴      —                                rollForwardCommitted()
//   资源侧中止          —（补偿全靠 journal 工件）       abortPrepared({databaseCommitted})
//   工件词汇            IntentJournalArtifactV1          PostgresqlIntentApplyArtifact
//   工件信封            {"version":1,"artifacts":[…]}    裸数组 […]
//   id / now 注入       无（直接 ulid / Date.now）       有
//
// （原表还有一行「recordArtifact 同步 / 异步」——RFC-359 W9 把 SQLite 侧的 9 笔 journal 事务
// 迁到中立事务原语之后两侧都是 `Promise<void>`，那一行消失了。判据见
// `tests/rfc359-w9-intent-apply-sync-transaction-cutover.test.ts`。）
//
// 于是本文件只把**两侧真正同义的那部分**做成一份 body 在两个引擎上各跑一遍（A 段），
// 把实测出来的分叉逐条钉成显式断言（B 段）。A 段是「合一时不能退化的」，B 段是「合一会抹掉的」。
//
// # B 段只收「协议不同」，不收「一侧更弱」（RFC-359 W7 抬齐）
//
// 上表每一行都是**两套资源会话协议**的后果，删不掉。但对拍第一轮还照出两条**与协议无关**的
// 分叉——一侧单纯少做了一件两侧都做得到的事，本轮已按强侧抬齐并搬进 A 段：
//   · 提交后前滚未完成的**写回**：SQLite 丢掉了 `rollForward` 的返回值（PG 当场写回），
//     那一行看上去干干净净，要等 boot/hourly 收敛才第一次被看见；
//   · 留下 retryable 时的**诊断词**：`intent-left-retryable` 只有 SQLite 记，
//     运维在 PostgreSQL 部署上 grep 同一类失败搜不到。
// 判据是：分叉能不能只用「两侧都已有的东西」抹平。能，就是弱侧欠账，抬齐后进 A 段；
// 不能（要给一侧凭空造一套机制），才是 B 段。
//
// 资源会话在两侧都是**注入的接口**，所以这里用替身驱动真实管线：测的是 intent 的编排，
// 不是 resource-catalog 的六条提交臂。

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
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
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
  users,
} from '@/db/schema'
import type {
  IntentApplyInput,
  IntentApplyReceipt,
} from '@/modules/intent/application/ports/intentApplyOperations'
import type { IntentJournalArtifactV1 } from '@/modules/intent/domain/journalArtifacts'
import {
  applyIntentChangeset,
  convergeIntentApplyJournal,
  type ApplyIntentFaults,
  type IntentApplyResourceSession,
} from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'
import { createPostgresqlIntentApplyOperations } from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import type { PostgresqlIntentApplyResourceSession } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { Logger } from '@/util/log'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'user_rfc359_w7_apply_owner'
const STALE_MS = 11 * 60 * 1000

const actor: Actor = {
  user: {
    id: OWNER,
    username: 'w7-owner',
    displayName: 'W7 owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}
const authority = Object.freeze({}) as ResourceRequestContext

function recordingLog(): { readonly log: Logger; readonly warnings: () => readonly string[] } {
  const warnings: string[] = []
  const log: Logger = {
    debug() {},
    info() {},
    warn(message) {
      warnings.push(message)
    },
    error() {},
    child() {
      return log
    },
  }
  return { log, warnings: () => warnings }
}

const AGENT_ARTIFACT: IntentJournalArtifactV1 = Object.freeze({
  kind: 'plugin-install',
  pluginId: 'w7-plugin',
  generationId: 'w7-gen',
  generationDir: '/tmp/w7-plugin/w7-gen',
})

/** 一份最小的合法 changeset：单个 agent create，无 slot / 无 secret / 无 update fence。 */
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
          description: 'w7 conformance worker',
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
    title: 'RFC-359 W7 apply',
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

function command(fixture: SessionFixture, clientMutationId = ulid()): IntentApplyInput {
  return {
    sessionId: fixture.sessionId,
    clientMutationId,
    draftRevision: fixture.draftRevision,
    draftHash: fixture.draftHash,
    decisions: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 资源会话替身 + 每引擎的 apply 端口
// ─────────────────────────────────────────────────────────────────────────────

interface ResourceCalls {
  preflight: number
  prepare: number
  prestage: number
  commit: number
  broadcast: number
  /** PG 独有：提交后资源尾巴 / 资源侧中止。SQLite 会话没有这两个方法。 */
  rollForwardCommitted: number
  abortPrepared: Array<{ readonly databaseCommitted: boolean }>
}

function emptyCalls(): ResourceCalls {
  return {
    preflight: 0,
    prepare: 0,
    prestage: 0,
    commit: 0,
    broadcast: 0,
    rollForwardCommitted: 0,
    abortPrepared: [],
  }
}

interface ArtifactStub {
  compensate(artifact: unknown): Promise<void>
  rollForward(artifacts: readonly unknown[], log: Logger): Promise<boolean>
}

interface ApplyHarnessOptions {
  /** prestage 期要登记的工件（record-then-act 的可观测锚点）。 */
  readonly artifact?: IntentJournalArtifactV1
  readonly faults?: ApplyIntentFaults
  /** 工件生命周期替身；缺省是「补偿成功 / 前滚完成」。 */
  readonly compensate?: (artifact: unknown) => Promise<void>
  readonly rollForward?: (artifacts: readonly unknown[]) => Promise<boolean>
}

interface ApplyPort {
  apply(input: IntentApplyInput, log?: Logger): Promise<IntentApplyReceipt>
  converge(
    log: Logger,
    options?: { readonly activeJournalIds?: readonly string[] },
  ): Promise<{ failed: number; rolledForward: number }>
  readonly calls: ResourceCalls
}

/** 本引擎在生产上真正装配的那一套 apply 编排。 */
function applyPortFor(harness: ProviderHarness, options: ApplyHarnessOptions = {}): ApplyPort {
  const calls = emptyCalls()
  const artifacts: ArtifactStub = {
    compensate: options.compensate ?? (async () => {}),
    rollForward: options.rollForward ?? (async () => true),
  }
  const preflight = async () => {
    calls.preflight += 1
    return Object.freeze({
      occupiedNames: new Map(),
      copyOnlyTargets: new Map<string, string>(),
    })
  }
  const prepare = async () => {
    calls.prepare += 1
  }
  const commitReceipt = () => {
    calls.commit += 1
    return { kind: 'agent', operationId: 'op-1', resourceId: 'r', action: 'create', revision: {} }
  }

  if (harness.capabilities.provider === 'postgresql') {
    const session = {
      preflight,
      prepare,
      async prestage(_plan: unknown, context: { recordArtifact(a: unknown): Promise<void> }) {
        calls.prestage += 1
        if (options.artifact !== undefined) await context.recordArtifact(options.artifact)
      },
      createTransactionAttempt() {
        return Object.freeze({
          participant: { authorizeAndCommit: async () => commitReceipt() },
          commitSucceeded() {},
        })
      },
      async rollForwardCommitted() {
        calls.rollForwardCommitted += 1
      },
      async broadcastCommitted() {
        calls.broadcast += 1
      },
      async abortPrepared(input: { readonly databaseCommitted: boolean }) {
        calls.abortPrepared.push(input)
      },
    } as unknown as PostgresqlIntentApplyResourceSession
    const operations = createPostgresqlIntentApplyOperations({
      db: harness.db as PostgresqlDatabaseClient,
      resources: { createSession: () => session },
      artifacts: artifacts as never,
    })
    return {
      async apply(input, log) {
        return await operations.apply({
          actor,
          authority,
          command: input,
          ...(options.faults === undefined ? {} : { faults: options.faults }),
          ...(log === undefined ? {} : { log }),
        })
      },
      converge: (log, convergeOptions) => operations.converge(log, convergeOptions ?? {}),
      calls,
    }
  }

  const session = {
    preflight,
    prepare,
    async prestage(_plan: unknown, context: { recordArtifact(a: unknown): Promise<void> }) {
      calls.prestage += 1
      if (options.artifact !== undefined) await context.recordArtifact(options.artifact)
    },
    participantInTransaction() {
      return { authorizeAndCommit: async () => commitReceipt() }
    },
    broadcastCommitted() {
      calls.broadcast += 1
    },
  } as unknown as IntentApplyResourceSession
  const db = harness.db as DbClient
  return {
    async apply(input, log) {
      return await applyIntentChangeset(
        {
          db,
          appHome,
          actor,
          authority,
          resourceApply: { createSession: () => session },
          artifacts: artifacts as never,
          ...(options.faults === undefined ? {} : { faults: options.faults }),
          ...(log === undefined ? {} : { log }),
        },
        { ...input, decisions: [...input.decisions] },
      )
    },
    converge: (log, convergeOptions) =>
      convergeIntentApplyJournal(db, artifacts as never, log, convergeOptions ?? {}),
    calls,
  }
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
    readonly fresh?: boolean
  },
): Promise<string> {
  const id = ulid()
  const at = input.fresh === true ? Date.now() : Date.now() - STALE_MS
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

let appHome: string

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-apply-'))
})

afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// A. 共同子集：两个引擎必须同义的编排契约
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W7 Intent apply 编排 · 共同子集', (harness) => {
  beforeEach(async () => {
    const now = Date.now()
    await harness.db.insert(users).values({
      id: OWNER,
      username: 'w7-owner',
      displayName: 'W7 owner',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as typeof users.$inferInsert)
  })

  test('happy path：收据、journal committed、provenance、会话代次关闭', async () => {
    const fixture = await seedSession(harness, 'w7-happy')
    const port = applyPortFor(harness)

    const receipt = await port.apply(command(fixture))
    expect(receipt.commitSeq).toBe(1)
    expect(receipt.applied).toEqual([
      {
        opId: 'op-1',
        resourceType: 'agent',
        resourceId: receipt.applied[0]!.resourceId,
        action: 'create',
        fromCopy: false,
        name: 'w7-happy',
      },
    ])
    expect(port.calls).toMatchObject({
      preflight: 1,
      prepare: 1,
      prestage: 1,
      commit: 1,
      broadcast: 1,
    })

    const row = await journalRow(harness, receipt.journalId)
    expect(row?.state).toBe('committed')
    expect(JSON.parse(row?.receiptJson ?? 'null')).toEqual(receipt)
    expect(row?.error).toBeNull()

    const provenance = await harness.db
      .select()
      .from(intentProvenance)
      .where(eq(intentProvenance.commitId, receipt.journalId))
    expect(provenance).toHaveLength(1)
    expect(provenance[0]?.resourceType).toBe('agent')

    const [session] = await harness.db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, fixture.sessionId))
      .limit(1)
    expect(session?.commitSeq).toBe(1)
    expect(session?.currentDraftId).toBeNull()
    expect(session?.contextRevision).toBe(1)
  })

  test('同一个 clientMutationId 重放既有收据，且零副作用', async () => {
    const fixture = await seedSession(harness, 'w7-replay')
    const port = applyPortFor(harness)
    const mutationId = ulid()

    const first = await port.apply(command(fixture, mutationId))
    const before = { ...port.calls }
    const second = await port.apply(command(fixture, mutationId))

    expect(second).toEqual(first)
    // 重放必须在 claim 这一笔事务里就返回：preflight / prepare / prestage / commit 一次都不许再跑。
    expect(port.calls).toMatchObject({
      preflight: before.preflight,
      prepare: before.prepare,
      prestage: before.prestage,
      commit: before.commit,
      broadcast: before.broadcast,
    })
    const rows = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
    expect(rows).toHaveLength(1)
  })

  test('claim 判据的错误优先级：不存在 / hash 不符 / 已被解决', async () => {
    const fixture = await seedSession(harness, 'w7-claim')
    const port = applyPortFor(harness)

    await expect(port.apply({ ...command(fixture), sessionId: ulid() })).rejects.toThrow(
      'intent session not found',
    )
    await expect(port.apply({ ...command(fixture), draftHash: 'sha256:wrong' })).rejects.toThrow(
      'confirmed draft hash does not match',
    )

    await harness.db.insert(intentDraftResolutions).values({
      draftId: fixture.draftId,
      sessionId: fixture.sessionId,
      reason: 'discarded',
      createdAt: Date.now(),
    } as typeof intentDraftResolutions.$inferInsert)
    await expect(port.apply(command(fixture))).rejects.toThrow('can no longer be committed')
    // 三条都在 claim 段拒掉：一次资源动作都不该发生。
    expect(port.calls).toMatchObject({ preflight: 0, prepare: 0, prestage: 0, commit: 0 })
  })

  test('提交前失败 ⇒ 逆序补偿已登记的工件，journal 落 failed', async () => {
    const fixture = await seedSession(harness, 'w7-fail')
    const compensated: unknown[] = []
    const port = applyPortFor(harness, {
      artifact: AGENT_ARTIFACT,
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
    expect(compensated).toEqual([AGENT_ARTIFACT])

    const [row] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
    expect(row?.state).toBe('failed')
    expect(row?.error).toContain('boom before the big transaction')
    expect(port.calls.commit).toBe(0)
  })

  test('补偿本身失败 ⇒ journal 不终态化，留 retryable 给收敛', async () => {
    const fixture = await seedSession(harness, 'w7-retryable')
    const port = applyPortFor(harness, {
      artifact: AGENT_ARTIFACT,
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
    const [row] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
    // 标成 failed 会让收敛永远跳过残留；行必须留在原状态并说明清理没做完。
    expect(row?.state).toBe('prepared')
    expect(row?.error).toBe(
      'retryable after apply error: boom; compensation incomplete: cleanup unavailable',
    )
  })

  // RFC-359 W7 抬齐②（原 B 段「分叉⑤」）—— 留下 retryable 时的**诊断词汇**。
  //
  // 抬齐前：两侧都把行留在 prepared、都写同一句 error，但只有 SQLite 记
  // `intent-left-retryable`；运维在 PostgreSQL 部署上 grep 同一类失败**什么也搜不到**——
  // 同一件事在一种部署上没有名字。这是可观测性对等，不是新功能，所以词汇必须**逐字相同**
  // （`application/journalConvergence.ts` 的 `INTENT_APPLY_DIAGNOSTICS` 是它的唯一事实源；
  // 近义词不算数——实现门的变异验证换成 `intent-converge-left-retryable` 时本条即红）。
  test('apply 留下 retryable ⇒ 两侧记同一组诊断词（含 intent-left-retryable）', async () => {
    const fixture = await seedSession(harness, 'w7-diagnostics')
    const port = applyPortFor(harness, {
      artifact: AGENT_ARTIFACT,
      compensate: async () => {
        throw new Error('cleanup unavailable')
      },
      faults: {
        beforeTx() {
          throw new Error('boom')
        },
      },
    })

    const recorder = recordingLog()
    await expect(port.apply(command(fixture), recorder.log)).rejects.toThrow('boom')
    expect(recorder.warnings()).toContain('intent-artifact-compensation-failed')
    expect(recorder.warnings()).toContain('intent-left-retryable')
  })

  test('收敛：足够旧的 prepared/applying ⇒ 补偿后落 failed', async () => {
    const fixture = await seedSession(harness, 'w7-converge-reap')
    const compensated: unknown[] = []
    const port = applyPortFor(harness, {
      compensate: async (artifact) => {
        compensated.push(artifact)
      },
    })
    const prepared = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: JSON.stringify([AGENT_ARTIFACT]),
    })

    const recorder = recordingLog()
    expect(await port.converge(recorder.log)).toEqual({ failed: 1, rolledForward: 0 })
    expect(compensated).toEqual([AGENT_ARTIFACT])
    const row = await journalRow(harness, prepared)
    expect(row?.state).toBe('failed')
    expect(row?.error).toBe('daemon-restart before commit')

    // 幂等：再收一次不会重复计数。
    expect(await port.converge(recorder.log)).toEqual({ failed: 0, rolledForward: 0 })
  })

  test('收敛：本进程活跃 / 还太新的行一律放过（P2-1 的两道闸）', async () => {
    const fixture = await seedSession(harness, 'w7-converge-skip')
    const port = applyPortFor(harness)
    const stale = await seedJournal(harness, fixture, {
      state: 'applying',
      preparedArtifactsJson: '[]',
    })
    const fresh = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: '[]',
      fresh: true,
    })

    const recorder = recordingLog()
    expect(await port.converge(recorder.log, { activeJournalIds: [stale] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect((await journalRow(harness, stale))?.state).toBe('applying')
    expect((await journalRow(harness, fresh))?.state).toBe('prepared')
  })

  test('收敛：committed 前滚成功 ⇒ 计数并清掉旧的 retryable 说明', async () => {
    const fixture = await seedSession(harness, 'w7-converge-forward')
    const port = applyPortFor(harness, { rollForward: async () => true })
    const committed = await seedJournal(harness, fixture, {
      state: 'committed',
      preparedArtifactsJson: JSON.stringify([AGENT_ARTIFACT]),
      error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
    })

    expect(await port.converge(recordingLog().log)).toEqual({ failed: 0, rolledForward: 1 })
    const row = await journalRow(harness, committed)
    expect(row?.state).toBe('committed')
    expect(row?.error).toBeNull()
  })

  test('收敛：committed 前滚未完成 ⇒ 行留 committed，写回 retryable 说明', async () => {
    const fixture = await seedSession(harness, 'w7-converge-incomplete')
    const port = applyPortFor(harness, { rollForward: async () => false })
    const committed = await seedJournal(harness, fixture, {
      state: 'committed',
      preparedArtifactsJson: JSON.stringify([AGENT_ARTIFACT]),
    })

    expect(await port.converge(recordingLog().log)).toEqual({ failed: 0, rolledForward: 0 })
    const row = await journalRow(harness, committed)
    expect(row?.state).toBe('committed')
    expect(row?.error).toBe(
      'retryable: committed roll-forward incomplete; inspect intent apply logs',
    )
  })

  // RFC-359 W7 抬齐①（原 B 段「分叉②」）——**提交后**（不是收敛期）前滚未完成的写回。
  //
  // 抬齐前：PG 当场把同一条 retryable 说明写回 journal；SQLite 把 `rollForward` 的返回值
  // 整个丢掉，于是那一行看上去干干净净，「提交成功但尾巴没做完」要等下一次 boot/hourly
  // 收敛才第一次被看见。这不是能力缺口（两侧都有返回值、都有同一条说明文案），是一侧更弱。
  // 判据与上面那条收敛期的写回**逐字相同**——同一件事在 apply 期与收敛期必须留下同一句话。
  test('提交后前滚未完成 ⇒ 行留 committed，当场写回 retryable 说明', async () => {
    const fixture = await seedSession(harness, 'w7-post-commit')
    const port = applyPortFor(harness, {
      artifact: AGENT_ARTIFACT,
      rollForward: async () => false,
    })

    const receipt = await port.apply(command(fixture))
    const row = await journalRow(harness, receipt.journalId)
    expect(row?.state).toBe('committed')
    expect(row?.error).toBe(
      'retryable: committed roll-forward incomplete; inspect intent apply logs',
    )
  })

  test('收敛：工件列解不开 ⇒ 记 intent-journal-artifact-corrupt 且绝不终态化', async () => {
    const fixture = await seedSession(harness, 'w7-converge-corrupt')
    const port = applyPortFor(harness)
    const corrupt = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: 'not json at all',
    })

    const recorder = recordingLog()
    expect(await port.converge(recorder.log)).toEqual({ failed: 0, rolledForward: 0 })
    expect(recorder.warnings()).toContain('intent-journal-artifact-corrupt')
    const row = await journalRow(harness, corrupt)
    expect(row?.state).toBe('prepared')
    expect(row?.error).toStartWith('retryable: artifact decode failed:')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 实测分叉：合一会抹掉的东西
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W7 Intent apply 编排 · 实测分叉', (harness) => {
  beforeEach(async () => {
    const now = Date.now()
    await harness.db.insert(users).values({
      id: OWNER,
      username: 'w7-owner',
      displayName: 'W7 owner',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as typeof users.$inferInsert)
  })

  test('分叉①：journal 的工件信封 —— SQLite 带版本号，PG 是裸数组', async () => {
    const fixture = await seedSession(harness, 'w7-envelope')
    const port = applyPortFor(harness, { artifact: AGENT_ARTIFACT })
    const receipt = await port.apply(command(fixture))
    const stored: unknown = JSON.parse(
      (await journalRow(harness, receipt.journalId))?.preparedArtifactsJson ?? 'null',
    )

    if (harness.capabilities.provider === 'postgresql') {
      // 同一列、同一个恢复凭据，两侧写的是不同的容器：PG 从不写版本号。
      expect(stored).toEqual([AGENT_ARTIFACT])
      return
    }
    expect(stored).toEqual({ version: 1, artifacts: [AGENT_ARTIFACT] })
  })

  // 原「分叉②：提交后前滚未完成」已于 RFC-359 W7 抬齐（SQLite 接住返回值并写回同一条说明），
  // 用例搬进 A 段「提交后前滚未完成 ⇒ 行留 committed，当场写回 retryable 说明」。

  test('分叉③：资源会话的中止 / 提交后尾巴 —— 只有 PG 有', async () => {
    const fixture = await seedSession(harness, 'w7-abort')
    const failing = applyPortFor(harness, {
      faults: {
        beforeTx() {
          throw new Error('boom')
        },
      },
    })
    await expect(failing.apply(command(fixture))).rejects.toThrow('boom')

    const happy = applyPortFor(harness)
    const second = await seedSession(harness, 'w7-abort-ok')
    await happy.apply(command(second))

    if (harness.capabilities.provider === 'postgresql') {
      expect(failing.calls.abortPrepared).toEqual([{ databaseCommitted: false }])
      expect(happy.calls.rollForwardCommitted).toBe(1)
      return
    }
    // SQLite 的 `IntentApplyResourceSession` 根本没有这两个方法：资源侧的补偿全部
    // 压在 journal 工件上，没有「资源会话自己的中止」这一档。
    expect(failing.calls.abortPrepared).toEqual([])
    expect(happy.calls.rollForwardCommitted).toBe(0)
  })

  test('分叉④：收敛的解码宽严不同 —— 同一行，SQLite 判损坏，PG 照常补偿', async () => {
    const fixture = await seedSession(harness, 'w7-decode')
    const compensated: unknown[] = []
    const port = applyPortFor(harness, {
      compensate: async (artifact) => {
        compensated.push(artifact)
      },
    })
    // SQLite 形状的 skill-version-stage：PG 的解码器只看 `kind` 白名单，照收；
    // SQLite 的解码器明确拒收这一形状（不足以安全收敛）。
    const legacyShape = JSON.stringify([
      {
        kind: 'skill-version-stage',
        staged: {
          skillId: 'skill-1',
          skillName: 'skill-one',
          opId: 'op-1',
          publishId: 'publish-1',
          newVersion: 2,
          newHash: 'sha256:fixture',
          filesDir: '/tmp/skill-1/files',
          versionDir: '/tmp/skill-1/versions/v2',
          stagingDir: '/tmp/skill-1/.staged-publish-1',
          noop: null,
        },
      },
    ])
    const journalId = await seedJournal(harness, fixture, {
      state: 'prepared',
      preparedArtifactsJson: legacyShape,
    })

    const recorder = recordingLog()
    const result = await port.converge(recorder.log)
    const row = await journalRow(harness, journalId)

    if (harness.capabilities.provider === 'postgresql') {
      expect(result).toEqual({ failed: 1, rolledForward: 0 })
      expect(compensated).toHaveLength(1)
      expect(row?.state).toBe('failed')
      return
    }
    expect(result).toEqual({ failed: 0, rolledForward: 0 })
    expect(compensated).toEqual([])
    expect(recorder.warnings()).toContain('intent-journal-artifact-corrupt')
    expect(row?.state).toBe('prepared')
  })

  // 原「分叉⑤：apply 留下 retryable 时的诊断词」已于 RFC-359 W7 抬齐（PG 也记
  // `intent-left-retryable`），判据并进 A 段「补偿本身失败 ⇒ … 并记同一组诊断词」。
})
