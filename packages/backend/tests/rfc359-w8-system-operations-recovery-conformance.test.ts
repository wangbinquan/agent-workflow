// RFC-359 W8 —— System Operations 灾难恢复端口的双 provider 行为对拍。
//
// 为什么这一族此前**完全没有**对拍
// ================================
// `AdminBackupCoordinatorPort` / `AdminRestoreCoordinatorPort`（
// `src/modules/system-operations/application/ports/`）各有两份生产实现：
//
//   · SQLite  —— `infrastructure/legacyPlatformRecoveryAdapter.ts`
//                （转调 `platform/persistence/sqlite/systemProviderBackup|Restore.ts`
//                  与 `services/pendingRestore.ts`）
//   · PostgreSQL —— `infrastructure/postgresqlAdminBackupCoordinator.ts` /
//                `postgresqlAdminRestoreCoordinator.ts`
//                （转调 `postgresqlProviderBackup|Restore.ts` 与 `postgresqlPendingRestore.ts`）
//
// 这是一对**教科书式的端口 + 两个适配器**，却对本 RFC 既有的两本账本**结构性隐形**：
//
//   · `rfc359-w5-provider-pair-conformance.test.ts` 按「文件名引擎前缀 + **同目录**」配对。
//     这一对两条都不满足：SQLite 侧的文件名里根本没有 `sqlite` 三个字母
//     （`legacyPlatformRecoveryAdapter`），两侧也不同目录。
//   · `rfc359-w5-t17-provider-file-location.test.ts` 只清点 provider 命名文件的**落位**，
//     它看得见 `postgresqlAdminRestoreCoordinator.ts` 这个独苗，但看不见它有孪生兄弟。
//
// 更要命的是：**任何按名字配对的判据都抓不到它**——两侧的名字本来就不同
// （`systemProviderRestore` vs `providerRestore`）。所以这不是「把 classify() 放宽」
// 能解决的，得换一条**能力级**判据；那条判据落在
// `tests/architecture/rfc359-w8-capability-pair-conformance.test.ts`，本文件是它照出来的
// 第一对的行为取证。
//
// 于是这一族长期是：**两份实现、两套各自的单引擎测试、零跨 provider 对拍**。
// 12 个备份 / 还原用例（`backup.test.ts`、`rfc213-*`）只跑 SQLite；
// PG 侧自己那一族（`rfc349-postgresql-admin-*`、`rfc349-portable-database-restore`）也全是单引擎。
// 本 RFC 迄今抓到的真分叉全部来自这个形态——而这次涉及的是**灾难恢复**，
// 它坏了用户会在最需要的时候才发现。
//
// 为什么这里**不是** `describeEachProvider`
// ==========================================
// `describeEachProvider` 的轴是**数据库连接**：它给 body 一个 SQLite 内存库或一个真 PG 库。
// 但本对拍锁的这段契约（暂存 / 状态 / 取消 / 隔离失败件）**整段状态都在文件系统上**
// ——`.restore-pending/` 与 `.restore-pending-postgresql/` 的标记文件、暂存的 tarball、
// `.failed-<ts>` 隔离目录。库连接在这条路径上一行都不碰。
// 把它套进 `describeEachProvider` 会变成「两份协调器 × 两个引擎」四种组合，其中两种
// （SQLite 协调器跑在 PG 库上）在生产里根本不存在——那是形式上的双引擎、实质上的噪音。
//
// 所以轴换成**协调器本身**：同一批断言，对着两份真实现各跑一遍。判据一律写在
// **用户可见契约**那一层——断言全部穿过 `createSystemOperationsApplication` 的
// command / query 与它们的 zod view schema，也就是 `POST /api/restore` /
// `GET /api/restore/pending` / `DELETE /api/restore/pending` 真正返回给用户的东西，
// 而不是任何一侧的内部字段。
//
// 被 stub 的只有「provider 固有的物理机制」——建归档、验归档、真正落盘还原。
// **暂存状态机与恢复状态投影是两侧各自的生产代码**，那里才是分叉的容身处。
//
// 已知的**正当**机制差异（不在本文件里拉平，理由见各条）
// ======================================================
//   · **冷还原 vs 逻辑还原**：SQLite 是停守护进程 + 字节拷贝 + 崩溃安全换名（RFC-213）；
//     PostgreSQL 是逐行写进活着的服务器（RFC-349）。不能往活着的 PG 上拷文件，
//     机制不同是正当的。本文件只证**同一个用户可见契约**在两侧都成立。
//   · **`direction` 的取值域**：SQLite 按 Drizzle 迁移轴算 same/forward/downgrade；
//     PostgreSQL 的还原门是逻辑 schema digest，恒 `'same'`。两侧都满足
//     `stageRestoreResultSchema`，用户拿到的都是一个合法方向。
//   · **安全备份**：SQLite 就地覆盖前默认先拍一份安全备份（失败即拒）；PostgreSQL 的还原
//     要求目标 schema 为空（非空直接 409 `postgresql-restore-target-not-empty`），
//     没有东西会被覆盖，因而没有安全备份可拍。两侧都满足「不会在无声中吃掉现有数据」。

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSystemOperationsApplication } from '@/modules/system-operations/application/systemOperations'
import type { SystemOperationsRecoveryAdapter } from '@/modules/system-operations/composition'
import { createLegacyPlatformRecoveryAdapter } from '@/modules/system-operations/infrastructure/legacyPlatformRecoveryAdapter'
import { createPostgresqlAdminRestoreCoordinator } from '@/modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator'
import { createPostgresqlAdminBackupCoordinator } from '@/modules/system-operations/infrastructure/postgresqlAdminBackupCoordinator'
import type { PortableDatabaseBackupInspection } from '@/modules/system-operations/infrastructure/portableDatabaseRestore'
import type { RestoreArtifactPathResolver } from '@/modules/system-operations/infrastructure/restoreArtifactIngress'
import type { RestoreArtifactRef } from '@/modules/system-operations/public/types'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { SQLITE_POST_RESTORE_RECOVERY } from './helpers/sqlitePostRestoreRecovery'

