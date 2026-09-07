// RFC-359 W9 —— 资源包崩溃恢复里「**这个技能代际还该不该落盘**」的双引擎对拍。
//
// # 场景（纯用户可见）
//
// 守护进程在应用一个资源包的半路上死掉，此刻某个托管技能的新版本内容已经**铺在盘上**
// （`skills/{id}/files.op-{publishId}.staged`）但还没换进 live 目录。进程重启后收敛器跑
// `ResourcePackageApplyArtifactRecoveryPort.rollForward`。用户接下来看到的就是**这个技能的
// live 目录里到底是哪一代内容**——它直接决定 agent 下一次运行读到什么技能文件。
//
// 崩溃到收敛之间是有时间的，用户在这段时间里完全可能：又发布了一版、把技能删了、或者数据库
// 因为别的原因回滚到更早的代际。于是同一份落盘工件，面对四种不同的账面状态：
//
//   | `skills.content_version` vs 工件的 `newVersion` | 该怎么办 | 用户可见 |
//   |---|---|---|
//   | 相等            | 换进去（roll-forward） | 技能内容变成崩溃前正在发布的那一版 |
//   | 账面**更新**    | 别换，清掉暂存       | 技能保持用户后发布的**新**内容 |
//   | 技能行**没了**  | 别换，清掉暂存       | 已删技能的目录**不复活** |
//   | 账面**更旧**    | 报错（可重试）       | 收敛失败并留痕，而不是把库不认识的代际换进去 |
//
// # 这份对拍照出的差异（先在两个旧实现上跑出来的红）
//
// PostgreSQL 侧有 `postgresqlResourcePackageSkillRecoveryDisposition` 的四分支；**SQLite 侧的
// `publishStagedVersion` 从头到尾不读 `skills.content_version`、也不看技能行还在不在**，无条件
// `swapInStaged`。于是后三格全错，且都是静默的：
//
//   · **账面更新** ⇒ SQLite 把**陈旧代际**换回 live 目录。用户明明刚发布了 v3，收敛跑完技能内容
//     退回 v2，而 `content_version` 还写着 3——磁盘与账面从此对不上，没有任何报错。
//   · **技能已删** ⇒ SQLite 把已删技能的 `skills/{id}/files` **原地复活**（`swapInStaged` 在
//     staged 在、live 不在时直接 rename 进去），留下一棵没有数据库行的孤儿目录。
//   · **账面更旧** ⇒ SQLite 把数据库根本不认识的代际换进 live 目录并报成功。
//
// 第一格（相等）两侧本来就一致，它在这里当**正向对照**：逐字断言 live 目录的文件名与字节，
// 一个「永远清理、什么都不换」或「永远抛错」的退化实现过不去这一条。
//
// # 两侧各喂自己那套落盘工件格式
//
// `prepared_artifacts_json` 被两套互不认识的格式写着（已由
// `tests/architecture/rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵钉住），
// 所以这里按引擎构造各自的工件：SQLite 是嵌套的 `staged{…opId/publishId/newVersion/newHash}`、
// PostgreSQL 是扁平的 `{operationId/version/…}` 且 roll-forward 还要过 receipt 门与
// `skill_versions` 快照。判据只谈**结果**，不谈这两套格式。
//
// 合一后的判定函数是中立的 `domain/resourcePackageSkillRecovery.ts`
// （`resourcePackageSkillRecoveryDisposition`），两个引擎调同一份。

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { resourceBundleApplies, skillVersions, skills } from '@/db/schema'
import type { ResourcePackageApplyArtifactRecoveryPort } from '@/modules/resource-catalog/application/resourcePackageMaintenance'
import { createPostgresqlResourcePackageApplyArtifactRecovery } from '@/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { createSqliteResourcePackageApplyArtifactRecovery } from '@/modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance'
import { hashRegularFileTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import { opStagedDir } from '@/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import {
  skillFilesAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const SKILL_ID = '01JW9RCV000000000000000SKL'
const JOURNAL_ID = '01JW9RCV0000000000000JRNL'
const PUBLISH_ID = '01JW9RCV00000000000000PUB'
const NOW = 1_788_278_400_000

/** 崩溃前正在发布的那一代内容。 */
const STAGED_TREE: Readonly<Record<string, string>> = {
  'SKILL.md': '---\nname: w9-recovery\n---\n\nSTAGED GENERATION\n',
  'notes.txt': 'STAGED-NOTES',
}
/** 崩溃后 live 目录里的内容（用户后发布的那一版，或崩溃前的旧版）。 */
const LIVE_TREE: Readonly<Record<string, string>> = {
  'SKILL.md': '---\nname: w9-recovery\n---\n\nLIVE GENERATION\n',
  'notes.txt': 'LIVE-NOTES',
}

const ARTIFACT_VERSION = 2

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content)
}

