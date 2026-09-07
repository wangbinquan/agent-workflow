// RFC-359 W8 —— 「资源包导出时怎么读一个托管技能的文件树」：合一后那一份实现的**双引擎对拍**。
//
// # 这一对是什么，为什么账本里看不见它
//
// 合一前这是一对分叉：SQLite 侧 `infrastructure/sqlitePackageSkillTree.ts` 的
// `readSqlitePackageSkillTree`，PostgreSQL 侧 `infrastructure/postgresqlResourcePackageArtifacts.ts`
// 里的 `readPostgresqlPackageSkillTree`。同一个端口（`application/package/ports.ts` 的
// `ResourcePackageSkillTree`）两份实现、两侧都是活的生产代码（SQLite 侧
// `composition/resourcePackageOperations.ts` 装配，PostgreSQL 侧
// `composition/postgresqlResourcePackageCatalog.ts` 装配，再上去是 `main.ts` 与
// `cli/postgresqlDaemonApplication.ts` 两个 bootstrap）。
// `rfc359-w5-provider-pair-conformance.test.ts` 的账本看不见它——那条判据要求两侧**同目录、
// 去掉引擎前缀后同名**，而这一对一个是独立文件、一个藏在别人的文件里。**分叉却是同一种**。
//
// # 为什么这是**用户可见**的面，而不是实现细节
//
// `services/resourcePackage/export.ts` 把这棵树逐项写进导出 ZIP 的 `skills/<slug>/…` 条目：
// **读出什么，用户下载到的包里就是什么**——文件集合、字节内容、以及 ZIP 里的条目次序。
// 所以「同一个技能、同一个 appHome，在两个引擎上导出的包一不一样」是一条纯用户可见的判据，
// 下面每条 test 都只谈这个层面的结果。
//
// # 这份对拍先在两个旧实现上跑过，五条差异全部是它照出来的
//
// 判定：**真重复**。两侧读同一张 `skills` 表、同一棵 appHome 下的技能目录、产出同一个结构体，
// 且 DB 读法（`getSkillById`）本来就吃 `ProviderNeutralDatabase`——没有任何一处需要按引擎分叉。
// 差异是 PostgreSQL 那份**重写了一遍**而没抄全 SQLite 侧攒下来的语义，外加两条 SQLite 侧的静默
// 降级。逐条（红 → 处置，处置写在 `infrastructure/packageSkillTree.ts` 的文件头）：
//
//   ① **内容版本快照 vs 活动目录**（最重）。旧 PostgreSQL 侧读 `LIVE-HALF-WRITTEN`、
//      SQLite 侧读 `SNAPSHOT-AUTHORITATIVE`。用户可见：技能刚提交过新版本、活动目录里还留着
//      半截内容时，两个引擎导出的包**字节不同**。→ 取 SQLite 侧（RFC-170 G1-1 的快照权威）。
//   ② **技能目录整个不存在**。旧 SQLite 侧返回空文件表，导出照常产出一个**零文件**的技能条目
//      （用户拿到静悄悄残缺的包，回导后技能没内容）；PostgreSQL 侧 422。→ 取 PostgreSQL 侧。
//   ③ **`managed_path` 为 NULL**。旧 PostgreSQL 侧当「技能中途消失」抛 `package-invalid`，
//      SQLite 侧照常导出。用户可见：同一行，一边 422 一边成功。→ 取 SQLite 侧：这一列的唯一
//      写出点永远写 `skills/{id}/files`，路径可由 id 推导，NULL 只是未迁移的存量。
//   ④ **条目顺序**。给定 `a.txt` / `b.txt` / `b/c.txt`，旧 SQLite 侧产出 `[a.txt, b.txt, b/c.txt]`
//      （全路径一次排序），旧 PostgreSQL 侧产出 `[a.txt, b/c.txt, b.txt]`（逐目录深度优先）。
//      用户可见：两个引擎导出的 ZIP 条目次序不同。→ 取全路径排序：与目录递归次序无关，是这里
//      唯一稳定的口径。
//   ⑤ **技能目录里有符号链接**。旧 SQLite 侧静默跳过（`walkDir` 的 "Symlinks intentionally
//      skipped in v1"），导出的包**少文件且无提示**；PostgreSQL 侧 422。→ 取 PostgreSQL 侧，
//      与②同一条理由：导出要么忠实，要么失败。**这是 SQLite 部署上的行为变更**。
//
// # 合一后这份对拍还锁什么
//
// 现在两个引擎跑的是**同一份**实现，所以它锁的是：这份中立实现在两个引擎上给用户的结果逐字
// 相同——`getSkillById` 的行读、`reservation_state` 门、快照/活动目录的取舍都不因引擎而变。
// 第一条 test 是**正向对照**：只断言「都拒绝 / 都为空」的用例，被一个「永远抛错」或「永远返回
// 空树」的实现也能满足；那一条逐字断言 frontmatter / 正文 / 文件路径集合 / 每个文件的字节，
// 任何退化实现都过不去。

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skills } from '@/db/schema'
import type { ResourcePackageSkillTree } from '@/modules/resource-catalog/application/package/ports'
// 合一后的那一份实现：同一段断言在两个引擎上各跑一遍。
import { readPackageSkillTree } from '@/modules/resource-catalog/infrastructure/packageSkillTree'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const SKILL_ID = '01JW8SKT00000000000000SKIL'
const NOW = 1_788_278_400_000

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const SKILL_MD = ['---', 'name: w8-tree', 'license: MIT', '---', '', '# 树读出对拍', ''].join('\n')

