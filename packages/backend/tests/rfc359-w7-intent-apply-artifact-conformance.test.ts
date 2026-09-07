// RFC-359 W7 —— Intent apply **工件生命周期**的双引擎对拍。
//
// # 这份对拍锁的是「**不能合**」，不是「合完没退化」
//
// 本波的缺省动作是把成对适配器合成一份中立实现（见 `intentSqlProgramRunner.ts` /
// `intentPersistence.ts`）。`sqliteIntentApplyArtifactLifecycle.ts`（138 行）与
// `postgresqlIntentApplyArtifactLifecycle.ts`（439 行）**不属于那一类**：两份不是同一个算法
// 抄了两遍，是**两套不同的恢复设计**，各自配一套自己的日志工件词汇与技能发布机制。
//
// 判据（逐条在下面有可跑的断言，不是纸面结论）：
//
//   ① **工件词汇互不可解**。同一列 `intent_apply_journal.prepared_artifacts_json`，
//      两侧写进去的形状不同，且各自的解码器**拒收**对方的形状：
//        SQLite  skill-stage         `{skillId, opId, skillDir}`
//        PG      skill-stage         `{skillId, operationId, stagingDirectory}`
//        SQLite  skill-version-stage `{staged:{publishId,newVersion,newHash,filesDir,…}}`
//        PG      skill-version-stage `{skillId, operationId, version, stagingDirectory, versionDirectory}`
//      信封也不同：SQLite 是 `{version:1,artifacts:[…]}`，PG 是裸数组。
//      PG 的解码器**单向**兼容 SQLite（RFC-349 逻辑复制是 SQLite→PG 的单向迁移），反向没有。
//
//   ② **前滚算法的事实源不同**。SQLite 重放 `skill_operations` 账（`phase` =
//      db-committed / fs-published / done）；PG 没有那本账，改从 `skills` / `skill_versions`
//      行 + 目录内容哈希重新推导，自己做 candidate→version 的 rename 与 staged 的 swap-in。
//      两边的写路径分别只产出自己那一套事实，换一侧跑就是**无据可依**。
//
//   ③ **能力缺口是双向的**，谁也不是另一边的超集：
//        PG 独有：托管根包含性检查、逐工件错误隔离；
//        SQLite 独有：skill operation 账的可重放性判定与 `finishOperation` 收尾。
//      合一 = 把某一侧的缺口伪装成「已完成」，正是本波要防的事（同 `TaskLifecycleAutoRepairCommand`）。
//
// # 「不能合」不等于「一侧可以更弱」（RFC-359 W7 抬齐）
//
// 上面三条讲的是**恢复设计不同**，不是**一侧可以少做判定**。本轮从 B 段搬回 A 段一条：
// `plugin-install` 的**发布存在性判定**此前只有 PG 做（查 `plugins` 行 + `existsSync(cachedPath)`），
// SQLite 把插件工件整类跳过，于是「插件其实没装成」在 SQLite 部署上永远发现不了。
// 它与①②无关——两侧的插件工件字段名逐字相同、同一个对象在两个解码器下都解得出来，
// 差的只是解码之后有没有人去判。抬齐后判据与诊断词都逐字相同，用例进 A 段。
//
// 端口层早有同结论的记载（`modules/intent/ports/skillArtifactCompensation.ts` 头注释：
// 「端口按消费者的真实需要划，不按对称美感划」）——这份测试把它从注释变成可跑的判据。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import { plugins } from '@/db/schema'
import type { DbClient } from '@/db/client'
import {
  decodeIntentJournalArtifacts,
  encodeIntentJournalArtifacts,
  type IntentJournalArtifact,
} from '@/modules/intent/domain/journalArtifacts'
import { createSqliteIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/sqliteIntentApplyArtifactLifecycle'
import {
  createPostgresqlIntentApplyArtifactLifecycle,
  decodePostgresqlIntentApplyRecoveryArtifacts,
} from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import type {
  PostgresqlSkillArtifactCompensation,
  SqliteSkillArtifactCompensation,
} from '@/modules/intent/ports/skillArtifactCompensation'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { Logger } from '@/util/log'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

interface RecordingLog {
  readonly log: Logger
  readonly warnings: () => readonly string[]
}

function recordingLog(): RecordingLog {
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

/** SQLite 恢复路径的技能原语替身：本用例不测 RC 自己的机制，只数它被怎么调。 */
function sqliteSkillArtifacts(): SqliteSkillArtifactCompensation & {
  readonly calls: () => readonly string[]
} {
  const calls: string[] = []
  return {
    compensateManagedSkillStage() {
      calls.push('compensateManagedSkillStage')
    },
    abortStagedSkillVersion() {
      calls.push('abortStagedSkillVersion')
    },
    publishStagedSkillVersion() {
      calls.push('publishStagedSkillVersion')
    },
    unmarkSkillBootVerified() {
      calls.push('unmarkSkillBootVerified')
    },
    finishOperation() {
      calls.push('finishOperation')
    },
    loadSkillOperationState() {
      calls.push('loadSkillOperationState')
      return undefined
    },
    calls: () => calls,
  }
}

/** PostgreSQL 恢复路径的技能原语替身。 */
function postgresqlSkillArtifacts(): PostgresqlSkillArtifactCompensation & {
  readonly calls: () => readonly string[]
} {
  const calls: string[] = []
  return {
    cleanupOpDirs() {
      calls.push('cleanupOpDirs')
    },
    opCandidateDir(liveDirectory, operationId) {
      return join(liveDirectory, `.candidate-${operationId}`)
    },
    opStagedDir(liveDirectory, operationId) {
      return join(liveDirectory, `.staged-${operationId}`)
    },
    swapInStaged() {
      calls.push('swapInStaged')
    },
    hashRegularFileTree() {
      return 'sha256:fixture'
    },
    skillFilesAbs(appHome, skillId) {
      return join(appHome, 'skills', skillId, 'files')
    },
    skillVersionAbs(appHome, skillId, version) {
      return join(appHome, 'skills', skillId, 'versions', `v${version}`)
    },
    markSkillBootVerified() {
      calls.push('markSkillBootVerified')
    },
    calls: () => calls,
  }
}

/** 两侧共用的端口形状：`{compensate, rollForward}`。合一的候选就是它。 */
interface ArtifactLifecyclePort {
  compensate(artifact: never): Promise<void>
  rollForward(artifacts: readonly never[], log: Logger): Promise<boolean>
}

let appHome: string
let pluginsDir: string

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-artifact-'))
  pluginsDir = join(appHome, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
})

afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

function generationDir(name: string): string {
  const dir = join(pluginsDir, name, 'generations', 'gen-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
  return dir
}

function pluginInstallArtifact(pluginId: string, dir: string) {
  return Object.freeze({
    kind: 'plugin-install' as const,
    pluginId,
    generationId: 'gen-1',
    generationDir: dir,
  })
}

/** 本引擎在生产上真正装配的那一个工件生命周期。 */
function lifecycleFor(harness: ProviderHarness): ArtifactLifecyclePort {
  if (harness.capabilities.provider === 'postgresql') {
    return createPostgresqlIntentApplyArtifactLifecycle({
      db: harness.db as PostgresqlDatabaseClient,
      appHome,
      pluginsDir,
      skillArtifacts: postgresqlSkillArtifacts(),
    }) as unknown as ArtifactLifecyclePort
  }
  return createSqliteIntentApplyArtifactLifecycle({
    db: harness.db as DbClient,
    appHome,
    skillArtifacts: sqliteSkillArtifacts(),
  }) as unknown as ArtifactLifecyclePort
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 共同子集：两侧**确实**同义的那几条（合一的可行部分，先钉死）
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W7 Intent apply 工件生命周期 · 共同子集', (harness) => {
  test('空工件列表前滚 ⇒ true，不产生任何告警', async () => {
    const lifecycle = lifecycleFor(harness)
    const recorder = recordingLog()
    await expect(lifecycle.rollForward([], recorder.log)).resolves.toBe(true)
    expect(recorder.warnings()).toEqual([])
  })

  test('legacy-plugin-install-untracked 的补偿是静默 no-op（老行没有精确的生成代目录）', async () => {
    const lifecycle = lifecycleFor(harness)
    const survivor = generationDir('untracked-plugin')
    await lifecycle.compensate({
      kind: 'legacy-plugin-install-untracked',
      pluginId: 'untracked-plugin',
    } as never)
    expect(existsSync(survivor), '无据可依的老行不该猜着删目录').toBe(true)
  })

  test('托管根内的 plugin-install 补偿 ⇒ 删掉这一代的目录', async () => {
    const lifecycle = lifecycleFor(harness)
    const dir = generationDir('managed-plugin')
    await lifecycle.compensate(pluginInstallArtifact('managed-plugin', dir) as never)
    expect(existsSync(dir)).toBe(false)
  })

  // RFC-359 W7 抬齐③（原 B 段「分叉②」）—— plugin-install 前滚的**发布存在性**判定。
  //
  // 抬齐前：PG 查 `plugins` 行 + `existsSync(cachedPath)`，判 false 让这一行留着重试；
  // SQLite 的前滚只处理 skill-stage / skill-version-stage 两类，**插件工件被整类跳过**——
  // 于是「插件其实没装成」在 SQLite 部署上永远不会被这条路径发现。两侧字段名相同
  // （pluginId / generationId / generationDir），所以同一个对象在两个解码器下都解得出来，
  // 差的只是解码之后的判据。诊断词也必须逐字相同，否则运维的 grep 还是对不上。
  test('plugin-install 前滚：没落地的发布判 false 并记 retryable，落地了的判 true 且静默', async () => {
    const lifecycle = lifecycleFor(harness)

    // `plugins` 表里没有这一行 ⇒ 发布没落地 ⇒ 该行仍可重试。
    const missing = recordingLog()
    const orphan = pluginInstallArtifact('never-published', generationDir('never-published'))
    await expect(lifecycle.rollForward([orphan] as never[], missing.log)).resolves.toBe(false)
    expect(missing.warnings()).toEqual(['intent-apply-artifact-roll-forward-retryable'])

    const now = Date.now()
    const cachedPath = generationDir('published')
    await harness.db.insert(plugins).values({
      id: 'published',
      name: 'published',
      description: '',
      spec: 'file://fixture',
      sourceKind: 'file',
      cachedPath,
      installedAt: now,
      ownerUserId: 'rfc359-w7-owner',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    } as typeof plugins.$inferInsert)

    const published = recordingLog()
    await expect(
      lifecycle.rollForward(
        [pluginInstallArtifact('published', cachedPath)] as never[],
        published.log,
      ),
    ).resolves.toBe(true)
    expect(published.warnings()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 实测分叉：同一份工件、同一个方法，两个引擎给出**不同的答案**
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W7 Intent apply 工件生命周期 · 实测分叉', (harness) => {
  test('分叉①：托管根之外的 generationDir —— PG 拒绝，SQLite 照删', async () => {
    const lifecycle = lifecycleFor(harness)
    const outside = join(appHome, 'not-plugins', 'gen-1')
    mkdirSync(outside, { recursive: true })
    const artifact = pluginInstallArtifact('escapee', outside) as never

    if (harness.capabilities.provider === 'postgresql') {
      await expect(lifecycle.compensate(artifact)).rejects.toThrow(
        'intent-apply-maintenance-path-outside-managed-root',
      )
      expect(existsSync(outside), 'PG 侧拒绝之后目录必须原样还在').toBe(true)
      return
    }
    // SQLite 侧没有这道包含性检查：日志里写了什么就删什么。
    await lifecycle.compensate(artifact)
    expect(existsSync(outside)).toBe(false)
  })

  // 原「分叉②：plugin-install 的前滚」已于 RFC-359 W7 抬齐（SQLite 也查 `plugins` 行 +
  // `existsSync(cachedPath)`），用例搬进 A 段「plugin-install 前滚：没落地的发布判 false …」。

  test('分叉③：SQLite 形状的 skill-version-stage —— PG 的前滚拒收，要求人工按源 provider 恢复', async () => {
    if (harness.capabilities.provider !== 'postgresql') return
    const lifecycle = lifecycleFor(harness)
    const recorder = recordingLog()
    // SQLite 的 skill-version-stage 把一切塞在 `staged` 子对象里，顶层没有 operationId /
    // stagingDirectory ⇒ `decodePostgresqlArtifact` 回 null ⇒ 落到 legacy 分支。
    await expect(
      lifecycle.rollForward([sqliteSkillVersionStageArtifact()] as never[], recorder.log),
    ).resolves.toBe(false)
    expect(recorder.warnings()).toEqual(['intent-apply-artifact-roll-forward-retryable'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 工件词汇：纯编解码判据（不碰库，两个引擎上结论相同，所以只跑一遍）
// ─────────────────────────────────────────────────────────────────────────────

function sqliteSkillVersionStageArtifact(): IntentJournalArtifact {
  return {
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
  }
}

const POSTGRESQL_SKILL_STAGE = Object.freeze({
  kind: 'skill-stage',
  skillId: 'skill-1',
  operationId: 'lcop-1',
  stagingDirectory: '/tmp/skill-1/files/.staged-lcop-1',
})

const POSTGRESQL_SKILL_VERSION_STAGE = Object.freeze({
  kind: 'skill-version-stage',
  skillId: 'skill-1',
  operationId: 'lcop-1',
  version: 2,
  stagingDirectory: '/tmp/skill-1/files/.staged-lcop-1',
  versionDirectory: '/tmp/skill-1/versions/v2',
})

test('工件词汇 ①：PG 写的 skill-stage 过不了 SQLite 的解码器（字段集不同）', () => {
  expect(() => decodeIntentJournalArtifacts(JSON.stringify([POSTGRESQL_SKILL_STAGE]))).toThrow(
    /legacy intent journal artifact is invalid/,
  )
  // 套上 SQLite 的信封也一样：`.strict()` 的 skill-stage 要 opId + skillDir。
  expect(() =>
    decodeIntentJournalArtifacts(
      JSON.stringify({ version: 1, artifacts: [POSTGRESQL_SKILL_STAGE] }),
    ),
  ).toThrow(/envelope is invalid/)
})

test('工件词汇 ②：PG 写的 skill-version-stage 被 SQLite 的解码器判成不可安全收敛', () => {
  expect(() =>
    decodeIntentJournalArtifacts(JSON.stringify([POSTGRESQL_SKILL_VERSION_STAGE])),
  ).toThrow(/legacy skill-version-stage artifact is incomplete/)
})

test('工件词汇 ③：兼容是单向的 —— PG 的解码器认 SQLite 的信封，反之不成立', () => {
  const sqliteEnvelope = encodeIntentJournalArtifacts([
    { kind: 'plugin-install', pluginId: 'p', generationId: 'g', generationDir: '/tmp/g' },
  ])
  expect(decodePostgresqlIntentApplyRecoveryArtifacts(sqliteEnvelope)).toEqual([
    { kind: 'plugin-install', pluginId: 'p', generationId: 'g', generationDir: '/tmp/g' },
  ])
  // 反向：PG 写的是**裸数组**，SQLite 的解码器把裸数组当 legacy 处理，
  // 于是 PG 的原生形状在那条路径上一条都过不去（见词汇 ①/②）。
  expect(JSON.parse(sqliteEnvelope)).toHaveProperty('version', 1)
})

test('工件词汇 ④：SQLite 的 skill-version-stage 在 PG 的解码器里退成 legacy 并抛错', () => {
  // 顶层缺 operationId / stagingDirectory ⇒ decodePostgresqlArtifact 回 null ⇒
  // 交给 decodeIntentJournalArtifacts 的 legacy 数组分支 ⇒ 该分支明确拒收 skill-version-stage。
  expect(() =>
    decodePostgresqlIntentApplyRecoveryArtifacts(
      JSON.stringify([sqliteSkillVersionStageArtifact()]),
    ),
  ).toThrow(/legacy skill-version-stage artifact is incomplete/)
})
