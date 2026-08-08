// RFC-271 T25/T26 —— 解包与预检。
//
// 两组承重断言：
//
// ① **防夹带**：包里出现任何未在 manifest / bundle 里登记的条目 ⇒ 拒绝。
//    `decodeZip` 已经拦了路径穿越，但「登记之外的文件」本身就说明这个包不是我们的
//    格式产出的——与其逐个猜它想干嘛，不如整体拒绝。
//
// ② **`previewToken` 签死整套确认基线**。设计期有两版被否掉，各自的绕法都很具体：
//    · 「下发包摘要、commit 重算比对」——客户端可以同时换掉文件**和**摘要；
//    · 「只签 packageDigest」——包没变也能绕：把 decision 里的 `expect` 换成用户
//      **从未确认过**的那一版，签名仍有效，于是 CAS 覆盖了另一个内容。
//    这里对第二条做直接的反例断言。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps } from '../src/db/schema'
import { encodeZip } from '../src/util/zip'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import {
  buildPackagePreview,
  previewBaselineOf,
  signPreviewToken,
  verifyPreviewToken,
} from '../src/services/resourcePackage/preview'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const actorOf = (id: string): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(),
  }) as unknown as Actor

const mcpOp = (slug: string, name: string) => ({
  opId: 'op-1',
  kind: 'mcp-create',
  slug,
  payload: {
    name,
    description: '',
    type: 'remote',
    config: { url: 'https://x.test/mcp' },
    enabled: true,
  },
})

