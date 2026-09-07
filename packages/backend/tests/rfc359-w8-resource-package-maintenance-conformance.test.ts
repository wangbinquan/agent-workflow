// RFC-359 W8 —— `modules/resource-catalog/infrastructure/ResourcePackageMaintenance` 的**双引擎对拍**。
//
// 这一对是「资源包应用的崩溃收敛」：进程在把技能目录 / 插件 generation 落盘的半路上死掉之后，
// 由 `createResourcePackageApplyMaintenanceCommand`（application 层，两侧共用）读 journal、
// 按 `state` 决定 roll-forward 还是补偿 + 结算成 failed。两种端口分别收口：
//
//   · `ResourcePackageApplyJournalPort`（`list` / `settleFailed`）——W12 合一到
//     `resourcePackageApplyJournal.ts`，保留原快照与 expectedState CAS。事务走统一会话，
//     SQLite 写者排队，已有会话中的结算随外层回滚。PG 原来的单条写已经由客户端
//     `withWriteFence` 包在 BEGIN/COMMIT 中；统一事务交出的连接带 transactional 标记，
//     不会再套一层。下面的真库语句录制锁住一次 BEGIN、一次 UPDATE、一次 COMMIT。
//     W8 已在两份旧实现上验证的页面行为继续逐字断言，新增竞争结算与中止回滚。
//   · `ResourcePackageApplyArtifactRecoveryPort`（`rollForward` / `compensate`）——**机制本质不同**，
//     不该合。`prepared_artifacts_json` 这一列被两套互不认识的格式写着（写出点
//     `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts:287` vs
//     `platform/persistence/postgresqlResourcePackageAtomicApply.ts:881`；字段名 `opId`/`generationDir`
//     vs `operationId`/`generationDirectory`，`skill-version-stage` 一个嵌套一个扁平），两侧解码器
//     又都是 zod `.strict()`。这条已由 `tests/architecture/rfc359-w5-artifact-format-portability.test.ts`
//     的 12 格全矩阵钉住（6 格 `rejects`），本文件不重复它。
//
// # 本文件补的是那份矩阵**照不到**的一面：真库上的行为
//
// 格式可移植性矩阵跑的是纯解码（临时目录 + 拒绝数据库访问的 Proxy）。而收敛器真正的用户可见
// 行为——**哪些 journal 行会被收、收完账面变成什么样**——两侧此前**一条跨引擎断言都没有**
// （账本 `rfc359-w5-provider-pair-conformance.test.ts` 记的 `unverified` 就是这个）。这里用
// `describeEachProvider` 在 SQLite 内存库与真 PostgreSQL 上各跑一遍同一批判据，每条判据都用
// **本引擎自己的**工件格式喂本引擎自己的恢复端口，问的是「同一种运维情形，两个引擎给用户的
// 结果一不一样」。
//
// # 对拍在旧实现上照出的一条真差异 —— RFC-359 W10 已合一（判据缺口 13a 销账）
//
// **`committed` 行的回执信封两侧走向相反**：PostgreSQL 侧 `rollForward` 第一步就是
// `parseReceipt`，`receipt_json` 为 NULL 直接抛 `resource-package-committed-receipt-missing`、
// 回执认领的是别的 journal 就抛 `resource-package-committed-receipt-mismatch`；SQLite 侧
// 根本不看回执，照常 roll-forward 并计一次 `rolledForward`——同一行损坏的 journal，
// 一个引擎拒收并留痕、另一个引擎报成功，正是 RFC-359 要消灭的「一个好一个不好」。
//
// **合一形状（不是把 PG 那份搬过来）**：拆成两层。
//   · **信封层**——「committed 就必须带回执，且回执必须认领这一行」——与落盘格式无关，
//     两套格式都只有 `journalId` 一个共同字段。它抽成中立的
//     `modules/resource-catalog/domain/resourcePackageApplyReceipt.ts`
//     （`committedApplyReceiptIssue` 纯判定 + `assertCommittedApplyReceipt` 抛同一组错误码），
//     **两个引擎调同一份**，于是这一层不再有两份实现，也就不会再漂。
//   · **载荷层**——`applied[]` 里逐条工件的匹配——两套格式互不认识（SQLite 写 `opId`、
//     PostgreSQL 写 `operationId`，且 PG 的解码器是 zod `.strict()`），仍各留各的，
//     由 `tests/architecture/rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵管。
//
// **为什么不能直接把 PG 的 `parseReceipt` 搬给 SQLite**（这是本次最贵的一条发现）：
// PG 的 `parseReceipt` 里那句 schema 解析吃的是 **PG 自己的回执格式**，`applied[]` 逐条要求
// `operationId` 且 `.strict()`；而 SQLite 生产写出的回执逐条是 `opId`。照搬 = SQLite 上
// **每一条真实的 committed 回执**都被 zod 拒收，全库的 committed 行当场集体停止 roll-forward。
// 下面「committed 的 plugin-install」与「回执用另一侧的字段名」两条用例按引擎喂**生产真形状**
// 的回执，就是把这条陷阱钉死：谁把载荷层一起搬过去，那两条立刻红。
//
// # 先红后绿（本刀实测）
//
// 补门之前跑这四条：PostgreSQL 全绿，SQLite 在「缺回执」与「回执错配」两条上红成
// `{ failed: 0, rolledForward: 1 }` + `warnings: []`——即账本 13a 写的「回执缺失 / 与 journal
// 错配也照样 roll-forward」。补上中立信封门之后两侧逐字相同。

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { plugins, resourceBundleApplies } from '@/db/schema'
import {
  createResourcePackageApplyMaintenanceCommand,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyJournalPort,
} from '@/modules/resource-catalog/application/resourcePackageMaintenance'
// 两侧实现各值 import 一条：这一对的对拍见证判据锁在这里
// （`tests/architecture/rfc359-w5-provider-pair-conformance.test.ts`），走 composition 的再导出
// 会让这份对拍在账本里看不见。
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '@/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { createResourcePackageApplyJournalPort } from '@/modules/resource-catalog/infrastructure/resourcePackageApplyJournal'
import { createSqliteResourcePackageApplyArtifactRecovery } from '@/modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
/** application 层的收敛窗口：只有 `updatedAt` 早于 now-10min 的未结算行才会被扫。 */
const OLD = NOW - 30 * 60_000
const FRESH = NOW - 60_000

