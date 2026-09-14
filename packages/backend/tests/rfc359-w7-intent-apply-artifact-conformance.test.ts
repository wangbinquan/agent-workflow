// RFC-359 —— Intent apply **工件生命周期**：一台机制 + 一层旧词汇兼容面。
//
// # 这份文件此前锁的是「不能合」，现在锁的是「合成了什么」
//
// 原始结论是两份生命周期（`sqliteIntentApplyArtifactLifecycle.ts` 138 行 /
// `postgresqlIntentApplyArtifactLifecycle.ts` 439 行）**不能合**，理由三条：工件词汇互不可解、
// 前滚算法的事实源不同、能力缺口双向。第三条已经不成立了——合一没有取某一侧，而是取**并集**：
//
//   · 现行机制取 PG 那套（`skills` / `skill_versions` 行 + 目录内容哈希重推，
//     candidate→version 的 rename、staged 的 swap-in、托管根包含性检查、逐工件错误隔离）；
//   · SQLite 独有的那条——重放 `skill_operations` 账（`phase` = db-committed / fs-published /
//     done）与 `finishOperation` 收尾——**原样保留**，降级成只在读到旧词汇工件时才走的兼容面
//     （`rollForwardLegacySkillArtifacts`）。
//
// 前两条**依然为真**，而且正是兼容面存在的理由：journal 行比进程活得久。一台跑着合一之前
// 引擎的 daemon 在 apply 的提交后阶段崩了，库里留着一条 `committed` 的行，工件是旧词汇；
// 升级之后收敛器仍然要把那条尾巴走完。原始结论里的这一句是这条路唯一走得通的方向：
// 「PG 的解码器**单向**兼容 SQLite（RFC-349 逻辑复制是 SQLite→PG 的单向迁移），反向没有。」
//
// 于是本文件分三段：
//   A. 现行机制在两个 provider 上逐条同义（`describeEachProvider` 一份 body 跑两遍）；
//   B. 旧词汇的兼容面——补偿与前滚各自认得出、走得完；
//   C. 工件词汇的纯编解码判据（不碰库，两个 provider 上结论相同，只跑一遍）。
//
// 端口层早有同结论的记载（`modules/intent/ports/skillArtifactCompensation.ts` 头注释：
// 「端口按消费者的真实需要划，不按对称美感划」）——这份测试把它从注释变成可跑的判据。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import { plugins } from '@/db/schema'
import {
  decodeIntentJournalArtifacts,
  encodeIntentJournalArtifacts,
  type IntentJournalArtifact,
} from '@/modules/intent/domain/journalArtifacts'
import {
  createPostgresqlIntentApplyArtifactLifecycle,
  decodePostgresqlIntentApplyRecoveryArtifacts,
} from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import type {
  LegacyIntentSkillArtifactCompat,
  PostgresqlSkillArtifactCompensation,
} from '@/modules/intent/ports/skillArtifactCompensation'
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