const CONTEXT = Object.freeze({}) as CommandContext & QueryContext

/** 归档摘要 → PG 协调器的 operationId（`restoreOperationId` 取 digest 的 32 个十六进制位）。 */
const ENVELOPE_DIGEST = `sha256:${'a'.repeat(64)}`

// ---------------------------------------------------------------------------
// 两份真实现各自的最小装配。stub 只覆盖 provider 固有的物理机制。
// ---------------------------------------------------------------------------

interface RecoveryHarness {
  readonly appHome: string
  readonly adapter: SystemOperationsRecoveryAdapter
  /** 登记一个指向 `path` 的归档引用（不要求文件存在——「归档在暂存途中没了」是被测场景之一）。 */
  artifact(path: string): RestoreArtifactRef
}

function artifactResolver(): RestoreArtifactPathResolver & {
  register(path: string): RestoreArtifactRef
} {
  const paths = new WeakMap<RestoreArtifactRef, string>()
  return {
    register(path: string) {
      const ref = Object.freeze({}) as RestoreArtifactRef
      paths.set(ref, path)
      return ref
    },
    pathOf(ref: RestoreArtifactRef) {
      const path = paths.get(ref)
      if (path === undefined) throw new Error('unknown restore artifact ref')
      return path
    },
  }
}

