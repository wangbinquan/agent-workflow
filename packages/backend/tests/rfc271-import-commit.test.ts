// RFC-271 T27/T28 —— 导入提交。
//
// 四条承重断言，每条都对应一个具体的失败形态：
//
//  ① **duplicate lookup 先于过期检查**。反过来写，「commit 成功但响应丢失、用户过了
//     有效期再重试」会撞在过期上而**进不了 replay**——用户看到错误，资源其实已经建好。
//  ② **`(target, expect)` 必须是签名基线里的一对**。不是「expect 形状对就行」——那正是
//     「包没变、把 expect 换成用户从未确认过的那一版」那一招。
//  ③ **`allowedActions` 服务端重算**，不信客户端回传（别人的资源没有 overwrite）。
//  ④ **reuse 也要复核**。它不产 op，没有任何 commit 内核会替它把关，而用户确认的正是
//     「复用**这一版**」——`revalidateInTx` 就是为这条存在的；留空则全 reuse 的包完全免检。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, resourceBundleApplies } from '../src/db/schema'
import { encodeZip } from '../src/util/zip'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import { buildPackagePreview } from '../src/services/resourcePackage/preview'
import { commitResourcePackage } from '../src/services/resourcePackage/commit'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(),
  }) as unknown as Actor

const packageZip = (): Uint8Array =>
  encodeZip([
    { path: 'manifest.yaml', bytes: utf8('formatVersion: 1\nsecrets: []\nrequirements: {}\n') },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'mcp-create',
              slug: 'mcp-tools',
              payload: {
                name: 'tools',
                description: 'from package',
                type: 'remote',
                config: { url: 'https://pkg.test/mcp' },
                enabled: true,
              },
            },
          ],
          rootRef: 'local:mcp-tools',
        }),
      ),
    },
  ])

const dirs: string[] = []
function deps(db: DbClient) {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-commit-'))
  dirs.push(appHome)
  return { db, appHome, box }
}

const seedMcp = async (db: DbClient, owner: string, name: string): Promise<string> => {
  const id = ulid()
  await db
    .insert(mcps)
    .values({
      id,
      name,
      description: 'local original',
      type: 'remote',
      config: JSON.stringify({ url: 'https://local.test/mcp' }),
      enabled: true,
      ownerUserId: owner,
      visibility: 'public',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
  return id
}

describe('基础：new 动作把包内资源建出来', () => {
  test('本地无同名 ⇒ new，落库且归导入者', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    })
    expect(receipt.applied).toHaveLength(1)
    const row = db.select().from(mcps).get()
    expect(row?.name).toBe('tools')
    // 「谁导入的整体所有资源权限就归谁」。
    expect(row?.ownerUserId).toBe('u1')
    expect(row?.visibility).toBe('private')
  })
})

describe('① duplicate lookup **先于**过期检查', () => {
  test('已 committed 的 importId 即使 token 早已过期，仍返回原 receipt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const importId = ulid()
    // 造一个**已经过期**的 preview。
    const preview = await buildPackagePreview(db, actor, pkg, {
      box,
      importId,
      now: Date.now() - 60 * 60 * 1000,
    })
    // 先手工塞一条 committed journal，模拟「上次成功但响应丢了」。
    const receiptValue = { journalId: 'J1', applied: [] }
    db.insert(resourceBundleApplies)
      .values({
        id: 'J1',
        scope: 'package',
        key: importId,
        actorUserId: 'u1',
        state: 'committed',
        receiptJson: JSON.stringify(receiptValue),
        preparedArtifactsJson: '[]',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()

    const out = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    })
    // 过期检查若排在前面，这里会抛 package-preview-expired，用户看到错误而资源已存在。
    expect(out).toEqual(receiptValue)
  })

  test('**首次** claim 且已过期 ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, {
      box,
      importId: ulid(),
      now: Date.now() - 60 * 60 * 1000,
    })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'new' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-preview-expired')
  })
})

describe('② / ③ 决策必须落在签名基线内，且服务端重算 allowedActions', () => {
  test('伪造一个不在候选里的 targetId ⇒ 拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'overwrite', targetId: '01FORGED' }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-unconfirmed')
  })

  test('**别人的资源没有 overwrite** —— 客户端硬提交也拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const foreign = await seedMcp(db, 'u-other', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    expect(preview.entries[0]?.allowedActions).not.toContain('overwrite')

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'overwrite', targetId: foreign }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-not-allowed')
    // 别人那一行一个字节没变。
    expect(db.select().from(mcps).where(eq(mcps.id, foreign)).get()?.description).toBe(
      'local original',
    )
  })

  test('缺决策的条目 ⇒ 拒绝（不静默跳过）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-decision-missing')
  })
})

describe('④ reuse 也要复核 —— 它不产 op，没有内核替它把关', () => {
  test('全 reuse 的包：目标在预检之后被改动 ⇒ 提交拒绝', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })

    // 预检之后、提交之前，目标被改了。
    await db
      .update(mcps)
      .set({ config: JSON.stringify({ url: 'https://changed.test/mcp' }) })
      .where(eq(mcps.id, target))
      .run()

    const err = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'reuse', targetId: target }],
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    // `revalidateInTx` 留空的话，这个包一个 op 都没有 ⇒ 完全免检、静默通过。
    expect(err?.code).toBe('package-selected-target-changed')
  })

  test('目标没变 ⇒ 全 reuse 的包正常通过（不误伤）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const target = await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    const receipt = await commitResourcePackage(deps(db), actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [{ localSlug: 'mcp-tools', action: 'reuse', targetId: target }],
    })
    // reuse 不产 op ⇒ receipt 为空，但**这一次导入确实发生过**（journal 落了 committed）。
    expect(receipt.applied).toHaveLength(0)
    expect(db.select().from(resourceBundleApplies).get()?.state).toBe('committed')
    // 也没有多建一行。
    expect(await db.select().from(mcps)).toHaveLength(1)
  })
})

describe('清理', () => {
  test('临时目录', () => {
    for (const d of dirs.splice(0)) removeTempDirSync(d)
    expect(dirs).toHaveLength(0)
  })
})
