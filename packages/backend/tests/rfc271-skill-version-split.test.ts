// RFC-271 T10 —— 技能版本提交拆成四段之后的契约。
//
// 拆分的理由只有一个：**批量导入要把「DB 提交」这一段并进自己的 big tx**，让一个
// 技能的新版本与同包其它资源要么一起可见、要么一起不可见。四段是
//   stage → commitInTx → publish → abort(pre-commit 补偿)
//
// 三条最容易在重构里丢掉的性质，各一条锁：
//
//  ① **`abort` 必须存在且可被引擎调用**。没有它，引擎只能复制这套两阶段提交状态
//     机的内部逻辑去清理——而那正是它当初为之而生的东西。
//  ② **空写（noop）仍是一个已暂存的 op**：照样在事务里重验 token，只跳过版本写入
//     与 publish。整条 op 跳过会破坏整包基线（调用方会以为该目标已被校验）。
//  ③ **`unmarkSkillBootVerified` 不在 publish 段里**。单条路径在 DB 提交返回后立刻
//     unmark；批量场景必须在 big tx 返回后、任何逐项 publish **之前**一次性 unmark
//     全部已提交技能——放进 publish 里，先发布的那个已经 mark 回来了，而后一个还
//     没发布的技能仍带着上一代的 admission。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { dbTxSync } from '../src/db/txSync'
import { createManagedSkill } from '../src/services/skill'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  listSkillVersions,
  publishStagedSkillVersion,
  stageSkillVersion,
} from '../src/services/skillVersion'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirSync(d)
})

async function seedSkill(): Promise<{
  db: DbClient
  appHome: string
  skillId: string
  initial: string
}> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-skillsplit-'))
  dirs.push(appHome)
  const db = createInMemoryDb(MIGRATIONS)
  const skill = await createManagedSkill(
    db,
    { appHome },
    { name: 'helper', description: 'd', frontmatterExtra: {}, bodyMd: 'ORIGINAL' },
    { ownerUserId: 'u1' },
  )
  // ⚠️ `createManagedSkill` 自己按 name/description/bodyMd 生成 SKILL.md，
  // 不接受调用方直接塞 files —— 所以基线内容要**读出来**再比，不能凭空假设。
  return { db, appHome, skillId: skill.id, initial: liveSkillMd(appHome, skill.id) }
}

const liveSkillMd = (appHome: string, skillId: string): string =>
  readFileSync(join(appHome, 'skills', skillId, 'files', 'SKILL.md'), 'utf8')

describe('① 四段各自可用，组合起来等于一次完整提交', () => {
  test('stage → commitInTx（外部事务）→ publish：live 内容与版本行都到位', async () => {
    const { db, appHome, skillId, initial } = await seedSkill()
    const staged = stageSkillVersion(
      db,
      { appHome },
      skillId,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: helper\n---\n\nNEXT\n'),
      { source: 'import', authorUserId: 'u1' },
    )
    expect(staged.noop).toBeNull()
    // DB 提交之前，live 还是旧内容——这正是「批量里它对别人不可见」的含义。
    expect(liveSkillMd(appHome, skillId)).toBe(initial)

    // 关键：第二段在**调用方自己的事务**里跑。
    const created = dbTxSync(db, (tx) =>
      commitSkillVersionInTx(tx, staged, { source: 'import', authorUserId: 'u1' }),
    )
    expect(created?.source).toBe('import')

    publishStagedSkillVersion(db, { appHome }, staged)
    expect(liveSkillMd(appHome, skillId)).toContain('NEXT')
    // ⚠️ 列表是新→旧序，别用 `.at(-1)` 当「最新」——按版本号取才不依赖排序方向。
    const versions = listSkillVersions(db, { appHome }, skillId)
    const newest = versions.reduce((a, v) => (v.versionIndex > a.versionIndex ? v : a))
    expect(newest.source).toBe('import')
    expect(newest.versionIndex).toBe(staged.newVersion)
  })

  test("`source:'import'` 是新增的来源枚举 —— 包导入不冒充编辑器编辑", async () => {
    const { db, appHome, skillId } = await seedSkill()
    const staged = stageSkillVersion(
      db,
      { appHome },
      skillId,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: helper\n---\n\nX\n'),
      { source: 'import', authorUserId: 'u1' },
    )
    dbTxSync(db, (tx) =>
      commitSkillVersionInTx(tx, staged, { source: 'import', authorUserId: 'u1' }),
    )
    publishStagedSkillVersion(db, { appHome }, staged)
    const sources = listSkillVersions(db, { appHome }, skillId).map((v) => v.source)
    expect(sources).toContain('import')
    expect(sources).not.toContain('editor')
  })
})