/** 旧词汇恢复路径的技能原语替身：本用例不测 RC 自己的机制，只数它被怎么调。 */
function legacySkillRecovery(operation?: {
  readonly active: number
  readonly phase: string
}): LegacyIntentSkillArtifactCompat & { readonly calls: () => readonly string[] } {
  const calls: string[] = []
  return {
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
      return operation
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

/** 两个 provider 共用的端口形状：`{compensate, rollForward}`。 */
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

/**
 * 生产上真正装配的那一个工件生命周期——**两个 provider 逐字同一个**。
 * （生产装配见 `modules/intent/composition/apply.ts` 的 `composeIntentApplyArtifactLifecycle`；
 * 这里注替身只为数调用，机制本身由 RC 自己的用例覆盖。）
 */
function lifecycleFor(
  harness: ProviderHarness,
  legacy?: LegacyIntentSkillArtifactCompat,
): ArtifactLifecyclePort {
  return createPostgresqlIntentApplyArtifactLifecycle({
    db: harness.db,
    appHome,
    pluginsDir,
    skillArtifacts: postgresqlSkillArtifacts(),
    ...(legacy === undefined ? {} : { legacySkillArtifacts: legacy }),
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

describeEachProvider('RFC-359 Intent apply 工件生命周期 · 旧词汇兼容面', (harness) => {
  // 合一之前这一条是「实测分叉①：托管根之外的 generationDir —— PG 拒绝，SQLite 照删」。
  // 取并集的结果是**两个 provider 都拒绝**：那道包含性检查是强侧独有的能力，不是 provider 差异。
  test('托管根之外的 generationDir —— 两个 provider 都拒绝补偿，目录原样还在', async () => {
    const lifecycle = lifecycleFor(harness)
    const outside = join(appHome, 'not-plugins', 'gen-1')
    mkdirSync(outside, { recursive: true })

    await expect(
      lifecycle.compensate(pluginInstallArtifact('escapee', outside) as never),
    ).rejects.toThrow('intent-apply-maintenance-path-outside-managed-root')
    expect(existsSync(outside), '拒绝之后目录必须原样还在').toBe(true)
  })

  // 合一之前这一条是「实测分叉③：SQLite 形状的 skill-version-stage —— PG 的前滚拒收，
  // 要求人工按源 provider 恢复」。那个「拒收」在合一之后会变成**真实部署上的永久卡死**：
  // 一台旧引擎留下的 committed 行，收敛器每小时看一次、每次都前滚不了。所以兼容面必须在。
  test('旧词汇的 skill-version-stage —— 前滚走兼容面：整批先撤 boot 标记再逐条发布', async () => {
    const recovery = legacySkillRecovery({ active: 1, phase: 'db-committed' })
    const lifecycle = lifecycleFor(harness, recovery)
    const recorder = recordingLog()

    await expect(
      lifecycle.rollForward([legacySkillVersionStageArtifact()] as never[], recorder.log),
    ).resolves.toBe(true)
    expect(recorder.warnings(), '走得完就不该记 retryable').toEqual([])
    expect(recovery.calls()).toEqual([
      'loadSkillOperationState',
      'unmarkSkillBootVerified',
      'publishStagedSkillVersion',
    ])
  })

  test('旧词汇的 skill-version-stage —— operation 账不可重放时判 false 并记 retryable', async () => {
    const recovery = legacySkillRecovery({ active: 0, phase: 'fs-staged' })
    const lifecycle = lifecycleFor(harness, recovery)
    const recorder = recordingLog()

    await expect(
      lifecycle.rollForward([legacySkillVersionStageArtifact()] as never[], recorder.log),
    ).resolves.toBe(false)
    expect(recorder.warnings()).toEqual(['intent-skill-publish-op-not-replayable'])
    expect(recovery.calls()).toEqual(['loadSkillOperationState'])
  })

  test('旧词汇的 skill-stage —— 前滚把 db-committed 的 operation 行收尾', async () => {
    const recovery = legacySkillRecovery({ active: 1, phase: 'db-committed' })
    const lifecycle = lifecycleFor(harness, recovery)
    const recorder = recordingLog()

    await expect(
      lifecycle.rollForward(
        [
          { kind: 'skill-stage', skillId: 'skill-1', opId: 'op-1', skillDir: '/tmp/skill-1' },
        ] as never[],
        recorder.log,
      ),
    ).resolves.toBe(true)
    expect(recorder.warnings()).toEqual([])
    expect(recovery.calls()).toEqual(['loadSkillOperationState', 'finishOperation'])
  })

  // 兼容面没装配 = 旧行前滚不了。判 false（留着重试）而**不是**判 failed——把一条还能救的
  // 行终态化成失败，等于把半成品永久留在盘上。
  test('兼容面未装配时旧词汇工件判 false 并记 retryable，绝不终态化', async () => {
    const lifecycle = lifecycleFor(harness)
    const recorder = recordingLog()

    await expect(
      lifecycle.rollForward([legacySkillVersionStageArtifact()] as never[], recorder.log),
    ).resolves.toBe(false)
    expect(recorder.warnings()).toEqual(['intent-apply-artifact-roll-forward-retryable'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 工件词汇：纯编解码判据（不碰库，两个引擎上结论相同，所以只跑一遍）
// ─────────────────────────────────────────────────────────────────────────────

function legacySkillVersionStageArtifact(): IntentJournalArtifact {
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

test('工件词汇 ①：现行词汇的 skill-stage 过不了旧解码器（字段集不同）', () => {
  expect(() => decodeIntentJournalArtifacts(JSON.stringify([POSTGRESQL_SKILL_STAGE]))).toThrow(
    /legacy intent journal artifact is invalid/,
  )
  // 套上旧信封也一样：`.strict()` 的 skill-stage 要 opId + skillDir。
  expect(() =>
    decodeIntentJournalArtifacts(
      JSON.stringify({ version: 1, artifacts: [POSTGRESQL_SKILL_STAGE] }),
    ),
  ).toThrow(/envelope is invalid/)
})

test('工件词汇 ②：现行词汇的 skill-version-stage 被旧解码器判成不可安全收敛', () => {
  expect(() =>
    decodeIntentJournalArtifacts(JSON.stringify([POSTGRESQL_SKILL_VERSION_STAGE])),
  ).toThrow(/legacy skill-version-stage artifact is incomplete/)
})

test('工件词汇 ③：兼容是单向的 —— 现行解码器认旧信封，反之不成立', () => {
  const sqliteEnvelope = encodeIntentJournalArtifacts([
    { kind: 'plugin-install', pluginId: 'p', generationId: 'g', generationDir: '/tmp/g' },
  ])
  expect(decodePostgresqlIntentApplyRecoveryArtifacts(sqliteEnvelope)).toEqual([
    { kind: 'plugin-install', pluginId: 'p', generationId: 'g', generationDir: '/tmp/g' },
  ])
  // 反向：现行引擎写的是**裸数组**，旧解码器把裸数组当 pre-v1 处理，
  // 于是现行形状在那条路径上一条都过不去（见词汇 ①/②）。
  expect(JSON.parse(sqliteEnvelope)).toHaveProperty('version', 1)
})

test('工件词汇 ④：**裸数组**里的 skill-version-stage 是 pre-v1 残骸，解码器明确拒收', () => {
  // 顶层缺 operationId / stagingDirectory ⇒ decodePostgresqlArtifact 回 null ⇒
  // 交给 decodeIntentJournalArtifacts 的**裸数组**分支 ⇒ 该分支明确拒收 skill-version-stage
  // （pre-v1 只存了三个字段，不足以发布一个已提交的版本）。带 v1 信封的那条路走得通，
  // 见上面「旧词汇的 skill-version-stage —— 前滚走兼容面」。
  expect(() =>
    decodePostgresqlIntentApplyRecoveryArtifacts(
      JSON.stringify([legacySkillVersionStageArtifact()]),
    ),
  ).toThrow(/legacy skill-version-stage artifact is incomplete/)
})