const PLUGIN_ID = '01JW8RPM0000000000000PLUG'
const GENERATION_ID = '01JW8RPM000000000000000GEN'
const OPERATION_ID = '01JW8RPM0000000000000000OP'

interface Ports {
  readonly journal: ResourcePackageApplyJournalPort
  readonly artifacts: ResourcePackageApplyArtifactRecoveryPort
}

interface Warning {
  readonly message: string
  readonly fields: Readonly<Record<string, string>>
}

/** Journal 两引擎共用；artifact recovery 继续读取本引擎的工件格式。 */
function portsFor(
  db: ProviderNeutralDatabase,
  isolation: 'exclusive' | 'read-committed',
  paths: { readonly appHome: string; readonly pluginsDir: string },
): Ports {
  const journal = createResourcePackageApplyJournalPort(db)
  if (isolation === 'exclusive') {
    const client = db as unknown as DbClient
    return {
      journal,
      artifacts: createSqliteResourcePackageApplyArtifactRecovery({
        db: client,
        appHome: paths.appHome,
        pluginsDir: paths.pluginsDir,
      }),
    }
  }
  const client = db as unknown as PostgresqlDatabaseClient
  return {
    journal,
    artifacts: createPostgresqlResourcePackageApplyArtifactRecovery({
      db: client,
      appHome: paths.appHome,
      pluginsDir: paths.pluginsDir,
    }),
  }
}

/**
 * 本引擎自己的 `plugin-install` 落盘工件。两套格式都只在这一处出现，别的判据只谈结果。
 * （SQLite 侧无 `operationId`；PostgreSQL 侧三个 kind 全带，且目录字段叫 `generationDirectory`。）
 */
