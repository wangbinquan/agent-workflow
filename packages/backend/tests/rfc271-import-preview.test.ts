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
import { stringify } from 'yaml'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, users } from '../src/db/schema'
import { encodeZip } from '../src/util/zip'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import {
  buildPackagePreview,
  groupHumanMemberSlots,
  humanMemberBaselineOf,
  previewBaselineOf,
  signPreviewToken,
  verifyPreviewToken,
} from '../src/services/resourcePackage/preview'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// 六类写权限齐全的普通用户。**默认给全**是因为绝大多数用例断言的不是权限，
// 而是决策/基线逻辑；缺权限的那条单独立用例（见「写权限」describe）。
const WRITE_ALL = ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups'].flatMap(
  (t) => [`${t}:create`, `${t}:update`],
)

const actorOf = (id: string, permissions: readonly string[] = WRITE_ALL): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(permissions),
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

const workgroupOp = (
  members: Array<{
    memberType: 'human'
    username: string
    displayName: string
    roleDesc: string
    sortOrder: number
  }>,
  leaderDisplayName: string | null = null,
) => ({
  opId: 'op-1',
  kind: 'workgroup-create',
  slug: 'workgroup-squad',
  payload: {
    name: 'squad',
    description: '',
    instructions: '',
    mode: leaderDisplayName === null ? 'free_collab' : 'leader_worker',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    clarifyBudget: 3,
    fanOut: false,
    members,
    leaderDisplayName,
  },
})

const packageZip = (
  extra: {
    files?: Array<{ path: string; bytes: Uint8Array }>
    ops?: unknown[]
    formatVersion?: number
    rootRef?: string
    secrets?: Array<{ resourceType: string; resourceName: string; field: string }>
    requirements?: Record<string, unknown>
    manifestRoot?: { slug: string; type: string; name: string }
    manifestResources?: Array<{ slug: string; type: string; name: string }>
  } = {},
): Uint8Array => {
  const ops = extra.ops ?? [mcpOp('mcp-tools', 'tools')]
  const resources = ops.map((raw) => {
    const op = raw as {
      kind: string
      slug: string
      payload: { name: string }
    }
    return {
      slug: op.slug,
      type: op.kind.replace(/-(?:create|update)$/, ''),
      name: op.payload.name,
    }
  })
  const rootRef = extra.rootRef ?? `local:${resources[0]?.slug ?? ''}`
  const root = resources.find((resource) => `local:${resource.slug}` === rootRef)

  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(
        stringify({
          formatVersion: extra.formatVersion ?? 1,
          exportedAt: 0,
          root: extra.manifestRoot ?? root,
          resources: extra.manifestResources ?? resources,
          requirements: extra.requirements ?? {},
          secrets: extra.secrets ?? [],
          danglingCallRefs: [],
        }),
      ),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops,
          rootRef,
        }),
      ),
    },
    ...(extra.files ?? []),
  ])
}

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

  test('损坏的 manifest YAML 是稳定 package-invalid，不泄成原生解析器异常', async () => {
    const malformed = encodeZip([
      { path: 'manifest.yaml', bytes: utf8('formatVersion: [') },
      { path: 'bundle.json', bytes: utf8('{}') },
    ])

    const error = await parseResourcePackage(malformed).then(
      () => null,
      (value: unknown) => value as { code?: string; message?: string },
    )
    expect(error).toMatchObject({
      code: 'package-invalid',
      message: 'manifest.yaml is not valid YAML',
    })
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

  test('manifest.root 不是 bundle.rootRef 指向的资源 ⇒ 拒绝', async () => {
    const err = await parseResourcePackage(
      packageZip({
        manifestRoot: { slug: 'mcp-other', type: 'mcp', name: 'other' },
      }),
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )

    expect(err?.code).toBe('package-invalid')
    expect(err?.message).toContain('manifest.root does not match')
  })

  test('manifest.resources 与 bundle 资源身份不一致 ⇒ 拒绝', async () => {
    const manifestResource = { slug: 'mcp-tools', type: 'mcp', name: 'renamed-only-in-manifest' }
    const err = await parseResourcePackage(
      packageZip({
        manifestRoot: manifestResource,
        manifestResources: [manifestResource],
      }),
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )

    expect(err?.code).toBe('package-invalid')
    expect(err?.message).toContain('manifest.resources does not match')
  })
})

