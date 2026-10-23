// RFC-395 II-pre：已退役写合同改为历史工件原始载荷，保留完整恢复矩阵。
// RFC-359 W5 —— **落盘工件格式的跨引擎可读性**账本（行为式，只降不升）。
//
// # 机制：同一列，两个引擎各写各的格式，两侧解码器又都 `.strict()`
//
// `resource_bundle_applies.prepared_artifacts_json` 是**资源包应用的崩溃恢复工件**——每做一次
// 外部副作用（装插件、暂存技能目录、暂存技能版本）之前先把「我要做什么、做在哪个目录」落库，
// 进程半路死掉之后由收敛器读回来，决定 roll-forward 还是补偿。它是 `db/schema.ts:4716` 亲口
// 写明的 **COMPENSATION ORACLE**：读不回来 = 那次半成品的外部副作用永远没人收。
//
// 而这一列今天被**两套互不认识的格式**写着：
//
//   · SQLite 侧写 `BundleArtifact`
//     —— 写出点 `platform/persistence/sqlite/legacyResourcePackageBundleApply.ts:287`，
//        形状 `services/bundle/provider.ts:74-85`；
//   · PostgreSQL 侧写 `PostgresqlResourcePackageMutationArtifact`
//     —— 写出点 `platform/persistence/postgresqlResourcePackageAtomicApply.ts:881`，
//        形状 `modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts:607-630`。
//
// 三个 kind 的名字一样（`plugin-install` / `skill-stage` / `skill-version-stage`），字段却对不上：
// `generationDir` vs `generationDirectory`、`skillDir` vs `stagingDirectory`+`targetDirectory`、
// `opId` vs `operationId`；PG 三个 kind 全带 `operationId`，SQLite 一个都不带；
// `skill-version-stage` 更是一个把载荷**嵌套**在 `staged` 里、一个**扁平**摊开。
//
// 读回侧两个解码器**都是 zod `.strict()` 的 discriminatedUnion**：
//   · `modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts:27-76`
//   · `modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts:26-101`
// 于是任一侧读到对方写的行，zod 直接抛 —— 收敛器把它记成 `resource-package-*-retryable`
// 并**每一轮都重蹈同一个异常**，那条 journal 行**永久卡住**，它名下的技能暂存目录 /
// 插件 generation 目录**永远收不掉**。
//
// # 用户可见后果
//
// 跨引擎迁移之后（或同一部署把 provider 从 SQLite 换成 PostgreSQL、反之），**迁移前留下的
// 存量 journal 行再也无法收敛**：资源包应用停在 prepared/applying/committed 不动，管理面
// 反复报同一个恢复失败，半成品的技能目录与插件目录赖在磁盘上没人清。这正是 RFC-359 要消灭的
// 「一个引擎能用、另一个不能」——只不过这次分叉不在 SQL 里，在**落盘字节**里。
//
// # 正解长什么样：意图侧已经做过一次
//
// 同一张表形态的 `intent_apply_journal.prepared_artifacts_json` **已经**有跨格式桥接：
// `modules/intent/infrastructure/intentApplyArtifactLifecycle.ts:82-99` 的
// `decodeIntentApplyRecoveryArtifacts` 逐条先试 PG 形状、不认就回落到 SQLite 解码器。
// 也就是说「能桥接」在本仓是**已经证实可行**的形态，不是设想。资源包侧欠的就是这一步。
//
// # 判据为什么是行为式，不是纸面比对
//
// 本仓有明确教训：**SQL / 结构长得一样证明不了两个 provider 行为一样**（`rfc349-provider-cutover`
// 那一轮的由来）。所以这条守卫不去比 schema 的源码文本，而是**把真实的生产解码器跑起来**：
// 从生产代码 import 两侧**导出的恢复端口工厂**
// （`createSqliteResourcePackageApplyArtifactRecovery` / `createPostgresqlResourcePackageApplyArtifactRecovery`），
// 拿一侧的代表性样本喂另一侧的 `compensate()`，看它到底抛不抛。
//
// 选 `compensate()` 而不是 `rollForward()` 当探针，是因为两侧的 `compensate()` 都在**任何**
// 数据库访问、任何 receipt 校验之前就先 `parseArtifacts(...)`：解码失败会**原样逃出**（逐工件的
// try/catch 只包住循环体，解码在循环之外），所以探针不需要真数据库、不需要 receipt，
// 只需要一个临时目录。样本本身用生产的路径原语（`skillFilesAbs` / `skillVersionAbs` /
// `opStagedDir`）拼出来，因此正向那一半也是真的「这条记录合法」，不是随手编的字典。
//
// # 账本读法与两个方向的红
//
// `ARTIFACT_FORMAT_PORTABILITY` 是 `写出引擎/kind -> 读回引擎: accepts|rejects` 的**全矩阵**，
// 逐字相等：
//   · 出现**新的 rejects**（新 kind、新的一侧不认）——又多了一处只有一个引擎能读的落盘格式，
//     去建桥，别扩账本；
//   · 原有的 rejects **变成 accepts**——缺口补上了（照 `intentApplyArtifactLifecycle.ts:82-99`
//     那样加跨格式回落），**把这条账本条目一起改掉**，让这次收敛留下一次有署名的提交记录；
//   · 同引擎那 6 格必须恒为 accepts——它们掉成 rejects 说明样本或解码器坏了，此刻本守卫零预言力。
//
// 配套的锚点用例（RFC-317 T13「扫空 = 假绿」的同款纪律）在下面：两侧工厂必须 import 得到、
// 两侧解码器必须以 ZodError 拒绝未知 kind、样本 kind 必须覆盖解码器声明的全部 kind、
// 两个写出点必须还在写这一列。任何一条被改名 / 挪走，守卫**红**，而不是静默假绿。