function pluginArtifactJson(
  isolation: 'exclusive' | 'read-committed',
  generationDirectory: string,
): string {
  return JSON.stringify([
    isolation === 'exclusive'
      ? {
          kind: 'plugin-install',
          pluginId: PLUGIN_ID,
          generationId: GENERATION_ID,
          generationDir: generationDirectory,
        }
      : {
          kind: 'plugin-install',
          operationId: OPERATION_ID,
          pluginId: PLUGIN_ID,
          generationId: GENERATION_ID,
          generationDirectory,
        },
  ])
}

/**
 * 本引擎自己**生产写出**的回执格式。两套载荷格式互不认识，与落盘工件同源：
 * SQLite 的 `BundleReceipt.applied[]` 逐条是 `opId`（`services/bundle/provider.ts` 的
 * `BundleAppliedOp`），PostgreSQL 的逐条是 `operationId` 且解码器 `.strict()`。
 *
 * 按引擎喂生产真形状不是讲究：中立信封门只认 `journalId`，谁把 PG 的载荷 schema 一起搬到
 * SQLite，SQLite 这一半立刻被 zod 拒收——那正是本文件头说的那条陷阱。
 */
function pluginReceiptJson(
  isolation: 'exclusive' | 'read-committed',
  journalId: string,
  applied: 'own-shape' | 'other-engine-shape' = 'own-shape',
): string {
  const sqliteShape = (isolation === 'exclusive') === (applied === 'own-shape')
  return JSON.stringify({
    journalId,
    applied: [
      sqliteShape
        ? {
            opId: OPERATION_ID,
            resourceType: 'plugin',
            resourceId: PLUGIN_ID,
            action: 'create',
            name: 'w8-plugin',
          }
        : {
            resourceType: 'plugin',
            operationId: OPERATION_ID,
            resourceId: PLUGIN_ID,
            action: 'create',
            name: 'w8-plugin',
          },
    ],
  })
}

async function insertJournal(
  harness: ProviderHarness,
  row: {
    readonly id: string
    readonly state: 'prepared' | 'applying' | 'committed' | 'failed'
    readonly preparedArtifactsJson?: string
    readonly receiptJson?: string | null
    readonly updatedAt?: number
  },
): Promise<void> {
  await harness.db.insert(resourceBundleApplies).values({
    id: row.id,
    scope: 'package',
    key: `key-${row.id}`,
    actorUserId: 'w8-actor',
    state: row.state,
    preparedArtifactsJson: row.preparedArtifactsJson ?? '[]',
    receiptJson: row.receiptJson ?? null,
    error: null,
    createdAt: OLD,
    updatedAt: row.updatedAt ?? OLD,
  })
}

async function readJournal(
  harness: ProviderHarness,
  id: string,
): Promise<{ state: string; error: string | null; updatedAt: number } | undefined> {
  const rows = await harness.db
    .select({
      state: resourceBundleApplies.state,
      error: resourceBundleApplies.error,
      updatedAt: resourceBundleApplies.updatedAt,
    })
    .from(resourceBundleApplies)
    .where(eq(resourceBundleApplies.id, id))
  return rows[0]
}

function convergeCommand(ports: Ports, warnings: Warning[]) {
  return createResourcePackageApplyMaintenanceCommand({
    journal: ports.journal,
    artifacts: ports.artifacts,
    now: () => NOW,
    log: {
      warn(message, fields) {
        warnings.push({ message, fields })
      },
    },
  })
}