describe('② 预检：候选、可选动作、归属', () => {
  const seedMcp = async (
    db: DbClient,
    owner: string,
    name: string,
    visibility: 'public' | 'private' = 'public',
  ): Promise<string> => {
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
        visibility,
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
    expect(preview.entries[0]?.defaultAction).toBe('new')
    expect(preview.entries[0]?.missingPermissions).toEqual([])
  })

  test('有自己的同名 ⇒ new / reuse / overwrite 三选', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedMcp(db, 'u1', 'tools')
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: 'imp-1' })
    expect(preview.entries[0]?.allowedActions.sort()).toEqual(['new', 'overwrite', 'reuse'])
    expect(preview.entries[0]?.defaultAction).toBe('reuse')
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

  test('隐藏的他人同名资源与不存在同形，不通过 suggestedName 泄漏名字', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const actor = actorOf('u1')
    const absent = await buildPackagePreview(db, actor, pkg, { box, importId: 'imp-absent' })

    await seedMcp(db, 'u-other', 'tools', 'private')
    const hidden = await buildPackagePreview(db, actor, pkg, { box, importId: 'imp-hidden' })

    expect(hidden.entries[0]?.candidates).toEqual(absent.entries[0]?.candidates)
    expect(hidden.entries[0]?.suggestedName).toBe(absent.entries[0]?.suggestedName)
    expect(hidden.entries[0]?.suggestedName).toBe('tools')
  })

  test('没有任何写权限时仍返回完整预检，并列出 new 所缺权限', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(packageZip())
    const preview = await buildPackagePreview(db, actorOf('u1', []), pkg, {
      box,
      importId: 'imp-no-write',
    })

    expect(preview.entries[0]).toMatchObject({
      allowedActions: [],
      defaultAction: null,
      missingPermissions: ['mcps:create'],
    })
  })

  test('root 与完整 secret 引用进入 wire，entry 只拿与自身 type/name 匹配的字段', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const matchingSecret = {
      resourceType: 'mcp' as const,
      resourceName: 'tools',
      field: 'config.headers.Authorization',
    }
    const unrelatedSecret = {
      resourceType: 'agent' as const,
      resourceName: 'reviewer',
      field: 'frontmatterExtra.API_TOKEN',
    }
    const pkg = await parseResourcePackage(
      packageZip({
        secrets: [matchingSecret, unrelatedSecret],
        requirements: { runtimes: ['bun'] },
      }),
    )
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, {
      box,
      importId: 'imp-contract',
    })

    expect(preview.root).toEqual({ slug: 'mcp-tools', type: 'mcp', name: 'tools' })
    expect(preview.secrets).toEqual([matchingSecret, unrelatedSecret])
    expect(preview.entries[0]?.secretFields).toEqual([matchingSecret])
    expect(preview.requirements.runtimes).toEqual(['bun'])
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
      humanBaseline: [],
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
      humanBaseline: [],
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
      humanBaseline: [],
    })
    expect(() => verifyPreviewToken(box, t)).toThrow()
  })
})

describe('③ human 成员：wire 保留 alias，签名按源用户收口', () => {
  const aliases = [
    {
      memberType: 'human' as const,
      username: 'alice',
      displayName: 'reviewer',
      roleDesc: 'reviews',
      sortOrder: 0,
    },
    {
      memberType: 'human' as const,
      username: 'alice',
      displayName: 'observer',
      roleDesc: 'observes',
      sortOrder: 1,
    },
  ]

  test('无 users:search 的普通 actor 猜中 active username 也不泄漏内部 UUID', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(users)
      .values({
        id: 'local-alice',
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        status: 'active',
        passwordHash: 'test-only',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run()
    const pkg = await parseResourcePackage(
      packageZip({ ops: [workgroupOp([aliases[0]!])], rootRef: 'local:workgroup-squad' }),
    )

    const denied = await buildPackagePreview(db, actorOf('u1'), pkg, {
      box,
      importId: 'imp-human-no-search',
    })
    expect(denied.humanMembers[0]?.suggestedUserId).toBeNull()

    const allowed = await buildPackagePreview(
      db,
      actorOf('u1', [...WRITE_ALL, 'users:search']),
      pkg,
      { box, importId: 'imp-human-with-search' },
    )
    expect(allowed.humanMembers[0]?.suggestedUserId).toBe('local-alice')
  })

  test('同一 username 的多 alias 逐行下发，但 token baseline 只有一个 tuple', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(
      packageZip({ ops: [workgroupOp(aliases)], rootRef: 'local:workgroup-squad' }),
    )
    const preview = await buildPackagePreview(db, actorOf('u1'), pkg, {
      box,
      importId: 'imp-human-aliases',
    })

    expect(preview.humanMembers.map((m) => m.displayName)).toEqual(['reviewer', 'observer'])
    expect(groupHumanMemberSlots(preview.humanMembers)).toEqual([
      {
        workgroupSlug: 'workgroup-squad',
        username: 'alice',
        displayNames: ['reviewer', 'observer'],
        suggestedUserId: null,
        required: false,
      },
    ])
    expect(verifyPreviewToken(box, preview.previewToken).humanBaseline).toEqual([
      { workgroupSlug: 'workgroup-squad', username: 'alice', required: false },
    ])
  })

  test('旧 alias 基线的重复 tuple 按 key 去重，并对 required 做 OR', () => {
    expect(
      humanMemberBaselineOf([
        {
          workgroupSlug: 'workgroup-squad',
          username: 'alice',
          displayName: 'reviewer',
          suggestedUserId: null,
          required: false,
        },
        {
          workgroupSlug: 'workgroup-squad',
          username: 'alice',
          displayName: 'observer',
          suggestedUserId: null,
          required: true,
        },
      ]),
    ).toEqual([{ workgroupSlug: 'workgroup-squad', username: 'alice', required: true }])
  })

  test('human alias 被指定为 leader 时预检拒绝：canonical leader 必须是 agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const pkg = await parseResourcePackage(
      packageZip({
        ops: [workgroupOp([aliases[0]!], 'reviewer')],
        rootRef: 'local:workgroup-squad',
      }),
    )
    const err = await buildPackagePreview(db, actorOf('u1'), pkg, {
      box,
      importId: 'imp-human-leader',
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    )
    expect(err?.code).toBe('package-invalid')
    expect(err?.message).toContain('leader must be an agent member')
  })
})