// 2026-10-22 RFC-395 II-a A6：以上保留 W5 历史机制与原判据。当前两个 provider 写统一裸数组，
// 完整的新旧格式均由统一恢复 composition 读取；下方十二格分别使用真实 provider journal 与目录补偿。
// 未知 kind 仍须拒绝；不再使用拒绝 DB 访问的 Proxy，也不把普通 effect 错误当作 accepts。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ZodError } from 'zod'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '../../src/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { createLegacyResourcePackageApplyArtifactRecovery } from '../../src/modules/resource-catalog/infrastructure/resourcePackageLegacyRecovery'
import { composeResourcePackageApplyMaintenance } from '../../src/modules/resource-catalog/composition/resourcePackageMaintenance'
import { opStagedDir } from '../../src/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import {
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from '../../src/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import type { PostgresqlResourcePackageMutationArtifact } from '../../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import { createAtomicApplyRecovery } from '../../src/platform/atomic-apply/convergence'
import { tablesOf } from '../../src/platform/persistence/sessionTables'
import { insertOne } from '../../src/platform/persistence/singleInsert'
import { describeEachProvider } from '../helpers/eachProvider'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * `<写出引擎>/<kind> -> <读回引擎>: accepts|rejects`，按行字典序。
 *
 * 六格 `rejects` 就是本条守卫钉住的缺口：**跨引擎迁移后存量恢复工件读不回来**。补上桥接
 * （形如 `modules/intent/infrastructure/intentApplyArtifactLifecycle.ts:82-99`）之后
 * 把对应行改成 `accepts`，不要删掉整条守卫——矩阵本身还要继续防守新增的不可移植格式。
 *
 * 这是结果矩阵而非债务账本，不带 `_DEBT` 后缀。RFC-376 已撤销 T72 与全局计数钉；
 * 本文件继续记录**全矩阵的实测裁决**——十二格里有六格是「本来就该 accepts」的正向断言，给它钉一个「只降不升的条数」没有
 * 意义（条数恒等于 `写出引擎 × kind × 读回引擎`）。真正的债是那六格 `rejects`，它们由上面那条
 * 逐字相等断言直接钉住，收敛时必须改这份文本，一样留痕。
 *
 * 2026-10-22 RFC-395 II-a A6：上述六格 rejects 是历史缺口；当前十二格均为 accepts，
 * 由各自 provider 的真实 journal、恢复 composition 与目录补偿断言覆盖。
 */
export const ARTIFACT_FORMAT_PORTABILITY: readonly string[] = [
  'postgresql/plugin-install -> postgresql: accepts',
  'postgresql/plugin-install -> sqlite: accepts',
  'postgresql/skill-stage -> postgresql: accepts',
  'postgresql/skill-stage -> sqlite: accepts',
  'postgresql/skill-version-stage -> postgresql: accepts',
  'postgresql/skill-version-stage -> sqlite: accepts',
  'sqlite/plugin-install -> postgresql: accepts',
  'sqlite/plugin-install -> sqlite: accepts',
  'sqlite/skill-stage -> postgresql: accepts',
  'sqlite/skill-stage -> sqlite: accepts',
  'sqlite/skill-version-stage -> postgresql: accepts',
  'sqlite/skill-version-stage -> sqlite: accepts',
]

