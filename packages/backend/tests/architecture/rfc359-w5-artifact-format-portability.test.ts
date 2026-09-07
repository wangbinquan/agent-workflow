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
// `modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts:82-99` 的
// `decodePostgresqlIntentApplyRecoveryArtifacts` 逐条先试 PG 形状、不认就回落到 SQLite 解码器。
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
//   · 原有的 rejects **变成 accepts**——缺口补上了（照 `postgresqlIntentApplyArtifactLifecycle.ts:82-99`
//     那样加跨格式回落），**把这条账本条目一起改掉**，让这次收敛留下一次有署名的提交记录；
//   · 同引擎那 6 格必须恒为 accepts——它们掉成 rejects 说明样本或解码器坏了，此刻本守卫零预言力。
//
// 配套的锚点用例（RFC-317 T13「扫空 = 假绿」的同款纪律）在下面：两侧工厂必须 import 得到、
// 两侧解码器必须以 ZodError 拒绝未知 kind、样本 kind 必须覆盖解码器声明的全部 kind、
// 两个写出点必须还在写这一列。任何一条被改名 / 挪走，守卫**红**，而不是静默假绿。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ZodError } from 'zod'

import type {
  ResourcePackageApplyArtifactRecoveryPort,
  ResourcePackageApplyJournalSnapshot,
} from '../../src/modules/resource-catalog/application/resourcePackageMaintenance'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '../../src/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { createSqliteResourcePackageApplyArtifactRecovery } from '../../src/modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance'
import { opStagedDir } from '../../src/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import {
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from '../../src/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import type { PostgresqlResourcePackageMutationArtifact } from '../../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { BundleArtifact } from '../../src/services/bundle/provider'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * `<写出引擎>/<kind> -> <读回引擎>: accepts|rejects`，按行字典序。
 *
 * 六格 `rejects` 就是本条守卫钉住的缺口：**跨引擎迁移后存量恢复工件读不回来**。补上桥接
 * （形如 `modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts:82-99`）之后
 * 把对应行改成 `accepts`，不要删掉整条守卫——矩阵本身还要继续防守新增的不可移植格式。
 *
 * 它**不是** RFC-317 T72 意义上的债务账本，所以不带 `_DEBT` 后缀、也不进
 * `architecture/ledger-baselines.json`：账本记的是「还欠多少」，而这里记的是**全矩阵的实测
 * 裁决**——十二格里有六格是「本来就该 accepts」的正向断言，给它钉一个「只降不升的条数」没有
 * 意义（条数恒等于 `写出引擎 × kind × 读回引擎`）。真正的债是那六格 `rejects`，它们由上面那条
 * 逐字相等断言直接钉住，收敛时必须改这份文本，一样留痕。
 */
export const ARTIFACT_FORMAT_PORTABILITY: readonly string[] = [
  'postgresql/plugin-install -> postgresql: accepts',
  'postgresql/plugin-install -> sqlite: rejects',
  'postgresql/skill-stage -> postgresql: accepts',
  'postgresql/skill-stage -> sqlite: rejects',
  'postgresql/skill-version-stage -> postgresql: accepts',
  'postgresql/skill-version-stage -> sqlite: rejects',
  'sqlite/plugin-install -> postgresql: rejects',
  'sqlite/plugin-install -> sqlite: accepts',
  'sqlite/skill-stage -> postgresql: rejects',
  'sqlite/skill-stage -> sqlite: accepts',
  'sqlite/skill-version-stage -> postgresql: rejects',
  'sqlite/skill-version-stage -> sqlite: accepts',
]

/** 落盘工件写出点：`preparedArtifactsJson` 的两个来源，按引擎。 */
const WRITERS: Readonly<Record<Engine, string>> = {
  sqlite: 'platform/persistence/sqlite/legacyResourcePackageBundleApply.ts',
  postgresql: 'platform/persistence/postgresqlResourcePackageAtomicApply.ts',
}

/** 落盘工件读回点：`.strict()` 解码器所在文件，按引擎。 */
const DECODERS: Readonly<Record<Engine, string>> = {
  sqlite: 'modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts',
  postgresql: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
}

type Engine = 'sqlite' | 'postgresql'

const ENGINES: readonly Engine[] = ['postgresql', 'sqlite']

