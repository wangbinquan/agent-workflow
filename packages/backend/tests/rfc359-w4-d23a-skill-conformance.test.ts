// RFC-359 W4-D23a —— 技能目录的双引擎一致性取证。
//
// 技能是剩余最大的一块 provider 分叉，也是覆盖最倒挂的一块：SQLite 侧是薄适配器套成熟的崩溃安全
// 机器（`legacy/skill*` 共 5882 行、45 处 `dbTxSync`），PostgreSQL 侧是 3342 行原生重写，归一化
// 相似度只有 7%，而两侧的测试覆盖是 52 : 6——PG 那份几乎没有行为覆盖，装配甚至没有任何测试**活着
// 构造**过（现有引用全是源码文本锁）。
//
// 合一（D23b/c）之前先按 D19b/D19c 的方法论取证：**按端口数覆盖、不是按实现数**——把同一批场景
// 通过同一个 `SkillCatalogModule` 端口在两个引擎上各跑一遍，用实测差异代替纸面对账。这份文件是
// D23 的判据基线：它现在锁住的每一条，合一之后都必须继续成立。

import { afterAll, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { SkillOperationContext } from '@/modules/resource-catalog/public/participants'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { composeTestSkillCatalog } from './helpers/skillCatalog'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'user-d23a'

// 技能的「本次启动已验证」集合是**进程级**的（`legacy/skillBootVerify.ts` 的模块级 Set），
// 本文件建的技能会落进去。跑完清干净，免得给同进程里后跑的文件留状态。
//
// （顺带记一笔：把全部 skill 套件放进同一个 bun 进程跑时，`skill-versioning` 的「legacy 技能
// 编辑后 v1/v2」与 RFC-170 的 rollforward 两条会红成 `skill-not-found`。这**不是**本文件引入的
// ——去掉本文件照红，加上也照红；CI 分片把它们分开才没暴露。已记进 docs/audit-backlog.md。）
afterAll(() => {
  resetSkillBootVerifyForTest()
})

function authorityOf(userId: string, role: 'admin' | 'user' = 'admin'): SkillOperationContext {
  return {
    user: { id: userId, username: userId, displayName: userId, role, status: 'active' },
    userId,
    source: 'session',
    permissions: new Set(['resource-acl:private']),
  } as unknown as SkillOperationContext
}

function jsonBody(body: unknown): { kind: 'json-body'; body: string } {
  return { kind: 'json-body', body: JSON.stringify(body) }
}

/** 建一个最小的托管技能，回传它的 id 与名字。 */
async function createSkill(
  catalog: ReturnType<typeof composeTestSkillCatalog>['catalog'],
  authority: SkillOperationContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const created = await catalog.operations.create.invoke(authority, {
    submission: jsonBody({
      name,
      description: 'conformance fixture',
      bodyMd: `# ${name}\n\nfixture body\n`,
    }),
  })
  return { id: created.id, name: created.name }
}

describeEachProvider('RFC-359 W4-D23a —— 技能目录端口一致性', (harness) => {
  test('建 → 读 → 列：三条读面在两个引擎上给出同一形状', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const name = `skill-${ulid().slice(-8).toLowerCase()}`

    const created = await createSkill(catalog, authority, name)
    expect(created.name).toBe(name)

    const fetched = await catalog.operations.get.invoke(authority, { id: created.id })
    expect(fetched).not.toBeNull()
    expect(fetched?.name).toBe(name)
    // 新建的托管技能：创建者 owner + private + 非 builtin（RFC-099 的统一新建路径）。
    expect(fetched?.ownerUserId).toBe(OWNER)
    expect(fetched?.visibility).toBe('private')
    expect(fetched?.sourceKind).toBe('managed')

    const listed = await catalog.operations.list.invoke(authority, {})
    expect(listed.some((row) => row.id === created.id)).toBe(true)
  })

  test('内容读面：正文与文件树都拿得到，主文件是受保护的 SKILL.md', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `skill-${ulid().slice(-8).toLowerCase()}`)

    const content = await catalog.operations.content.invoke(authority, { id: created.id })
    expect(content.name).toBe(created.name)
    expect(content.bodyMd).toContain('fixture body')

    const files = await catalog.fileQueries.list(authority, { id: created.id })
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((node) => node.path.toLowerCase().endsWith('skill.md'))).toBe(true)
  })

  test('重名新建按同一条判据拒绝（两个引擎同一个错误码）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const name = `dup-${ulid().slice(-8).toLowerCase()}`
    await createSkill(catalog, authority, name)

    let code = '<no-throw>'
    try {
      await createSkill(catalog, authority, name)
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).toBe('skill-name-in-use')
  })

  test('保存正文会推进版本：版本表拿得到第 2 版，且内容随之更新', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `ver-${ulid().slice(-8).toLowerCase()}`)

    const before = await catalog.operations.content.invoke(authority, { id: created.id })
    await catalog.operations.save.invoke(authority, {
      id: created.id,
      submission: jsonBody({
        name: created.name,
        description: 'conformance fixture',
        bodyMd: `# ${created.name}\n\nsecond revision\n`,
        expectedToken: before.token,
      }),
    })

    const after = await catalog.operations.content.invoke(authority, { id: created.id })
    expect(after.bodyMd).toContain('second revision')

    const versions = await catalog.versionQueries.list(authority, { id: created.id })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...versions.map((version) => version.versionIndex))).toBeGreaterThanOrEqual(1)
  })

  test('陈旧 token 的保存一律拒绝（两个引擎同一条乐观并发判据）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `occ-${ulid().slice(-8).toLowerCase()}`)
    const before = await catalog.operations.content.invoke(authority, { id: created.id })

    await catalog.operations.save.invoke(authority, {
      id: created.id,
      submission: jsonBody({
        name: created.name,
        description: 'conformance fixture',
        bodyMd: `# ${created.name}\n\nfirst writer\n`,
        expectedToken: before.token,
      }),
    })

    let code = '<no-throw>'
    try {
      await catalog.operations.save.invoke(authority, {
        id: created.id,
        submission: jsonBody({
          name: created.name,
          description: 'conformance fixture',
          bodyMd: `# ${created.name}\n\nsecond writer on a stale token\n`,
          expectedToken: before.token,
        }),
      })
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).not.toBe('<no-throw>')
  })

  test('文件写入 → 列出 → 读回：受管技能目录里的新文件在两个引擎上一致', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `file-${ulid().slice(-8).toLowerCase()}`)

    await catalog.fileCommands.write(authority, {
      id: created.id,
      path: 'notes/extra.md',
      submission: jsonBody({ content: 'extra file body\n' }),
    })

    const files = await catalog.fileQueries.list(authority, { id: created.id })
    expect(files.some((node) => node.path === 'notes/extra.md')).toBe(true)
    const read = await catalog.fileQueries.read(authority, {
      id: created.id,
      path: 'notes/extra.md',
    })
    expect(read.content).toContain('extra file body')
  })

  test('受保护的主文件不许删（两个引擎同一条判据）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `prot-${ulid().slice(-8).toLowerCase()}`)
    const files = await catalog.fileQueries.list(authority, { id: created.id })
    const main = files.find((node) => node.path.toLowerCase().endsWith('skill.md'))
    expect(main).not.toBeUndefined()

    let code = '<no-throw>'
    try {
      await catalog.fileCommands.delete(authority, {
        id: created.id,
        path: main?.path ?? 'SKILL.md',
        submission: jsonBody({ confirm: main?.path ?? 'SKILL.md' }),
      })
    } catch (error) {
      code = (error as { code?: string }).code ?? (error as Error).message
    }
    expect(code).not.toBe('<no-throw>')
    // 删不掉之后主文件仍在。
    const after = await catalog.fileQueries.list(authority, { id: created.id })
    expect(after.some((node) => node.path.toLowerCase().endsWith('skill.md'))).toBe(true)
  })

  test('删除技能：行消失，再读是 null（两个引擎同一条收场）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const { catalog } = composeTestSkillCatalog(db)
    const authority = authorityOf(OWNER)
    const created = await createSkill(catalog, authority, `del-${ulid().slice(-8).toLowerCase()}`)
    const before = await catalog.operations.content.invoke(authority, { id: created.id })
    const row = await catalog.operations.get.invoke(authority, { id: created.id })

    await catalog.operations.delete.invoke(authority, {
      id: created.id,
      submission: jsonBody({
        confirm: created.name,
        expectedToken: before.token,
        expectedAclRevision: row?.aclRevision ?? 0,
      }),
    } as never)

    expect(await catalog.operations.get.invoke(authority, { id: created.id })).toBeNull()
    const listed = await catalog.operations.list.invoke(authority, {})
    expect(listed.some((row) => row.id === created.id)).toBe(false)
  })
})