function sqliteHarness(appHome: string): RecoveryHarness {
  const artifacts = artifactResolver()
  const plan = Object.freeze({
    manifest: null,
    backupLastCreatedAt: null,
    currentMaxWhen: 0,
    direction: 'same' as const,
  })
  const adapter = createLegacyPlatformRecoveryAdapter({
    artifacts,
    appHome,
    dbPath: join(appHome, 'db.sqlite'),
    lockPath: join(appHome, '.daemon.lock'),
    backupResources: () => ({ db: null as never }),
    prepareBackup: async () => {},
    postOpenRecovery: SQLITE_POST_RESTORE_RECOVERY,
    resolveRestoreMigrations: async () => join(appHome, 'migrations'),
    mechanisms: {
      // provider 固有的物理机制——建归档 / 验归档 / 真正落盘还原。暂存状态机不在其中。
      createBackup: async () => ({
        path: join(appHome, 'backups', 'backup.tar.gz'),
        sizeBytes: 1,
        contents: { workflows: 0, skills: 0, db: true, config: true },
      }),
      planRestore: async () => plan,
      validateBackupForStage: async () => plan,
      restoreBackup: async () => ({
        direction: 'same' as const,
        safetyBackupPath: null,
        migrated: false,
        restored: { db: true, config: true, skills: true },
      }),
    },
  })
  return { appHome, adapter, artifact: (path) => artifacts.register(path) }
}

function postgresqlHarness(appHome: string): RecoveryHarness {
  const artifacts = artifactResolver()
  const inspection = {
    manifest: { kind: 'manual', migration: { lastCreatedAt: null } },
    envelope: { digest: ENVELOPE_DIGEST },
    verification: {},
  } as unknown as PortableDatabaseBackupInspection
  const restore = createPostgresqlAdminRestoreCoordinator({
    artifacts,
    runtime: { provider: 'postgresql' } as PostgresqlDatabaseRuntime,
    targetGenerationId: 'dbg_pg_conformance_0001',
    appHome,
    lockPath: join(appHome, '.daemon.lock'),
    contract: { digest: `sha256:${'b'.repeat(64)}` } as LogicalSchemaContract,
    plan: {} as PostgresqlSchemaPlan,
    filesystem: { apply: async () => ({ config: true, skills: true }) } as never,
    // provider 固有的物理机制——验归档 / 目标预检 / 真正落盘还原。暂存状态机不在其中。
    inspectBackup: async () => inspection,
    preflightTarget: async () => ({}) as never,
    restoreBackup: async () => ({ filesystem: { config: true, skills: true } }) as never,
  })
  const adapter: SystemOperationsRecoveryAdapter = {
    backup: createPostgresqlAdminBackupCoordinator({
      runtime: { provider: 'postgresql' } as PostgresqlDatabaseRuntime,
      // RFC-359 W9：应用侧资产（workflow / worktree 行）已合成中立实现由组合根注入；
      // 本文件把整条 createBackup 都 stub 掉，客户端一次也不用。
      db: {} as ProviderNeutralDatabase,
      appHome,
      createBackup: async () => ({
        path: join(appHome, 'backups', 'backup.tar.gz'),
        sizeBytes: 1,
        contents: { workflows: 0, skills: 0, db: true, config: true },
      }),
    }),
    restore,
  }
  return { appHome, adapter, artifact: (path) => artifacts.register(path) }
}

const PROVIDERS: ReadonlyArray<{
  readonly name: string
  readonly build: (appHome: string) => RecoveryHarness
  /** 该 provider 的暂存目录名——只用来构造「标记文件损坏」这一场景，断言里不出现。 */
  readonly pendingDirectory: string
}> = [
  { name: 'sqlite', build: sqliteHarness, pendingDirectory: '.restore-pending' },
  {
    name: 'postgresql',
    build: postgresqlHarness,
    pendingDirectory: '.restore-pending-postgresql',
  },
]

// ---------------------------------------------------------------------------
// 同一批断言，两份实现各跑一遍。全部穿过 application 层的 command / query。
// ---------------------------------------------------------------------------