/** live 目录的可读快照：不存在 = `null`，存在则是 `路径 → 内容` 的表。 */
function snapshotTree(root: string): Readonly<Record<string, string>> | null {
  if (!existsSync(root)) return null
  const out: Record<string, string> = {}
  for (const name of readdirSync(root).sort()) out[name] = readFileSync(join(root, name), 'utf8')
  return out
}

describeEachProvider(
  'RFC-359 W9 —— 资源包技能恢复的代际判定（双引擎对拍）',
  (harness: ProviderHarness) => {
    const created: string[] = []
    afterEach(() => {
      for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    const sqliteSide = (): boolean => harness.capabilities.isolation === 'exclusive'

    function newAppHome(): string {
      const root = mkdtempSync(join(tmpdir(), 'aw-w9-skill-recovery-'))
      created.push(root)
      return root
    }

    /** 本引擎自己的那套落盘工件。两套格式的差异只出现在这一处。 */
    function artifactsJson(appHome: string): string {
      const liveDirectory = skillFilesAbs(appHome, SKILL_ID)
      const versionDirectory = skillVersionAbs(appHome, SKILL_ID, ARTIFACT_VERSION)
      const stagingDirectory = opStagedDir(liveDirectory, PUBLISH_ID)
      if (sqliteSide()) {
        return JSON.stringify([
          {
            kind: 'skill-version-stage',
            staged: {
              skillId: SKILL_ID,
              skillName: 'w9-recovery',
              opId: null,
              publishId: PUBLISH_ID,
              newVersion: ARTIFACT_VERSION,
              newHash: hashRegularFileTree(stagingDirectory),
              filesDir: liveDirectory,
              versionDir: versionDirectory,
              stagingDir: stagingDirectory,
              noop: null,
            },
          },
        ])
      }
      return JSON.stringify([
        {
          kind: 'skill-version-stage',
          operationId: PUBLISH_ID,
          skillId: SKILL_ID,
          publishId: PUBLISH_ID,
          version: ARTIFACT_VERSION,
          stagingDirectory,
          versionDirectory,
        },
      ])
    }

    /** PostgreSQL 的 roll-forward 走 receipt 门；SQLite 不看 receipt。 */
    function receiptJson(): string | null {
      if (sqliteSide()) return null
      return JSON.stringify({
        journalId: JOURNAL_ID,
        applied: [
          {
            resourceType: 'skill',
            operationId: PUBLISH_ID,
            resourceId: SKILL_ID,
            action: 'update',
            name: 'w9-recovery',
          },
        ],
      })
    }

    function recoveryFor(appHome: string): ResourcePackageApplyArtifactRecoveryPort {
      const pluginsDir = join(appHome, 'plugins')
      return sqliteSide()
        ? createSqliteResourcePackageApplyArtifactRecovery({
            db: harness.db as unknown as DbClient,
            appHome,
            pluginsDir,
          })
        : createPostgresqlResourcePackageApplyArtifactRecovery({
            db: harness.db as unknown as PostgresqlDatabaseClient,
            appHome,
            pluginsDir,
          })
    }

    /**
     * 铺好「崩溃后」的现场：staged 目录在盘上，live 目录按 `liveTree` 铺（`null` = 技能被删、
     * 目录也没了），`skills.content_version` 置成 `contentVersion`（`null` = 技能行不存在）。
     */
    async function crashScene(options: {
      readonly contentVersion: number | null
      readonly liveTree?: Readonly<Record<string, string>> | null
    }): Promise<{ appHome: string; liveDirectory: string }> {
      const appHome = newAppHome()
      const liveDirectory = skillFilesAbs(appHome, SKILL_ID)
      writeTree(opStagedDir(liveDirectory, PUBLISH_ID), STAGED_TREE)
      const liveTree = options.liveTree === undefined ? LIVE_TREE : options.liveTree
      if (liveTree !== null) writeTree(liveDirectory, liveTree)

      if (options.contentVersion !== null) {
        await harness.db.insert(skills).values({
          id: SKILL_ID,
          name: 'w9-recovery',
          description: '',
          managedPath: `skills/${SKILL_ID}/files`,
          ownerUserId: null,
          visibility: 'public',
          schemaVersion: 1,
          contentVersion: options.contentVersion,
          aclRevision: 0,
          metaRevision: 0,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
          createdAt: NOW,
          updatedAt: NOW,
        })
        // PostgreSQL 的 roll-forward 还要读 `skill_versions` 的快照（filesPath + contentHash）。
        if (!sqliteSide()) {
          const versionDirectory = skillVersionAbs(appHome, SKILL_ID, ARTIFACT_VERSION)
          writeTree(versionDirectory, STAGED_TREE)
          await harness.db.insert(skillVersions).values({
            id: `${SKILL_ID}-v${ARTIFACT_VERSION}`,
            skillId: SKILL_ID,
            versionIndex: ARTIFACT_VERSION,
            filesPath: skillVersionRelPath(SKILL_ID, ARTIFACT_VERSION),
            source: 'import',
            summary: null,
            fusionId: null,
            restoredFromVersion: null,
            authorUserId: null,
            contentHash: hashRegularFileTree(versionDirectory),
            createdAt: NOW,
          })
        }
      }

      await harness.db.insert(resourceBundleApplies).values({
        id: JOURNAL_ID,
        scope: 'package',
        key: `key-${JOURNAL_ID}`,
        actorUserId: 'w9-actor',
        state: 'committed',
        preparedArtifactsJson: artifactsJson(appHome),
        receiptJson: receiptJson(),
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      return { appHome, liveDirectory }
    }

    /** 跑收敛，返回错误码（成功 = `'<resolved>'`）。 */
    async function rollForward(): Promise<string> {
      const rows = await harness.db
        .select()
        .from(resourceBundleApplies)
        .where(eq(resourceBundleApplies.id, JOURNAL_ID))
      const row = rows[0]!
      const journal = {
        id: row.id,
        state: row.state,
        preparedArtifactsJson: row.preparedArtifactsJson,
        receiptJson: row.receiptJson,
        updatedAt: row.updatedAt,
      }
      try {
        await recoveryFor(appHomeOf(row.preparedArtifactsJson)).rollForward(journal)
      } catch (error) {
        return (error as Error).message
      }
      return '<resolved>'
    }

    /** appHome 是每个用例的临时目录，从工件里的绝对路径反解出来。 */
    function appHomeOf(preparedArtifactsJson: string): string {
      const parsed = JSON.parse(preparedArtifactsJson) as ReadonlyArray<Record<string, unknown>>
      const first = parsed[0]!
      const dir =
        'staged' in first
          ? String((first['staged'] as Record<string, unknown>)['filesDir'])
          : String(first['stagingDirectory'])
      return dir.slice(0, dir.indexOf(`${'/skills/'}${SKILL_ID}`))
    }

    test('正向对照 · 账面与工件同代：崩溃前正在发布的那一版内容被换进 live 目录（防「永远只清理」的假绿）', async () => {
      const { liveDirectory } = await crashScene({ contentVersion: ARTIFACT_VERSION })
      expect(await rollForward()).toBe('<resolved>')
      expect(snapshotTree(liveDirectory)).toEqual(STAGED_TREE)
    })

    test('账面更新（用户在崩溃后又发布了一版）：live 目录保持新内容，陈旧代际不得被换回去', async () => {
      const { liveDirectory } = await crashScene({ contentVersion: ARTIFACT_VERSION + 1 })
      expect(await rollForward()).toBe('<resolved>')
      expect(
        snapshotTree(liveDirectory),
        'live 目录被换成了崩溃前那一代——用户刚发布的内容被静默回退',
      ).toEqual(LIVE_TREE)
    })

    test('技能已被删除：已删技能的目录不得复活成一棵没有数据库行的孤儿树', async () => {
      const { liveDirectory } = await crashScene({ contentVersion: null, liveTree: null })
      expect(await rollForward()).toBe('<resolved>')
      expect(snapshotTree(liveDirectory), '已删技能的 live 目录被收敛器复活了').toBeNull()
    })

    test('账面更旧（库不认识这一代）：收敛报错留痕，不得把未知代际换进 live 目录', async () => {
      const { liveDirectory } = await crashScene({ contentVersion: ARTIFACT_VERSION - 1 })
      expect(await rollForward()).toContain('resource-package-skill-publication-missing')
      expect(snapshotTree(liveDirectory), '库不认识的代际被换进了 live 目录').toEqual(LIVE_TREE)
    })
  },
)
