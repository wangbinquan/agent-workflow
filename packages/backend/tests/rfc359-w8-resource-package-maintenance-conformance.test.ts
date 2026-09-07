// RFC-359 W8 —— `modules/resource-catalog/infrastructure/ResourcePackageMaintenance` 的**双引擎对拍**。
//
// 这一对是「资源包应用的崩溃收敛」：进程在把技能目录 / 插件 generation 落盘的半路上死掉之后，
// 由 `createResourcePackageApplyMaintenanceCommand`（application 层，两侧共用）读 journal、
// 按 `state` 决定 roll-forward 还是补偿 + 结算成 failed。两侧各出**两个端口**：
//
//   · `ResourcePackageApplyJournalPort`（`list` / `settleFailed`）——**几乎重复，但不是白送的合一**。
//     两侧读同一张 `resource_bundle_applies`、投影同一个 `ResourcePackageApplyJournalSnapshot`
//     （`list` 的 11 行两侧逐字相同）、`settleFailed` 是同一条带 `expectedState` 的 CAS。唯一的
//     差别是事务包装，而它**不是**冗余：SQLite 侧的 `dbTxSync` 同时兜着
//     `foreignExplicitTransactionOpen` 那道跨上下文守卫——bun:sqlite 是单连接，别的 async 上下文
//     正持着一笔显式 `BEGIN IMMEDIATE` 时，一条裸写会**静默落进它并随它回滚**
//     （`db/txSync.ts:34-38` 的 2026-09-04 实测）；PostgreSQL 每笔事务各占一条预留连接，没有这个
//     形态，所以那一侧裸写是对的。要合就得走中立事务原语，而那会给 PG 侧再套一层 BEGIN/COMMIT、
//     改动 `rfc349-dual-provider-behavior-oracle.test.ts` 里那份脚本化语句流水。本刀因此**只补对拍
//     不合一**：真正能退役这一对的是下面那半边的桥接，合一该跟着它一起做，那时这份对拍原样还能跑。
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
// # 对拍在旧实现上照出的一条真差异（已按强侧抬齐前先在这里被看见）
//
// **`committed` 行缺 receipt 时两侧走向相反**：PostgreSQL 侧 `rollForward` 第一步就是
// `parseReceipt`，`receipt_json` 为 NULL 直接抛 `resource-package-committed-receipt-missing`，
// 收敛器记一条 `resource-package-roll-forward-retryable` 并**每一轮重蹈**，那一行永远收不掉；
// SQLite 侧根本不看 receipt，照常 roll-forward 并计数。这不是本对拍要修的东西（两套工件格式
// 决定了 receipt 语义只在 PG 那一套里存在），但它是**用户可见的运维差异**，必须被看见而不是
// 被合一时才发现，所以在这里逐条锁住。

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
import {
  createPostgresqlResourcePackageApplyArtifactRecovery,
  createPostgresqlResourcePackageApplyJournalPort,
} from '@/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import {
  createSqliteResourcePackageApplyArtifactRecovery,
  createSqliteResourcePackageApplyJournalPort,
} from '@/modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance'
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

/** 按引擎取本引擎的那份适配器。`describeEachProvider` 有意不给 provider 名，只给能力矩阵。 */
function portsFor(
  db: ProviderNeutralDatabase,
  isolation: 'exclusive' | 'read-committed',
  paths: { readonly appHome: string; readonly pluginsDir: string },
): Ports {
  if (isolation === 'exclusive') {
    const client = db as unknown as DbClient
    return {
      journal: createSqliteResourcePackageApplyJournalPort(client),
      artifacts: createSqliteResourcePackageApplyArtifactRecovery({
        db: client,
        appHome: paths.appHome,
        pluginsDir: paths.pluginsDir,
      }),
    }
  }
  const client = db as unknown as PostgresqlDatabaseClient
  return {
    journal: createPostgresqlResourcePackageApplyJournalPort(client),
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

/** PostgreSQL 的 roll-forward 要求工件出现在 receipt 里；SQLite 不看 receipt。 */
function pluginReceiptJson(journalId: string): string {
  return JSON.stringify({
    journalId,
    applied: [
      {
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
        receiptJson: pluginReceiptJson('w8rpm-b'),
        updatedAt: FRESH,
      })

      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const listed = [...(await ports.journal.list())].sort((left, right) =>
        left.id.localeCompare(right.id),
      )
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
        receiptJson: pluginReceiptJson('w8rpm-roll'),
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

  test('committed 行缺 receipt：PostgreSQL 侧永远收不掉，SQLite 侧照常 roll-forward（对拍照出的真差异）', async () => {
    const paths = makePaths()
    try {
      const generationDirectory = join(paths.pluginsDir, PLUGIN_ID, GENERATION_ID)
      mkdirSync(generationDirectory, { recursive: true })
      await insertJournal(harness, {
        id: 'w8rpm-noreceipt',
        state: 'committed',
        preparedArtifactsJson: pluginArtifactJson(
          harness.capabilities.isolation,
          generationDirectory,
        ),
        receiptJson: null,
        updatedAt: OLD,
      })

      const ports = portsFor(harness.db, harness.capabilities.isolation, paths)
      const warnings: Warning[] = []
      const receipt = await convergeCommand(ports, warnings).converge({ activeApplyIds: [] })

      if (harness.capabilities.isolation === 'exclusive') {
        // SQLite 的工件格式里没有 receipt 这一层：plugins 里查不到这个 id 就当发布物无需复核。
        expect(receipt).toEqual({ failed: 0, rolledForward: 1 })
        expect(warnings).toEqual([])
      } else {
        // PostgreSQL：`parseReceipt` 是 rollForward 的第一步，NULL receipt 每一轮抛同一个错，
        // 这一行**永久卡在 committed**，名下的 generation 目录也永远没人收。
        expect(receipt).toEqual({ failed: 0, rolledForward: 0 })
        expect(warnings.map((entry) => entry.message)).toEqual([
          'resource-package-roll-forward-retryable',
        ])
        expect(warnings[0]!.fields.error).toContain(
          'resource-package-committed-receipt-missing:w8rpm-noreceipt',
        )
      }
      expect((await readJournal(harness, 'w8rpm-noreceipt'))?.state).toBe('committed')
      expect(existsSync(generationDirectory)).toBe(true)
    } finally {
      cleanup()
    }
  })
})