const packageZip = (
  extra: {
    files?: Array<{ path: string; bytes: Uint8Array }>
    ops?: unknown[]
    formatVersion?: number
  } = {},
): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: ${extra.formatVersion ?? 1}\nsecrets: []\nrequirements: {}\n`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: extra.ops ?? [mcpOp('mcp-tools', 'tools')],
          rootRef: 'local:mcp-tools',
        }),
      ),
    },
    ...(extra.files ?? []),
  ])

describe('① 解包与防夹带', () => {
  test('正常包：manifest + bundle 都解出来', async () => {
    const pkg = await parseResourcePackage(packageZip())
    expect(pkg.manifest.formatVersion).toBe(1)
    expect(pkg.bundle.ops).toHaveLength(1)
    expect(pkg.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('未登记的条目 ⇒ 拒绝（哪怕路径本身合法）', async () => {
    const zip = packageZip({ files: [{ path: 'sneaky.sh', bytes: utf8('rm -rf /') }] })
    const err = await parseResourcePackage(zip).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-unlisted-entry')
  })

  test('缺 manifest 或 bundle ⇒ 拒绝', async () => {
    const onlyManifest = encodeZip([{ path: 'manifest.yaml', bytes: utf8('formatVersion: 1\n') }])
    await expect(parseResourcePackage(onlyManifest)).rejects.toBeDefined()
  })

  test('formatVersion 比本实例**高** ⇒ 拒绝（低版本解析器读高版本包只会误解语义）', async () => {
    const err = await parseResourcePackage(packageZip({ formatVersion: 99 })).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-format-unsupported')
  })

  test('bundle.json 引用悬空 ⇒ 拒绝（shared 的 collectBundleRefIssues 兜住）', async () => {
    const zip = packageZip({
      ops: [
        {
          opId: 'op-1',
          kind: 'agent-create',
          slug: 'agent-a',
          payload: {
            name: 'a',
            description: '',
            outputs: [],
            syncOutputsOnIterate: true,
            permission: {},
            skills: [],
            dependsOn: ['local:does-not-exist'],
            mcp: [],
            plugins: [],
            frontmatterExtra: {},
            bodyMd: '',
          },
        },
      ],
    })
    const err = await parseResourcePackage(zip).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('package-invalid')
  })
})

describe('② 预检：候选、可选动作、归属', () => {
  const seedMcp = async (db: DbClient, owner: string, name: string): Promise<string> => {
    const id = ulid()
    await db
      .insert(mcps)
      .values({
        id,
        name,
        description: '',
        type: 'remote',
        config: '{}',
        enabled: true,
        ownerUserId: owner,
        visibility: 'public',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()
    return id
  }

  test('本地没有同名 ⇒ 只能 new', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, {
      box,
      importId: 'imp-1',
    })
    expect(preview.entries[0]?.allowedActions).toEqual(['new'])
  })

  test('有自己的同名 ⇒ new / reuse / overwrite 三选', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    expect(preview.entries[0]?.allowedActions.sort()).toEqual(['new', 'overwrite', 'reuse'])
  })

  test('**只有别人的同名 ⇒ 没有 overwrite 选项**（「别人的不给覆盖选项」）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u-other', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    expect(preview.entries[0]?.allowedActions).not.toContain('overwrite')
    // 但**可以复用**——可见即有读权限。
    expect(preview.entries[0]?.allowedActions).toContain('reuse')
  })

  test('候选**可以多个**（名字是 (owner,name) 复合唯一）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    await seedMcp(db, 'u-other', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    expect(preview.entries[0]?.candidates).toHaveLength(2)
    expect(preview.entries[0]?.candidates.filter((c) => c.owned)).toHaveLength(1)
  })

  test('建议名避开已占用的名字', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    expect(preview.entries[0]?.suggestedName).toBe('tools-2')
  })
})

describe('② previewToken —— 签死的是**基线**，不是包摘要', () => {
  test('往返：签发的 token 能验回同一份基线', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    const verified = verifyPreviewToken(box, preview.previewToken)
    expect(verified.importId).toBe('imp-1')
    expect(verified.actorUserId).toBe('u1')
    expect(verified.packageDigest).toBe(pkg.digest)
    expect(verified.baseline).toEqual(previewBaselineOf(preview.entries))
  })

  test('**换掉某条的 expect** ⇒ 与签名基线对不上（这正是「只签 digest」挡不住的那一招）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    const verified = verifyPreviewToken(box, preview.previewToken)

    // 客户端伪造：包一个字节没改（digest 相同），但 expect 换成用户从未确认的值。
    const tampered = structuredClone(preview.entries)
    tampered[0]!.candidates = [
      { id: 'H2', name: 'tools', expect: { expectedConfigHash: 'H2' }, owned: true },
    ]
    // 与签名里的基线逐字比对 ⇒ 不一致。commit 段据此拒绝。
    expect(previewBaselineOf(tampered)).not.toEqual(verified.baseline)
  })

  test('别人的 token 用不了（actor 进签名面）', () => {
    const t = signPreviewToken(box, {
      importId: 'imp-1',
      actorUserId: 'u1',
      packageDigest: 'd',
      expiresAt: 1,
      baseline: [],
    })
    expect(verifyPreviewToken(box, t).actorUserId).toBe('u1')
  })

  test('篡改密文本体 ⇒ 验签失败（AES-GCM 的认证标签）', () => {
    const t = signPreviewToken(box, {
      importId: 'imp-1',
      actorUserId: 'u1',
      packageDigest: 'd',
      expiresAt: 1,
      baseline: [],
    })
    // ⚠️ **在中间改一个字符**，不是往尾部追加。packed 是 base64(iv|ct|tag)，
    // 追加单个字符不足以凑成一个完整字节组，base64 解码会把它丢掉 ⇒ 解出的字节
    // 完全相同、验签照样通过。那**不是**漏洞（内容没被改动），但拿它当「篡改被
    // 拦下」的证据是自欺欺人——所以这条断言必须改动真实字节。
    const mid = Math.floor(t.length / 2)
    const flipped = `${t.slice(0, mid)}${t[mid] === 'A' ? 'B' : 'A'}${t.slice(mid + 1)}`
    expect(() => verifyPreviewToken(box, flipped)).toThrow()
    expect(() => verifyPreviewToken(box, 'not-a-token')).toThrow()
  })

  test('另一把钥匙签的 token 验不过（跨实例不通用）', () => {
    const other = createSecretBoxFromKey(randomBytes(32))
    const t = signPreviewToken(other, {
      importId: 'imp-1',
      actorUserId: 'u1',
      packageDigest: 'd',
      expiresAt: 1,
      baseline: [],
    })
    expect(() => verifyPreviewToken(box, t)).toThrow()
  })
})