/** 落盘工件写出点：`preparedArtifactsJson` 的两个来源，按引擎。 */
/**
 * 落盘工件的**写出点**。
 *
 * RFC-359 §5dv/§5dy：两台 apply 引擎合一之后**只剩一个写出点**——SQLite 那台
 * （`legacyResourcePackageBundleApply.ts`）随通用 bundle 引擎退役。`sqlite` 那一族样本
 * 因此不再有活着的生产者：它代表的是**合一之前留在盘上的存量工件**，读回侧仍然必须认得
 * （`createVersionedResourcePackageArtifactRecovery` 就是为它存在的），所以样本与矩阵都留着。
 */
const WRITERS: Readonly<Partial<Record<Engine, string>>> = {
  postgresql: 'platform/atomic-apply/stateMachine.ts',
}

/** 落盘工件读回点：`.strict()` 解码器所在文件，按引擎。 */
const DECODERS: Readonly<Record<Engine, string>> = {
  sqlite: 'modules/resource-catalog/infrastructure/resourcePackageLegacyCodec.ts',
  postgresql: 'modules/resource-catalog/infrastructure/resourcePackageCurrentCodec.ts',
}

type Engine = 'sqlite' | 'postgresql'

const ENGINES: readonly Engine[] = ['postgresql', 'sqlite']

const SKILL_ID = '01JGUARD0000000000000SKILL'
const PLUGIN_ID = '01JGUARD00000000000PLUGIN'
const GENERATION_ID = '01JGUARD000000000000000GEN'
const OPERATION_ID = '01JGUARD0000000000000000OP'
const PUBLISH_ID = '01JGUARD00000000000000PUB'
const VERSION = 2

/** SQLite 侧的代表性落盘样本。类型标注即锚点：历史行按原始载荷播种，由生产恢复解码器检验。 */
function sqliteSamples(
  appHome: string,
  pluginsDir: string,
): readonly (Record<string, unknown> & { readonly kind: string })[] {
  const filesDir = skillFilesAbs(appHome, SKILL_ID)
  return [
    {
      kind: 'skill-stage',
      skillId: SKILL_ID,
      opId: OPERATION_ID,
      skillDir: skillRootAbs(appHome, SKILL_ID),
    },
    {
      kind: 'skill-version-stage',
      staged: {
        skillId: SKILL_ID,
        skillName: 'guard-skill',
        // `null` 表示这份历史样本没有操作行；仍由真实 provider 的恢复场景执行目录补偿。
        opId: null,
        publishId: PUBLISH_ID,
        newVersion: VERSION,
        newHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
        filesDir,
        versionDir: skillVersionAbs(appHome, SKILL_ID, VERSION),
        stagingDir: opStagedDir(filesDir, PUBLISH_ID),
        noop: null,
      },
    },
    {
      kind: 'plugin-install',
      pluginId: PLUGIN_ID,
      generationId: GENERATION_ID,
      generationDir: join(pluginsDir, PLUGIN_ID, GENERATION_ID),
    },
  ]
}

/** PostgreSQL 侧的代表性落盘样本。类型标注同样是锚点。 */
function postgresqlSamples(
  appHome: string,
  pluginsDir: string,
): readonly PostgresqlResourcePackageMutationArtifact[] {
  const filesDir = skillFilesAbs(appHome, SKILL_ID)
  return [
    {
      kind: 'plugin-install',
      operationId: OPERATION_ID,
      pluginId: PLUGIN_ID,
      generationId: GENERATION_ID,
      generationDirectory: join(pluginsDir, PLUGIN_ID, GENERATION_ID),
    },
    {
      kind: 'skill-stage',
      operationId: OPERATION_ID,
      skillId: SKILL_ID,
      stagingDirectory: opStagedDir(filesDir, OPERATION_ID),
      targetDirectory: filesDir,
    },
    {
      kind: 'skill-version-stage',
      operationId: OPERATION_ID,
      skillId: SKILL_ID,
      publishId: PUBLISH_ID,
      version: VERSION,
      stagingDirectory: opStagedDir(filesDir, OPERATION_ID),
      versionDirectory: skillVersionAbs(appHome, SKILL_ID, VERSION),
    },
  ]
}

function samplesOf(
  engine: Engine,
  appHome: string,
  pluginsDir: string,
): readonly { readonly kind: string }[] {
  return engine === 'sqlite'
    ? sqliteSamples(appHome, pluginsDir)
    : postgresqlSamples(appHome, pluginsDir)
}

/** 解码器源码里声明的全部 discriminant——新增 kind 会在这里露出来。 */
function declaredKinds(engine: Engine): string[] {
  const text = readFileSync(join(SRC, DECODERS[engine]), 'utf8')
  const kinds = [...text.matchAll(/kind:\s*z\.literal\('([^']+)'\)/g)].map(
    (match) => match[1] ?? '',
  )
  return [...new Set(kinds)].sort()
}