describe('② abort —— pre-commit 补偿是引擎能调用的一等公民', () => {
  test('暂存后放弃：候选目录清掉、live 不变、没有新版本行', async () => {
    const { db, appHome, skillId, initial } = await seedSkill()
    const before = listSkillVersions(db, { appHome }, skillId).length
    const staged = stageSkillVersion(
      db,
      { appHome },
      skillId,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: helper\n---\n\nABORT\n'),
      { source: 'import', authorUserId: 'u1' },
    )
    expect(existsSync(staged.versionDir)).toBe(true)

    abortStagedSkillVersion(db, staged)

    expect(existsSync(staged.versionDir)).toBe(false)
    expect(liveSkillMd(appHome, skillId)).toBe(initial)
    expect(listSkillVersions(db, { appHome }, skillId)).toHaveLength(before)
  })

  test('abort 之后该技能可以再次 stage —— op 锁真的被释放了', async () => {
    const { db, appHome, skillId } = await seedSkill()
    const first = stageSkillVersion(
      db,
      { appHome },
      skillId,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: helper\n---\n\n1\n'),
      { source: 'import', authorUserId: 'u1' },
    )
    abortStagedSkillVersion(db, first)
    // 锁没释放的话这一步会 409-busy。
    const second = stageSkillVersion(
      db,
      { appHome },
      skillId,
      (dir) => writeFileSync(join(dir, 'SKILL.md'), '---\nname: helper\n---\n\n2\n'),
      { source: 'import', authorUserId: 'u1' },
    )
    expect(second.opId).not.toBeNull()
    abortStagedSkillVersion(db, second)
  })
})

describe('③ 空写仍是 fence-only 的已暂存 op', () => {
  test('内容未变 ⇒ noop 有值、不写版本行，但**仍然**跑了事务内复核', async () => {
    const { db, appHome, skillId, initial } = await seedSkill()
    const before = listSkillVersions(db, { appHome }, skillId).length
    const staged = stageSkillVersion(
      db,
      { appHome },
      skillId,
      () => {}, // 一个字节都不改
      { source: 'editor', authorUserId: 'u1' },
    )
    expect(staged.noop).not.toBeNull()

    const created = dbTxSync(db, (tx) =>
      commitSkillVersionInTx(tx, staged, { source: 'editor', authorUserId: 'u1' }),
    )
    expect(created).toBeNull() // 没有新版本行
    expect(listSkillVersions(db, { appHome }, skillId)).toHaveLength(before)

    // publish 对 noop 是 no-op，且不该炸。
    expect(() => publishStagedSkillVersion(db, { appHome }, staged)).not.toThrow()
    expect(liveSkillMd(appHome, skillId)).toBe(initial)
  })

  test('noop 的 token 复核**真的**会拒绝漂移（不是走个过场）', async () => {
    const { db, appHome, skillId } = await seedSkill()
    const staged = stageSkillVersion(db, { appHome }, skillId, () => {}, {
      source: 'editor',
      authorUserId: 'u1',
    })
    expect(staged.noop).not.toBeNull()
    // 给一个对不上的 skillId 复合前置条件 ⇒ 事务内必须拒。
    expect(() =>
      dbTxSync(db, (tx) =>
        commitSkillVersionInTx(tx, staged, {
          source: 'editor',
          authorUserId: 'u1',
          expectedSkillId: '01SOMEONE-ELSE',
        }),
      ),
    ).toThrow()
  })
})

describe('④ unmarkSkillBootVerified 不在 publish 段里（源码层）', () => {
  test('publish 只负责发布；unmark 归调用方按批次统一做', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'skillVersion.ts'),
      'utf8',
    )
    const start = src.indexOf('export function publishStagedSkillVersion')
    expect(start).toBeGreaterThan(0)
    const end = src.indexOf('export function abortStagedSkillVersion')
    const body = src.slice(start, end)
    // publish 里 mark 回来（发布完就是已验证），但绝不 unmark。
    expect(body).toContain('markSkillBootVerified(')
    expect(body).not.toContain('unmarkSkillBootVerified(')
    // 单条组合路径仍在 DB 提交返回后立刻 unmark —— 既有行为逐字不变。
    const combined = src.slice(src.indexOf('export function commitSkillVersion('))
    expect(combined).toContain('unmarkSkillBootVerified(staged.skillId)')
  })
})
