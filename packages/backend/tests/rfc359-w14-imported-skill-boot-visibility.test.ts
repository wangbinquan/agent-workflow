// RFC-359 —— 导入进来的技能**当场可见**（RFC-170 §invariant④ 的启动复核门）。
//
// # 这条判据锁的是什么
//
// 技能有一道「本 boot 复核过吗」的门：`isSkillAvailableThisBoot`。生产启动时它被激活，
// 之后每一个读面（列表 / 详情 / 运行时注入）都只放行**这一 boot 验过**的技能。
// 一个刚刚在本进程里把内容发布到位并逐字节校验过的快照，按定义就是验过的——
// 发布方必须打上 `markSkillBootVerified`，否则行落库了、用户却看不见，直到下次重启。
//
// # 为什么它现在才被写出来（这是合一实测出的缺陷）
//
// 资源包 apply 合一之前，SQLite 那条 legacy 路径经 `commitSkillVersion` 顺带打了标记
// （`legacy/skillVersion.ts:269`），而 PostgreSQL 那台原子 apply 引擎自己写版本行、
// **一直漏打**——也就是说 **PostgreSQL 部署上导入的技能一直到重启才可见**，
// 而那一侧没有任何 e2e 打到过这条路径。RFC-359 §5dv 把这台引擎搬到 SQLite 上之后，
// `e2e/config-package-import.spec.ts` 的「两项都选新建」当场红：
// 回执说技能建好了、新代理也指向它，`GET /api/skills` 却一条都不返回。
//
// 所以这条判据两台机器各问一遍，且**把门打开**问——门关着时判据恒真、零预言力。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { users } from '@/db/schema'
import { createManagedSkillWithFiles } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { getSkillById, listSkills } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  activateBootReverifyForTest,
  isSkillBootVerified,
  resetSkillBootVerifyForTest,
} from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { describeEachProvider } from './helpers/eachProvider'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview, exportResourcePackage } from './helpers/resourcePackageProvider'
import { removeTempDirSync } from './fixtures/tempDir'

const OWNER = 'w14-skill-visibility-owner'
const roots: string[] = []

beforeEach(() => {
  // 门开着问，否则判据恒真。
  activateBootReverifyForTest()
})

afterEach(() => {
  resetSkillBootVerifyForTest()
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-359 —— 导入的技能当场可见（启动复核门开着）', (harness) => {
  async function fixture(): Promise<{
    readonly db: typeof harness.db
    readonly actor: Actor
    readonly appHome: string
    readonly box: ReturnType<typeof createSecretBoxFromKey>
    readonly sourceSkillId: string
  }> {
    const db = harness.db
    await db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Skill Owner',
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w14-skill-'))
    roots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Skill Owner',
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
    })
    const source = await createManagedSkillWithFiles(
      db,
      { appHome },
      { name: 'source-skill', description: 'fixture', ownerUserId: OWNER, actor },
      (filesDir) => {
        writeFileSync(
          join(filesDir, 'SKILL.md'),
          '---\nname: source-skill\ndescription: fixture\n---\n\n# body\n',
        )
      },
    )
    return {
      db,
      actor,
      appHome,
      box: createSecretBoxFromKey(randomBytes(32)),
      sourceSkillId: source.id,
    }
  }

  test('导入建出来的技能立刻出现在列表与详情里（不必等下次重启）', async () => {
    const f = await fixture()
    const exported = await exportResourcePackage(
      f.db,
      f.actor,
      { type: 'skill', id: f.sourceSkillId },
      { appHome: f.appHome },
    )
    const pkg = await parseResourcePackage(exported.zip)
    const preview = await buildPackagePreview(f.db, f.actor, pkg, { box: f.box, importId: ulid() })
    const receipt = (await commitResourcePackageForTest(
      { db: f.db, appHome: f.appHome, box: f.box },
      f.actor,
      {
        pkg,
        previewToken: preview.previewToken,
        decisions: [
          { localSlug: pkg.manifest.root.slug, action: 'new', finalName: 'imported-skill' },
        ],
      },
    )) as { root?: { resourceId: string } }

    const importedId = receipt.root?.resourceId
    if (importedId === undefined) throw new Error('import receipt has no root')

    // 这是缺陷的直接判据：发布方必须把它记成「本 boot 验过」。
    expect(isSkillBootVerified(importedId)).toBe(true)

    // 用户可见面：两条读路径都必须当场看得见它。
    const listed = await listSkills(f.db)
    expect(listed.map((row) => row.name).sort()).toEqual(['imported-skill', 'source-skill'])
    expect(await getSkillById(f.db, importedId)).not.toBeNull()
  })
})