for (const provider of PROVIDERS) {
  describe(`RFC-359 W8 —— 灾难恢复端口的用户可见契约 [${provider.name}]`, () => {
    const harnesses: string[] = []
    const fresh = (): {
      harness: RecoveryHarness
      app: ReturnType<typeof createSystemOperationsApplication>
    } => {
      const appHome = mkdtempSync(join(tmpdir(), `aw-w8-recovery-${provider.name}-`))
      harnesses.push(appHome)
      const harness = provider.build(appHome)
      return { harness, app: createSystemOperationsApplication(harness.adapter) }
    }
    const goodArtifact = (harness: RecoveryHarness): RestoreArtifactRef => {
      const path = join(harness.appHome, 'upload.tar.gz')
      writeFileSync(path, 'archive-bytes')
      return harness.artifact(path)
    }
    const stageInput = (artifactRef: RestoreArtifactRef) => ({
      artifactRef,
      noSafetyBackup: false,
      noMigrate: false,
      skipIntegrityCheck: false,
    })

    test('① 暂存 → 状态显示待还原 → 取消 → 状态回到空', async () => {
      const { harness, app } = fresh()

      expect(app.queries.getRecoveryStatus.execute(CONTEXT)).toEqual({
        pending: null,
        failed: [],
      })

      const staged = await app.commands.stageRestore.execute(
        CONTEXT,
        stageInput(goodArtifact(harness)),
      )
      expect(['same', 'forward', 'downgrade']).toContain(staged.direction)

      const pending = app.queries.getRecoveryStatus.execute(CONTEXT).pending
      expect(pending).not.toBeNull()
      // 用户在恢复面板上看到的三件事：什么时候排的、暂存了多少字节、带了哪些开关。
      expect(pending?.stagedBytes).toBe('archive-bytes'.length)
      expect(pending?.noMigrate).toBe(false)
      expect(pending?.skipIntegrityCheck).toBe(false)

      expect(app.commands.cancelStagedRestore.execute(CONTEXT)).toEqual({ cleared: true })
      expect(app.queries.getRecoveryStatus.execute(CONTEXT)).toEqual({
        pending: null,
        failed: [],
      })
    })

    test('② 没有待还原时取消 —— 报告「没清掉任何东西」，不抛错', () => {
      const { app } = fresh()
      expect(app.commands.cancelStagedRestore.execute(CONTEXT)).toEqual({ cleared: false })
    })

    test('③ 已排了一个还原时再排一个 —— 409 restore-already-pending，先取消再排', async () => {
      const { harness, app } = fresh()
      await app.commands.stageRestore.execute(CONTEXT, stageInput(goodArtifact(harness)))

      const second = app.commands.stageRestore.execute(CONTEXT, stageInput(goodArtifact(harness)))
      await expect(second).rejects.toMatchObject({ code: 'restore-already-pending', status: 409 })

      // 先前那一个必须原封不动——第二次尝试不能把第一次的暂存件顶掉。
      expect(app.queries.getRecoveryStatus.execute(CONTEXT).pending).not.toBeNull()
      expect(app.commands.cancelStagedRestore.execute(CONTEXT)).toEqual({ cleared: true })
    })

    test('④ 暂存中途失败 —— 实例不能就此再也排不了还原', async () => {
      // 场景：校验已经放行，随后把归档拷进暂存目录这一步失败了（磁盘满 / 归档被并发释放 /
      // 上传件已被清理）。这里用「引用指向一个不存在的文件」来确定性地触发同一条代码路径。
      //
      // 用户可见的后果如果没锁住会是：面板说「没有待还原」、取消说「没清掉任何东西」、
      // 而每一次重新上传还原包都被 409「已经排了一个还原，请先取消」挡回去——
      // 三条互相矛盾的回答，且没有任何一条提到该删哪个目录。灾难恢复当场归零。
      const { harness, app } = fresh()
      const missing = harness.artifact(join(harness.appHome, 'vanished.tar.gz'))

      await expect(
        app.commands.stageRestore.execute(CONTEXT, stageInput(missing)),
      ).rejects.toThrow()

      // 失败没有留下任何「有东西排着」的痕迹。
      expect(app.queries.getRecoveryStatus.execute(CONTEXT)).toEqual({ pending: null, failed: [] })

      // 而且下一次重试必须能成——这才是「实例还活着」的定义。
      const retried = await app.commands.stageRestore.execute(
        CONTEXT,
        stageInput(goodArtifact(harness)),
      )
      expect(['same', 'forward', 'downgrade']).toContain(retried.direction)
      expect(app.queries.getRecoveryStatus.execute(CONTEXT).pending).not.toBeNull()
    })

    test('⑤ 暂存标记损坏 —— 恢复面板照常渲染，不是 500', () => {
      // 标记文件被截断 / 手改坏 / 半写（掉电）。用户此刻恰恰最需要这个面板可用——
      // 取消按钮就在同一个面板上。投影必须把读不懂的标记当成「没有待还原」，
      // 而不是把一个类型错乱的对象扔给 view schema 去炸出 500。
      const { harness, app } = fresh()
      const directory = join(harness.appHome, provider.pendingDirectory)
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'restore-pending.json'),
        // 结构合法的 JSON、字段类型全错——比纯乱码更危险，因为 JSON.parse 不会拦它。
        JSON.stringify({ stagedTarball: 42, requestedAt: 'yesterday', noMigrate: 'yes' }),
        'utf8',
      )

      expect(() => app.queries.getRecoveryStatus.execute(CONTEXT)).not.toThrow()
      expect(app.queries.getRecoveryStatus.execute(CONTEXT).pending).toBeNull()
    })

    test('⑥ 失败的还原被隔离下来，按时间倒序列给用户，带上失败原因', () => {
      const { harness, app } = fresh()
      for (const [failedAt, message] of [
        [100, 'older failure'],
        [200, 'newer failure'],
      ] as const) {
        const quarantine = join(harness.appHome, `${provider.pendingDirectory}.failed-${failedAt}`)
        mkdirSync(quarantine, { recursive: true })
        writeFileSync(join(quarantine, 'error.txt'), `${message}\n`, 'utf8')
      }

      const failed = app.queries.getRecoveryStatus.execute(CONTEXT).failed
      expect(failed.map((entry) => [entry.failedAt, entry.error])).toEqual([
        [200, 'newer failure'],
        [100, 'older failure'],
      ])
      // 每一条都指向一个真目录——用户照着它就能去捞现场。
      for (const entry of failed) expect(existsSync(entry.dir)).toBe(true)
    })

    test('⑦ 备份收据的形状两侧一致', async () => {
      const { app } = fresh()
      const receipt = await app.commands.requestBackup.execute(CONTEXT, {
        includeWorktrees: false,
      })
      expect(typeof receipt.path).toBe('string')
      expect(receipt.sizeBytes).toBeGreaterThanOrEqual(0)
      expect(receipt.contents).toEqual({ workflows: 0, skills: 0, db: true, config: true })
    })

    test('⑧ 隔离目录不会串到另一个 provider 的清单里', () => {
      // 两侧的隔离目录同住 appHome。`.restore-pending.failed-` 是
      // `.restore-pending-postgresql.failed-` 的前缀邻居，判据一旦写松就会互相认领，
      // 用户会在 SQLite 实例上看到 PG 的失败记录（反之亦然）。
      const { harness, app } = fresh()
      const foreign = PROVIDERS.find((entry) => entry.name !== provider.name)!
      for (const entry of PROVIDERS) {
        const quarantine = join(harness.appHome, `${entry.pendingDirectory}.failed-300`)
        mkdirSync(quarantine, { recursive: true })
        writeFileSync(join(quarantine, 'error.txt'), `${entry.name} boom\n`, 'utf8')
      }

      const failed = app.queries.getRecoveryStatus.execute(CONTEXT).failed
      expect(failed.map((entry) => entry.error)).toEqual([`${provider.name} boom`])
      // 目录路径也要逐条对准自己那一侧——`.restore-pending` 是
      // `.restore-pending-postgresql` 的**子串**，所以这里比的是整段目录名，不是包含关系。
      expect(failed.map((entry) => entry.dir)).toEqual([
        join(harness.appHome, `${provider.pendingDirectory}.failed-300`),
      ])
      expect(failed.map((entry) => entry.dir)).not.toContain(
        join(harness.appHome, `${foreign.pendingDirectory}.failed-300`),
      )
    })

    afterAll(() => {
      for (const appHome of harnesses.splice(0)) rmSync(appHome, { recursive: true, force: true })
    })
  })
}