describeEachProvider('RFC-359 W8 —— ResourcePackageMaintenance 双引擎对拍', (harness) => {
  const roots: string[] = []
  const makePaths = (): { appHome: string; pluginsDir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'rfc359-w8-rpm-'))
    roots.push(root)
    const appHome = join(root, 'home')
    const pluginsDir = join(appHome, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    return { appHome, pluginsDir }
  }
  const cleanup = (): void => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }

  test('list() 把每一行 journal 投影成同一个快照形状（含 NULL receipt 与数值型 updatedAt）', async () => {
    const paths = makePaths()
    try {
      await insertJournal(harness, { id: 'w8rpm-a', state: 'prepared', updatedAt: OLD })
      await insertJournal(harness, {
        id: 'w8rpm-b',
        state: 'committed',
        preparedArtifactsJson: '[]',
        receiptJson: pluginReceiptJson(harness.capabilities.isolation, 'w8rpm-b'),
        updatedAt: FRESH,
      })

      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const snapshots = await ports.journal.list()
      expect(Object.isFrozen(snapshots)).toBe(true)
      const listed = [...snapshots].sort((left, right) => left.id.localeCompare(right.id))
      expect(listed.map((row) => row.id)).toEqual(['w8rpm-a', 'w8rpm-b'])
      expect(listed.map((row) => row.state)).toEqual(['prepared', 'committed'])
      expect(listed[0]!.receiptJson).toBeNull()
      expect(listed[0]!.preparedArtifactsJson).toBe('[]')
      expect(JSON.parse(listed[1]!.receiptJson!).journalId).toBe('w8rpm-b')
      // `updatedAt` 是收敛窗口的判据（`journal.updatedAt > reapBefore`）。PostgreSQL 的 int8
      // 经驱动回来可能是字符串——那会让窗口比较悄悄变成字典序比较。两侧都必须是 number。
      expect(listed.map((row) => typeof row.updatedAt)).toEqual(['number', 'number'])
      expect(listed[0]!.updatedAt).toBe(OLD)
      expect(listed[1]!.updatedAt).toBe(FRESH)
      expect(Object.isFrozen(listed[0])).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('settleFailed 是带 expectedState 的 CAS：状态不符 / 行不存在都返回 false 且不动任何行', async () => {
    const paths = makePaths()
    try {
      await insertJournal(harness, { id: 'w8rpm-cas', state: 'applying' })
      await insertJournal(harness, { id: 'w8rpm-other', state: 'prepared' })
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)

      // 状态不符：不动。
      expect(
        await ports.journal.settleFailed({
          id: 'w8rpm-cas',
          expectedState: 'prepared',
          error: 'nope',
          updatedAt: NOW,
        }),
      ).toBe(false)
      expect((await readJournal(harness, 'w8rpm-cas'))?.state).toBe('applying')
      expect((await readJournal(harness, 'w8rpm-cas'))?.error).toBeNull()

      // 行不存在：不动，也不抛。
      expect(
        await ports.journal.settleFailed({
          id: 'w8rpm-missing',
          expectedState: 'prepared',
          error: 'nope',
          updatedAt: NOW,
        }),
      ).toBe(false)

      // 状态相符：结算，并且只结算这一行。
      expect(
        await ports.journal.settleFailed({
          id: 'w8rpm-cas',
          expectedState: 'applying',
          error: 'converged: crashed before commit',
          updatedAt: NOW,
        }),
      ).toBe(true)
      const settled = await readJournal(harness, 'w8rpm-cas')
      expect(settled?.state).toBe('failed')
      expect(settled?.error).toBe('converged: crashed before commit')
      expect(settled?.updatedAt).toBe(NOW)
      expect((await readJournal(harness, 'w8rpm-other'))?.state).toBe('prepared')

      // 二次结算：`failed` 不再匹配 `applying`，幂等地返回 false。
      expect(
        await ports.journal.settleFailed({
          id: 'w8rpm-cas',
          expectedState: 'applying',
          error: 'again',
          updatedAt: NOW + 1,
        }),
      ).toBe(false)
      expect((await readJournal(harness, 'w8rpm-cas'))?.error).toBe(
        'converged: crashed before commit',
      )
    } finally {
      cleanup()
    }
  })

  test('settleFailed 的真实语句只有一笔事务和一次条件更新', async () => {
    const paths = makePaths()
    try {
      await insertJournal(harness, { id: 'w8rpm-statement', state: 'prepared' })
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const recording = harness.recordStatements()
      try {
        expect(
          await ports.journal.settleFailed({
            id: 'w8rpm-statement',
            expectedState: 'prepared',
            error: 'settled once',
            updatedAt: NOW,
          }),
        ).toBe(true)
        const statements = recording.statements.map((statement) => statement.sql)
        expect(statements.filter((sql) => /^\s*begin\b/i.test(sql))).toHaveLength(1)
        expect(
          statements.filter((sql) =>
            /^\s*update\s+(?:"[^"]+"\.)?"resource_bundle_applies"\s+set\b/i.test(sql),
          ),
        ).toHaveLength(1)
        expect(statements.filter((sql) => /^\s*commit\b/i.test(sql))).toHaveLength(1)
        expect(statements.filter((sql) => /^\s*rollback\b/i.test(sql))).toHaveLength(0)
      } finally {
        recording.stop()
      }
      expect(await readJournal(harness, 'w8rpm-statement')).toEqual({
        state: 'failed',
        error: 'settled once',
        updatedAt: NOW,
      })
    } finally {
      cleanup()
    }
  })

  test('竞争结算只允许一个调用成功，失败者不覆盖获胜者的错误和时间', async () => {
    const paths = makePaths()
    try {
      await insertJournal(harness, { id: 'w8rpm-race', state: 'applying' })
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const commands = [
        {
          id: 'w8rpm-race',
          expectedState: 'applying' as const,
          error: 'first settlement',
          updatedAt: NOW,
        },
        {
          id: 'w8rpm-race',
          expectedState: 'applying' as const,
          error: 'second settlement',
          updatedAt: NOW + 1,
        },
      ]
      const settled = await Promise.all(
        commands.map((command) => ports.journal.settleFailed(command)),
      )
      expect(settled.filter(Boolean)).toHaveLength(1)
      const winner = commands[settled.indexOf(true)]!
      expect(await readJournal(harness, 'w8rpm-race')).toEqual({
        state: 'failed',
        error: winner.error,
        updatedAt: winner.updatedAt,
      })
    } finally {
      cleanup()
    }
  })

  test('同一 session 中结算后中止，journal 随外层事务完整回滚', async () => {
    const paths = makePaths()
    try {
      await insertJournal(harness, { id: 'w8rpm-rollback', state: 'applying' })
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const aborted = new Error('abort journal settlement')
      await expect(
        harness.session.transaction(async () => {
          expect(
            await ports.journal.settleFailed({
              id: 'w8rpm-rollback',
              expectedState: 'applying',
              error: 'must roll back',
              updatedAt: NOW,
            }),
          ).toBe(true)
          throw aborted
        }),
      ).rejects.toBe(aborted)
      expect(await readJournal(harness, 'w8rpm-rollback')).toEqual({
        state: 'applying',
        error: null,
        updatedAt: OLD,
      })
    } finally {
      cleanup()
    }
  })

  test('converge：陈旧的未结算行被补偿并结算成 failed，落盘的 generation 目录被删干净', async () => {
    const paths = makePaths()
    try {
      const generationDirectory = join(paths.pluginsDir, PLUGIN_ID, GENERATION_ID)
      mkdirSync(generationDirectory, { recursive: true })
      writeFileSync(join(generationDirectory, 'index.js'), 'export default {}')
      await insertJournal(harness, {
        id: 'w8rpm-comp',
        state: 'prepared',
        preparedArtifactsJson: pluginArtifactJson(
          harness.capabilities.isolation,
          generationDirectory,
        ),
        updatedAt: OLD,
      })

      const warnings: Warning[] = []
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const receipt = await convergeCommand(ports, warnings).converge({ activeApplyIds: [] })

      expect(receipt).toEqual({ failed: 1, rolledForward: 0 })
      expect(existsSync(generationDirectory)).toBe(false)
      const row = await readJournal(harness, 'w8rpm-comp')
      expect(row?.state).toBe('failed')
      expect(row?.error).toBe('converged: crashed before commit')
      expect(row?.updatedAt).toBe(NOW)
      expect(warnings).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('converge：活跃中的、太新的、已 failed 的三类行都不碰', async () => {
    const paths = makePaths()
    try {
      const active = join(paths.pluginsDir, PLUGIN_ID, `${GENERATION_ID}A`)
      const fresh = join(paths.pluginsDir, PLUGIN_ID, `${GENERATION_ID}B`)
      const done = join(paths.pluginsDir, PLUGIN_ID, `${GENERATION_ID}C`)
      for (const directory of [active, fresh, done]) mkdirSync(directory, { recursive: true })

      await insertJournal(harness, {
        id: 'w8rpm-active',
        state: 'applying',
        preparedArtifactsJson: pluginArtifactJson(harness.capabilities.isolation, active),
        updatedAt: OLD,
      })
      await insertJournal(harness, {
        id: 'w8rpm-fresh',
        state: 'prepared',
        preparedArtifactsJson: pluginArtifactJson(harness.capabilities.isolation, fresh),
        updatedAt: FRESH,
      })
      await insertJournal(harness, {
        id: 'w8rpm-failed',
        state: 'failed',
        preparedArtifactsJson: pluginArtifactJson(harness.capabilities.isolation, done),
        updatedAt: OLD,
      })

      const warnings: Warning[] = []
      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const receipt = await convergeCommand(ports, warnings).converge({
        activeApplyIds: ['w8rpm-active'],
      })

      expect(receipt).toEqual({ failed: 0, rolledForward: 0 })
      expect(existsSync(active)).toBe(true)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(done)).toBe(true)
      expect((await readJournal(harness, 'w8rpm-active'))?.state).toBe('applying')
      expect((await readJournal(harness, 'w8rpm-fresh'))?.state).toBe('prepared')
      expect(warnings).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('converge · committed 的 plugin-install：发布物还在就 roll-forward，缺了就重试式告警', async () => {
    const paths = makePaths()
    try {
      const generationDirectory = join(paths.pluginsDir, PLUGIN_ID, GENERATION_ID)
      mkdirSync(generationDirectory, { recursive: true })
      const cachedPath = join(generationDirectory, 'index.js')
      writeFileSync(cachedPath, 'export default {}')
      await harness.db.insert(plugins).values({
        id: PLUGIN_ID,
        name: 'w8-plugin',
        spec: 'file:./w8-plugin',
        sourceKind: 'file',
        cachedPath,
        installedAt: OLD,
        createdAt: OLD,
        updatedAt: OLD,
      })
      await insertJournal(harness, {
        id: 'w8rpm-roll',
        state: 'committed',
        preparedArtifactsJson: pluginArtifactJson(
          harness.capabilities.isolation,
          generationDirectory,
        ),
        receiptJson: pluginReceiptJson(harness.capabilities.isolation, 'w8rpm-roll'),
        updatedAt: OLD,
      })

      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const warnings: Warning[] = []
      expect(await convergeCommand(ports, warnings).converge({ activeApplyIds: [] })).toEqual({
        failed: 0,
        rolledForward: 1,
      })
      expect(warnings).toEqual([])
      // roll-forward 是幂等回放：committed 行留在原地，等下一轮再放一次。
      expect((await readJournal(harness, 'w8rpm-roll'))?.state).toBe('committed')

      // 发布物从磁盘上消失：两侧都必须记成**可重试**的告警，而不是把行结算掉。
      rmSync(cachedPath, { force: true })
      const afterWarnings: Warning[] = []
      expect(await convergeCommand(ports, afterWarnings).converge({ activeApplyIds: [] })).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      expect(afterWarnings.map((entry) => entry.message)).toEqual([
        'resource-package-roll-forward-retryable',
      ])
      expect(afterWarnings[0]!.fields.journalId).toBe('w8rpm-roll')
      expect(afterWarnings[0]!.fields.error).toContain(
        `resource-package-plugin-publication-missing:${PLUGIN_ID}`,
      )
      expect((await readJournal(harness, 'w8rpm-roll'))?.state).toBe('committed')
    } finally {
      cleanup()
    }
  })

  /**
   * 中立信封门的两格：缺回执 / 回执认领的是别的 journal。**两个引擎逐字相同**。
   *
   * 判据落在用户看得见的三处：收敛回执的两个计数、运维日志里那条 `*-retryable` 的错误码、
   * 以及 journal 行与它名下 generation 目录的落库/落盘状态。补门之前 SQLite 在这两格上都是
   * `{ failed: 0, rolledForward: 1 }` + `warnings: []`（账本 13a 的原文）。
   */
  for (const broken of [
    {
      label: '缺回执',
      id: 'w8rpm-noreceipt',
      receiptOf: (): string | null => null,
      code: 'resource-package-committed-receipt-missing',
    },
    {
      label: '回执认领的是别的 journal',
      id: 'w8rpm-crossreceipt',
      receiptOf: (isolation: 'exclusive' | 'read-committed'): string | null =>
        pluginReceiptJson(isolation, 'w8rpm-some-other-journal'),
      code: 'resource-package-committed-receipt-mismatch',
    },
  ]) {
    test(`converge · committed 行${broken.label}：两个引擎都拒收并留痕，谁都不许照常 roll-forward`, async () => {
      const paths = makePaths()
      try {
        const generationDirectory = join(paths.pluginsDir, PLUGIN_ID, GENERATION_ID)
        mkdirSync(generationDirectory, { recursive: true })
        await insertJournal(harness, {
          id: broken.id,
          state: 'committed',
          preparedArtifactsJson: pluginArtifactJson(
            harness.capabilities.isolation,
            generationDirectory,
          ),
          receiptJson: broken.receiptOf(harness.capabilities.isolation),
          updatedAt: OLD,
        })

        const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
        const warnings: Warning[] = []
        const receipt = await convergeCommand(ports, warnings).converge({ activeApplyIds: [] })

        expect(receipt).toEqual({ failed: 0, rolledForward: 0 })
        expect(warnings.map((entry) => entry.message)).toEqual([
          'resource-package-roll-forward-retryable',
        ])
        expect(warnings[0]!.fields.journalId).toBe(broken.id)
        expect(warnings[0]!.fields.error).toContain(`${broken.code}:${broken.id}`)
        // committed 行两侧都不被结算（收敛器对 committed 只做幂等回放，没有结算臂），
        // 名下的 generation 目录当然也留在原地等下一轮。
        expect((await readJournal(harness, broken.id))?.state).toBe('committed')
        expect(existsSync(generationDirectory)).toBe(true)
      } finally {
        cleanup()
      }
    })
  }

  test('信封门只认 journalId：回执载荷用另一侧引擎的字段名，本引擎照样 roll-forward', async () => {
    const paths = makePaths()
    try {
      const generationDirectory = join(paths.pluginsDir, PLUGIN_ID, GENERATION_ID)
      mkdirSync(generationDirectory, { recursive: true })
      const cachedPath = join(generationDirectory, 'index.js')
      writeFileSync(cachedPath, 'export default {}')
      await harness.db.insert(plugins).values({
        id: PLUGIN_ID,
        name: 'w8-plugin',
        spec: 'file:./w8-plugin',
        sourceKind: 'file',
        cachedPath,
        installedAt: OLD,
        createdAt: OLD,
        updatedAt: OLD,
      })
      await insertJournal(harness, {
        id: 'w8rpm-envelope',
        state: 'committed',
        preparedArtifactsJson: pluginArtifactJson(
          harness.capabilities.isolation,
          generationDirectory,
        ),
        receiptJson: pluginReceiptJson(
          harness.capabilities.isolation,
          'w8rpm-envelope',
          harness.capabilities.isolation === 'exclusive' ? 'other-engine-shape' : 'own-shape',
        ),
        updatedAt: OLD,
      })

      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const warnings: Warning[] = []
      // SQLite 喂的是 PostgreSQL 形状的 `applied[]`（`operationId`）。信封门与载荷无关，所以它过。
      // 谁把 PG 的 `.strict()` 载荷 schema 一并搬进 SQLite，这一条当场红。
      // PostgreSQL 喂自己的形状：它的载荷层本来就要求 `operationId`，这一半是正向对照。
      expect(await convergeCommand(ports, warnings).converge({ activeApplyIds: [] })).toEqual({
        failed: 0,
        rolledForward: 1,
      })
      expect(warnings).toEqual([])
    } finally {
      cleanup()
    }
  })
})