async function withScratch<T>(
  run: (appHome: string, pluginsDir: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'rfc359-w5-portability-'))
  try {
    return await run(join(root, 'home'), join(root, 'plugins'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('RFC-359 W5 format corpus anchors', () => {
  test('both recovery factories and the live writer remain reachable', () => {
    expect(typeof createLegacyResourcePackageApplyArtifactRecovery).toBe('function')
    expect(typeof createPostgresqlResourcePackageApplyArtifactRecovery).toBe('function')
    const entries = Object.entries(WRITERS)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    for (const [, relative] of entries) {
      expect(existsSync(join(SRC, relative))).toBe(true)
      expect(readFileSync(join(SRC, relative), 'utf8')).toContain(
        'preparedArtifactsJson: input.codecs.encode(',
      )
    }
    expect(ARTIFACT_FORMAT_PORTABILITY).toHaveLength(12)
  })
  test('samples cover every declared kind in both formats', async () => {
    await withScratch(async (appHome, pluginsDir) => {
      for (const format of ENGINES) {
        const kinds = [...new Set(samplesOf(format, appHome, pluginsDir).map((a) => a.kind))].sort()
        expect(declaredKinds(format).length).toBeGreaterThanOrEqual(3)
        expect(kinds).toEqual(declaredKinds(format))
      }
    })
  })
})

describeEachProvider(
  'RFC-395 II-a A6 format portability through production recovery',
  (harness) => {
    test('both complete formats compensate on this provider and match all six reader cells', async () => {
      await withScratch(async (appHome, pluginsDir) => {
        const reader = harness.capabilities.isolation === 'exclusive' ? 'sqlite' : 'postgresql'
        const { users, resourceBundleApplies } = tablesOf(harness.db)
        await insertOne(harness.db, users, {
          id: 'format-owner',
          username: 'format-owner',
          displayName: 'format-owner',
          role: 'user',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        })
        const warnings: unknown[] = []
        const selected = composeResourcePackageApplyMaintenance({
          db: harness.db,
          appHome,
          pluginsDir,
          now: () => 1_000_000,
          log: {
            debug() {},
            info() {},
            error() {},
            warn: (...args) => {
              warnings.push(args)
            },
            child() {
              return this
            },
          },
        })
        const recovery = createAtomicApplyRecovery([selected.scene])
        const actual: string[] = []
        for (const format of ENGINES) {
          for (const artifact of samplesOf(format, appHome, pluginsDir)) {
            const id = `${format}-${artifact.kind}`
            // 每格都有实体残留，确保收敛执行了补偿，不能仅通过解码后吞掉 effect 错误。
            const raw = artifact as unknown as Record<string, unknown>
            const staged = raw.staged as { stagingDir: string } | undefined
            const directory = String(
              raw.generationDirectory ??
                raw.generationDir ??
                raw.stagingDirectory ??
                raw.skillDir ??
                staged?.stagingDir,
            )
            mkdirSync(directory, { recursive: true })
            writeFileSync(join(directory, 'payload'), 'prepared bytes')
            await insertOne(harness.db, resourceBundleApplies, {
              id,
              scope: 'package',
              key: id,
              actorUserId: 'format-owner',
              state: 'prepared',
              preparedArtifactsJson: JSON.stringify([artifact]),
              createdAt: 1,
              updatedAt: 1,
            })
            expect(await recovery.converge({ 'resource-package': [] })).toEqual({
              failed: 1,
              rolledForward: 0,
            })
            const persisted = (await selected.scene.list()).find((row) => row.id === id)
            expect(persisted?.state).toBe('failed')
            expect(existsSync(directory)).toBe(false)
            actual.push(`${format}/${artifact.kind} -> ${reader}: accepts`)
          }
        }
        expect(warnings).toEqual([])
        expect(actual.sort()).toEqual(
          ARTIFACT_FORMAT_PORTABILITY.filter((cell) => cell.endsWith(`-> ${reader}: accepts`)),
        )
      })
    })
    test('unknown kinds reject before effects on this provider', async () => {
      await withScratch(async (appHome, pluginsDir) => {
        const selected = composeResourcePackageApplyMaintenance({
          db: harness.db,
          appHome,
          pluginsDir,
        })
        await expect(
          selected.scene.recover(
            {
              id: 'invalid',
              state: 'prepared',
              preparedArtifactsJson: '[{"kind":"rfc359-w5-nonexistent-kind"}]',
              receiptJson: null,
              updatedAt: 0,
              error: null,
            },
            'compensate',
          ),
        ).rejects.toBeInstanceOf(ZodError)
      })
    })
  },
)