const SKILL_ID = '01JGUARD0000000000000SKILL'
const PLUGIN_ID = '01JGUARD00000000000PLUGIN'
const GENERATION_ID = '01JGUARD000000000000000GEN'
const OPERATION_ID = '01JGUARD0000000000000000OP'
const PUBLISH_ID = '01JGUARD00000000000000PUB'
const VERSION = 2

/**
 * 探针**绝不接触真实数据库**：任何属性读取都立刻抛一个可读的普通 `Error`。
 *
 * 解码在两侧 `compensate()` 的循环之外，所以判「解码器认不认」根本走不到这里；真正会走到的
 * 只有解码**成功之后**的补偿正身（例如 SQLite 的 `skill-stage` 要去 abandon 那笔 skill
 * operation）。那种情况下抛出的是普通 `Error` 而非 `ZodError`，`verdict()` 照样判成
 * `accepts`——判据问的是「解码器收不收这条记录」，不是「补偿能不能跑完」。
 * 用 Proxy 而不是 `{}`，只为让这条边界在栈里以人话出现，而不是一句
 * `undefined is not a function`。
 */
function neverTouchedDatabase(): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `rfc359-w5 portability probe refuses database access (property "${String(property)}")`,
        )
      },
    },
  ) as never
}

/** SQLite 侧的代表性落盘样本。类型标注即锚点：`BundleArtifact` 改形状/改名 → 本文件编译失败。 */
function sqliteSamples(appHome: string, pluginsDir: string): readonly BundleArtifact[] {
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
        // `null` 让补偿路径停在纯文件系统那一段：正向那一半不该依赖任何数据库。
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

function recoveryOf(
  engine: Engine,
  appHome: string,
  pluginsDir: string,
): ResourcePackageApplyArtifactRecoveryPort {
  return engine === 'sqlite'
    ? createSqliteResourcePackageApplyArtifactRecovery({
        db: neverTouchedDatabase(),
        appHome,
        pluginsDir,
      })
    : createPostgresqlResourcePackageApplyArtifactRecovery({
        db: neverTouchedDatabase(),
        appHome,
        pluginsDir,
      })
}

function journalOf(artifacts: readonly unknown[]): ResourcePackageApplyJournalSnapshot {
  return Object.freeze({
    id: 'rfc359-w5-portability-probe',
    state: 'prepared',
    preparedArtifactsJson: JSON.stringify(artifacts),
    receiptJson: null,
    updatedAt: 0,
  })
}

/**
 * 真实生产解码器对这条落盘记录的裁决。
 *
 * `rejects` 的判据是**解码阶段**逃出的 `ZodError`——两侧 `compensate()` 都在循环之外先解码，
 * 循环内的文件系统 / 数据库异常一律被逐工件 try/catch 收成普通 `Error`，不会伪装成 ZodError。
 * 「解码器还是 zod、且以 ZodError 拒绝坏载荷」这个前提由下面的锚点用例单独守着。
 */
async function verdict(
  recovery: ResourcePackageApplyArtifactRecoveryPort,
  artifacts: readonly unknown[],
): Promise<'accepts' | 'rejects'> {
  try {
    await recovery.compensate(journalOf(artifacts))
    return 'accepts'
  } catch (error) {
    return error instanceof ZodError ? 'rejects' : 'accepts'
  }
}

/** 解码器源码里声明的全部 discriminant——新增 kind 会在这里露出来。 */
function declaredKinds(engine: Engine): string[] {
  const text = readFileSync(join(SRC, DECODERS[engine]), 'utf8')
  const kinds = [...text.matchAll(/kind:\s*z\.literal\('([^']+)'\)/g)].map(
    (match) => match[1] ?? '',
  )
  return [...new Set(kinds)].sort()
}

function withScratch<T>(run: (appHome: string, pluginsDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rfc359-w5-portability-'))
  try {
    return run(join(root, 'home'), join(root, 'plugins'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('RFC-359 W5 —— 落盘恢复工件的跨引擎可读性', () => {
  test('锚点：两侧恢复端口工厂 import 得到（改名 / 挪走 → 红，而不是静默假绿）', () => {
    expect(typeof createSqliteResourcePackageApplyArtifactRecovery).toBe('function')
    expect(typeof createPostgresqlResourcePackageApplyArtifactRecovery).toBe('function')
  })

  test('锚点：两个写出点仍在写 `preparedArtifactsJson`（探的是活着的那一列）', () => {
    for (const engine of ENGINES) {
      const path = join(SRC, WRITERS[engine])
      expect(existsSync(path), `${WRITERS[engine]} 不在了——写出点被挪走，账本失去归属`).toBe(true)
      expect(
        readFileSync(path, 'utf8'),
        `${WRITERS[engine]} 不再写 preparedArtifactsJson——写出侧变了，本守卫此刻零预言力`,
      ).toContain('preparedArtifactsJson: JSON.stringify(')
    }
  })

  test('锚点：两侧解码器都以 ZodError 拒绝未知 kind（`rejects` 的判据成立的前提）', async () => {
    await withScratch(async (appHome, pluginsDir) => {
      for (const engine of ENGINES) {
        const recovery = recoveryOf(engine, appHome, pluginsDir)
        await expect(
          recovery.compensate(journalOf([{ kind: 'rfc359-w5-nonexistent-kind' }])),
          `${engine} 解码器没有以 ZodError 拒绝未知 kind——` +
            '要么它不再是 zod，要么它已经放行任意载荷；两种情况下本守卫的 `rejects` 判据都失效了，' +
            '请把 `verdict()` 的判据改成新解码器的拒绝信号。',
        ).rejects.toBeInstanceOf(ZodError)
      }
    })
  })

  test('锚点：样本覆盖解码器声明的全部 kind（新增一个 kind 就红，不会漏测）', () => {
    withScratch((appHome, pluginsDir) => {
      for (const engine of ENGINES) {
        const kinds = [...new Set(samplesOf(engine, appHome, pluginsDir).map((a) => a.kind))].sort()
        const declared = declaredKinds(engine)
        // 语料下限守的是**扫描机制本身**：正则失配 / 解码器换写法会让 `declared` 变空，
        // 此时下面那条相等断言会变成「空 == 空」的假绿（RFC-317 T13）。
        expect(
          declared.length,
          `${DECODERS[engine]} 里一个 \`kind: z.literal(...)\` 都没扫到——` +
            'discriminant 提取失配，此刻本条锚点零预言力，先修 `declaredKinds()` 的正则。',
        ).toBeGreaterThanOrEqual(3)
        expect(
          kinds,
          `${engine} 的样本没有覆盖它自己解码器声明的全部 kind——新 kind 落盘后无人验证可移植性`,
        ).toEqual(declared)
      }
    })
  })

  test('跨引擎可读性矩阵与账本逐字相等（补上桥接也要红，把账本一起改掉）', async () => {
    const rows = await withScratch(async (appHome, pluginsDir) => {
      const out: string[] = []
      for (const writer of ENGINES) {
        for (const artifact of samplesOf(writer, appHome, pluginsDir)) {
          for (const reader of ENGINES) {
            const recovery = recoveryOf(reader, appHome, pluginsDir)
            out.push(
              `${writer}/${artifact.kind} -> ${reader}: ${await verdict(recovery, [artifact])}`,
            )
          }
        }
      }
      return out.sort()
    })

    expect(
      rows,
      '落盘恢复工件的跨引擎可读性矩阵与账本不符。\n' +
        '**新出现 rejects**：又多了一种只有单个引擎读得回来的落盘格式——跨引擎迁移后它名下的 ' +
        'journal 行会永久卡住、半成品目录永远收不掉。请给读回侧加跨格式回落，' +
        '照 `modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts:82-99` 的形状写，' +
        '不要靠扩账本了事。\n' +
        '**rejects 变成 accepts**：缺口已补——把账本里这一行改成 accepts，' +
        '让这次收敛留下一次有署名的提交记录。\n' +
        '**同引擎那六格掉成 rejects**：样本或解码器坏了，此刻本守卫零预言力，先修它。',
    ).toEqual([...ARTIFACT_FORMAT_PORTABILITY])
  })

  test('账本按行字典序、无重复且矩阵完整（清点稳定的前提）', () => {
    expect(new Set(ARTIFACT_FORMAT_PORTABILITY).size, '账本里有重复行').toBe(
      ARTIFACT_FORMAT_PORTABILITY.length,
    )
    expect([...ARTIFACT_FORMAT_PORTABILITY].sort()).toEqual([...ARTIFACT_FORMAT_PORTABILITY])
    // 2 个写出引擎 × 3 个 kind × 2 个读回引擎。
    expect(ARTIFACT_FORMAT_PORTABILITY.length).toBe(12)
  })
})