interface SeedOptions {
  /** 活动目录 `skills/{id}/files` 下的文件（相对路径 → 内容）。`null` = 整个目录都不建。 */
  readonly live: Readonly<Record<string, string>> | null
  /** `versions/v{contentVersion}/files` 下的文件；不给就不建快照目录。 */
  readonly snapshot?: Readonly<Record<string, string>>
  readonly contentVersion?: number
  readonly reservationState?: 'ready' | 'reserving'
  /** 显式写进 `skills.managed_path` 的值；不给用 `skills/{id}/files`。 */
  readonly managedPath?: string | null
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
}

describeEachProvider('RFC-359 W8 —— 资源包技能树读出的双引擎对拍', (harness: ProviderHarness) => {
  const created: string[] = []

  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function newAppHome(): string {
    const root = mkdtempSync(join(tmpdir(), 'aw-w8-skill-tree-'))
    created.push(root)
    return root
  }

  /** 落一行 `skills` + 铺好磁盘；返回 appHome。技能行不存在的用例不调它。 */
  async function seed(options: SeedOptions): Promise<string> {
    const appHome = newAppHome()
    const contentVersion = options.contentVersion ?? 1
    await harness.db.insert(skills).values({
      id: SKILL_ID,
      name: 'w8-tree',
      description: '',
      managedPath:
        options.managedPath === undefined ? `skills/${SKILL_ID}/files` : options.managedPath,
      ownerUserId: null,
      visibility: 'public',
      schemaVersion: 1,
      contentVersion,
      aclRevision: 0,
      metaRevision: 0,
      reservationState: options.reservationState ?? 'ready',
      versionState: 'snapshot-authoritative',
      createdAt: NOW,
      updatedAt: NOW,
    })
    if (options.live !== null) writeTree(join(appHome, 'skills', SKILL_ID, 'files'), options.live)
    if (options.snapshot !== undefined) {
      writeTree(
        join(appHome, 'skills', SKILL_ID, 'versions', `v${contentVersion}`, 'files'),
        options.snapshot,
      )
    }
    return appHome
  }

  function readTree(appHome: string, skillId = SKILL_ID): Promise<ResourcePackageSkillTree> {
    return readPackageSkillTree(harness.db, appHome, skillId)
  }

  async function readError(appHome: string, skillId = SKILL_ID): Promise<string> {
    try {
      await readTree(appHome, skillId)
    } catch (error) {
      return (error as { code?: string }).code ?? String(error)
    }
    return '<resolved>'
  }

  test('正向对照：SKILL.md 的 frontmatter / 正文与全部附带文件按内容原样读出（防「永远返回空树」的假绿）', async () => {
    const appHome = await seed({
      live: {
        'SKILL.md': SKILL_MD,
        'notes.md': 'plain notes',
        'assets/logo.txt': 'LOGO-BYTES',
      },
    })
    const tree = await readTree(appHome)
    expect(tree.frontmatterExtra).toEqual({ license: 'MIT' })
    expect(tree.bodyMd.trim()).toBe('# 树读出对拍')
    expect([...tree.files.map((file) => file.path)].sort()).toEqual(['assets/logo.txt', 'notes.md'])
    const byPath = new Map(tree.files.map((file) => [file.path, decode(file.bytes)]))
    expect(byPath.get('notes.md')).toBe('plain notes')
    expect(byPath.get('assets/logo.txt')).toBe('LOGO-BYTES')
  })

  test('差异①：内容版本快照存在时，导出的是权威快照而不是活动目录（RFC-170 G1-1）', async () => {
    const appHome = await seed({
      contentVersion: 3,
      live: { 'SKILL.md': SKILL_MD, 'payload.txt': 'LIVE-HALF-WRITTEN' },
      snapshot: { 'SKILL.md': SKILL_MD, 'payload.txt': 'SNAPSHOT-AUTHORITATIVE' },
    })
    const tree = await readTree(appHome)
    const payload = tree.files.find((file) => file.path === 'payload.txt')
    expect(payload, 'payload.txt 应当出现在导出的技能树里').toBeDefined()
    expect(decode(payload!.bytes)).toBe('SNAPSHOT-AUTHORITATIVE')
  })

  test('差异②：技能目录整个不存在时导出失败，而不是静悄悄产出一个零文件的技能条目', async () => {
    const appHome = await seed({ live: null })
    expect(await readError(appHome)).toBe('resource-package-skill-tree-invalid')
  })

  test('差异③：managed_path 为 NULL 不影响读出——路径由技能 id 算出', async () => {
    const appHome = await seed({
      managedPath: null,
      live: { 'SKILL.md': SKILL_MD, 'kept.txt': 'KEPT' },
    })
    const tree = await readTree(appHome)
    expect(tree.files.map((file) => file.path)).toEqual(['kept.txt'])
    expect(decode(tree.files[0]!.bytes)).toBe('KEPT')
  })

  test('差异④：条目顺序按全路径排序——`b.txt` 排在 `b/c.txt` 前面（ZIP 里的条目次序）', async () => {
    const appHome = await seed({
      live: { 'SKILL.md': SKILL_MD, 'a.txt': 'A', 'b.txt': 'B', 'b/c.txt': 'C' },
    })
    const tree = await readTree(appHome)
    expect(tree.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'b/c.txt'])
  })

  test('差异⑤：技能目录里有符号链接时导出失败，而不是静悄悄少打一个文件', async () => {
    const appHome = await seed({ live: { 'SKILL.md': SKILL_MD, 'real.txt': 'REAL' } })
    const root = join(appHome, 'skills', SKILL_ID, 'files')
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
    expect(await readError(appHome)).toBe('resource-package-skill-tree-invalid')
  })

  test('技能行不存在：以 package-invalid 收场', async () => {
    const appHome = newAppHome()
    expect(await readError(appHome)).toBe('package-invalid')
  })

  test('技能还在预留态（reservation_state != ready）：以 package-invalid 收场', async () => {
    const appHome = await seed({
      reservationState: 'reserving',
      live: { 'SKILL.md': SKILL_MD, 'kept.txt': 'KEPT' },
    })
    expect(await readError(appHome)).toBe('package-invalid')
  })
})
