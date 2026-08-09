// RFC-271 —— 统一资源包边界的跨层回归锁。
//
// 单层 schema 绿不代表整条链路可用：built-in 根曾经 export→parse 全绿，却在
// preview→commit 被“root 必须 local”硬拒。本文件刻意跨越真实边界，覆盖正常、
// 劫持、篡改、并发漂移与坏行 fail-closed。

import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, runtimes, users, workflows } from '../src/db/schema'
import { exportResourcePackage } from '../src/services/resourcePackage/export'
import { commitResourcePackage, translateDecisions } from '../src/services/resourcePackage/commit'
import { parseResourcePackage } from '../src/services/resourcePackage/parse'
import {
  buildPackagePreview,
  signPreviewToken,
  verifyPreviewToken,
} from '../src/services/resourcePackage/preview'
import { assignSlugs, serializeClosure } from '../src/services/resourcePackage/serialize'
import { encodeZip } from '../src/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(randomBytes(32))
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

const actorOf = (id: string, permissions: readonly string[] = []): Actor =>
  ({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
    permissions: new Set<string>(permissions),
  }) as unknown as Actor

async function seedUser(db: DbClient, id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

async function seedWorkflow(
  db: DbClient,
  input: { id: string; name: string; builtin: boolean; owner: string; version?: number },
): Promise<void> {
  await db.insert(workflows).values({
    id: input.id,
    name: input.name,
    description: '',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], edges: [], nodes: [] }),
    ownerUserId: input.owner,
    visibility: 'public',
    builtin: input.builtin,
    version: input.version ?? 1,
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('built-in 根：完整跨实例导入', () => {
  test('export→parse→preview→commit 绑定目标实例真 built-in，重放不复制', async () => {
    const source = createInMemoryDb(MIGRATIONS)
    const target = createInMemoryDb(MIGRATIONS)
    const sourceHome = mkdtempSync(join(tmpdir(), 'rfc271-builtin-src-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'rfc271-builtin-dst-'))
    try {
      await seedUser(source, 'u1')
      await seedUser(target, 'u1')
      await seedWorkflow(source, {
        id: 'SRC_BUILTIN',
        name: 'aw-builtin-probe',
        builtin: true,
        owner: '__system__',
      })
      // 攻击者同名普通行与真正 built-in 并存；只能命中后者。
      await seedWorkflow(target, {
        id: 'ATTACKER',
        name: 'aw-builtin-probe',
        builtin: false,
        owner: 'u-attacker',
      })
      await seedWorkflow(target, {
        id: 'DST_BUILTIN',
        name: 'aw-builtin-probe',
        builtin: true,
        owner: '__system__',
      })

      const exported = await exportResourcePackage(
        source,
        actorOf('u1'),
        { type: 'workflow', id: 'SRC_BUILTIN' },
        { appHome: sourceHome },
      )
      const pkg = await parseResourcePackage(exported.zip)
      const preview = await buildPackagePreview(target, actorOf('u1'), pkg, {
        box,
        importId: ulid(),
      })
      expect(preview.entries).toEqual([])

      const input = { pkg, previewToken: preview.previewToken, decisions: [] }
      const first = await commitResourcePackage(
        { db: target, appHome: targetHome, box },
        actorOf('u1'),
        input,
      )
      expect(first.applied).toEqual([])
      expect(first.root).toEqual({
        resourceType: 'workflow',
        resourceId: 'DST_BUILTIN',
        name: 'aw-builtin-probe',
        action: 'reuse',
      })
      expect(
        target.select().from(workflows).where(eq(workflows.name, 'aw-builtin-probe')).all(),
      ).toHaveLength(2)

      const replay = await commitResourcePackage(
        { db: target, appHome: targetHome, box },
        actorOf('u1'),
        input,
      )
      expect(replay).toEqual(first)
    } finally {
      removeTempDirSync(sourceHome)
      removeTempDirSync(targetHome)
    }
  })

  test('目标只有同名普通资源时 fail closed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc271-builtin-missing-'))
    try {
      await seedUser(db, 'u1')
      await seedWorkflow(db, {
        id: 'ATTACKER',
        name: 'aw-builtin-probe',
        builtin: false,
        owner: 'u-attacker',
      })
      const zip = encodeZip([
        {
          path: 'manifest.yaml',
          bytes: utf8(`formatVersion: 1
exportedAt: 0
root: { slug: workflow-aw-builtin-probe, type: workflow, name: aw-builtin-probe }
resources: []
builtins: [{ type: workflow, name: aw-builtin-probe }]
requirements: {}
secrets: []
`),
        },
        {
          path: 'bundle.json',
          bytes: utf8(
            JSON.stringify({
              bundleVersion: 1,
              ops: [],
              rootRef: 'builtin:workflow/aw-builtin-probe',
            }),
          ),
        },
      ])
      const pkg = await parseResourcePackage(zip)

      // ① AC-9 要求「本地没有 → **预检页**报错」。built-in 绑不上是一个**环境前提
      // 不满足**，用户能做的只有升级/修复对端实例，不是在这个包里改点什么——所以它
      // 必须出现在「要不要导入」这个决策**之前**，而不是等用户逐条选完、填完凭据、
      // 点了提交才被告知这个包在本实例根本装不了。
      //
      // 判据是「同名 **且** builtin=true」：这里目标实例只有一行同名的**用户自建**
      // 资源（owner=u-attacker、builtin=false）。只按名字查会绑上去，等于把别人的
      // 资源当框架内置件用。
      expect(
        await codeOf(buildPackagePreview(db, actorOf('u1'), pkg, { box, importId: ulid() })),
      ).toBe('package-builtin-missing')

      // ② 引擎兜底仍在：绕开预检（手工签一个 token）直接提交，`resolveIdentityRef`
      // 照样 fail closed。两层都要有——预检那层是**产品要求**（早点告诉用户），引擎
      // 这层是**安全要求**（不信任何绕过预检的调用方）。
      const importId = ulid()
      const forgedToken = signPreviewToken(box, {
        importId,
        actorUserId: 'u1',
        packageDigest: pkg.digest,
        expiresAt: Date.now() + 60_000,
        baseline: [],
        humanBaseline: [],
      })
      expect(
        await codeOf(
          commitResourcePackage({ db, appHome, box }, actorOf('u1'), {
            pkg,
            previewToken: forgedToken,
            decisions: [],
          }),
        ),
      ).toBe('bundle-builtin-missing')
    } finally {
      removeTempDirSync(appHome)
    }
  })
})

describe('manifest / token / serializer 的异常输入', () => {
  test('manifest 漏报或重复 built-in 声明都被拒绝', async () => {
    const bundle = JSON.stringify({
      bundleVersion: 1,
      ops: [],
      rootRef: 'builtin:workflow/aw-builtin-probe',
    })
    const manifest = (builtins: string): string => `formatVersion: 1
exportedAt: 0
root: { slug: workflow-aw-builtin-probe, type: workflow, name: aw-builtin-probe }
resources: []
${builtins}
requirements: {}
secrets: []
`
    for (const builtins of [
      '',
      'builtins: [{ type: workflow, name: aw-builtin-probe }, { type: workflow, name: aw-builtin-probe }]',
    ]) {
      const zip = encodeZip([
        { path: 'manifest.yaml', bytes: utf8(manifest(builtins)) },
        { path: 'bundle.json', bytes: utf8(bundle) },
      ])
      expect(await codeOf(parseResourcePackage(zip))).toBe('package-invalid')
    }
  })

  test('认证通过但 shape 损坏的 preview token 仍返回稳定 4xx', () => {
    const token = box.seal(
      JSON.stringify({
        importId: 'i1',
        actorUserId: 'u1',
        packageDigest: 'd1',
        expiresAt: 'not-a-number',
        baseline: [],
      }),
    )
    expect(() => verifyPreviewToken(box, token)).toThrow()
    try {
      verifyPreviewToken(box, token)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('package-preview-token-invalid')
    }
  })

  test('技能载体缺失或 ref 与 slug/path 不一致，在 preview 前即拒绝', async () => {
    const skillBundle = (ref: string) =>
      JSON.stringify({
        bundleVersion: 1,
        ops: [
          {
            opId: 'op-1',
            kind: 'skill-create',
            slug: 'skill-review',
            payload: {
              name: 'review',
              description: '',
              frontmatterExtra: {},
              bodyMd: '# Review',
              files: [{ path: 'guide.md', ref }],
            },
          },
        ],
        rootRef: 'local:skill-review',
      })
    const manifest = utf8(`formatVersion: 1
exportedAt: 0
root: { slug: skill-review, type: skill, name: review }
resources: [{ slug: skill-review, type: skill, name: review }]
requirements: {}
secrets: []
`)
    const cases = [
      // 路径正确但载体条目缺失。
      { ref: 'skills/skill-review/files/guide.md', extra: [] },
      // 有条目，但 ref 没按本资源的 slug/path 寻址。
      {
        ref: 'skills/other/files/guide.md',
        extra: [{ path: 'skills/other/files/guide.md', bytes: utf8('guide') }],
      },
    ]
    for (const item of cases) {
      const zip = encodeZip([
        { path: 'manifest.yaml', bytes: manifest },
        { path: 'bundle.json', bytes: utf8(skillBundle(item.ref)) },
        ...item.extra,
      ])
      expect(await codeOf(parseResourcePackage(zip))).toBe('package-invalid')
    }
  })

  test('agent 非默认 runtime + inputs 被序列化；坏 canonical 行不产残包', () => {
    const agent = {
      type: 'agent' as const,
      id: 'A1',
      name: 'typed-agent',
      referencedBy: [],
      row: {
        description: '',
        outputs: '[]',
        inputs: JSON.stringify([
          { name: 'repository', kind: 'path<dir>', required: true, description: 'repo root' },
        ]),
        runtime: 'custom-runtime',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
      },
    }
    const serialized = serializeClosure({ root: agent, resources: [agent], callRefs: [] })
    expect(serialized.bundle.ops[0]?.payload).toMatchObject({
      runtime: 'custom-runtime',
      inputs: [{ name: 'repository', kind: 'path<dir>', required: true, description: 'repo root' }],
    })

    const badMcp = {
      type: 'mcp' as const,
      id: 'M1',
      name: 'broken',
      referencedBy: [],
      row: { description: '', type: 'not-a-kind', config: '{}', enabled: true },
    }
    expect(() => serializeClosure({ root: badMcp, resources: [badMcp], callRefs: [] })).toThrow()
    try {
      serializeClosure({ root: badMcp, resources: [badMcp], callRefs: [] })
    } catch (error) {
      expect((error as { code?: string }).code).toBe('package-invalid')
    }
  })

  test('requirements 删除真实前提或注入虚假前提都在 preview 前拒绝', async () => {
    const bundle = {
      bundleVersion: 1,
      ops: [
        {
          opId: 'op-1',
          kind: 'agent-create',
          slug: 'agent-root',
          payload: {
            name: 'root',
            runtime: 'custom-runtime',
            skills: ['project:repo-skill'],
          },
        },
      ],
      rootRef: 'local:agent-root',
    }
    const manifest = (requirements: string) => `formatVersion: 1
exportedAt: 0
root: { slug: agent-root, type: agent, name: root }
resources: [{ slug: agent-root, type: agent, name: root }]
requirements: ${requirements}
secrets: []
`
    for (const requirements of [
      '{}',
      '{ runtimes: [custom-runtime, invented], projectSkills: [repo-skill] }',
    ]) {
      const zip = encodeZip([
        { path: 'manifest.yaml', bytes: utf8(manifest(requirements)) },
        { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
      ])
      expect(await codeOf(parseResourcePackage(zip))).toBe('package-invalid')
    }

    const valid = encodeZip([
      {
        path: 'manifest.yaml',
        bytes: utf8(manifest('{ runtimes: [custom-runtime], projectSkills: [repo-skill] }')),
      },
      { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
    ])
    expect((await parseResourcePackage(valid)).manifest.requirements).toMatchObject({
      runtimes: ['custom-runtime'],
      projectSkills: ['repo-skill'],
    })
  })
})

describe('decision 翻译只触碰引用槽', () => {
  test('reuse 改写真实 local ref，但逐字保留自由 JSON/body/description', () => {
    const bundle = {
      bundleVersion: 1 as const,
      ops: [
        {
          opId: 'op-mcp',
          kind: 'mcp-create' as const,
          slug: 'mcp-tools',
          payload: {
            name: 'tools',
            description: 'local:mcp-tools',
            type: 'local' as const,
            enabled: true,
            config: { command: ['tool'], env: { EXAMPLE: 'local:mcp-tools' } },
          },
        },
        {
          opId: 'op-agent',
          kind: 'agent-create' as const,
          slug: 'agent-root',
          payload: {
            name: 'root',
            description: 'local:mcp-tools',
            skills: [],
            dependsOn: [],
            mcp: ['local:mcp-tools'],
            plugins: [],
            frontmatterExtra: { example: 'local:mcp-tools' },
            bodyMd: 'local:mcp-tools',
          },
        },
      ],
      rootRef: 'local:agent-root',
    }
    const translated = translateDecisions(
      { bundle } as never,
      [
        { localSlug: 'mcp-tools', action: 'reuse', targetId: 'M1' },
        { localSlug: 'agent-root', action: 'new' },
      ],
      new Map([
        ['mcp-tools', { candidateIds: ['M1'], expectByCandidateId: { M1: {} } }],
        ['agent-root', { candidateIds: [], expectByCandidateId: {} }],
      ]),
    )
    const payload = translated.ops[0]?.payload as Record<string, unknown>
    expect(payload.mcp).toEqual(['external:M1'])
    expect(payload.description).toBe('local:mcp-tools')
    expect(payload.frontmatterExtra).toEqual({ example: 'local:mcp-tools' })
    expect(payload.bodyMd).toBe('local:mcp-tools')
  })
})

describe('slug 边界', () => {
  test('六类长名与 100 个冲突后缀始终唯一且不超过 wire 64 字符', () => {
    const types = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const
    const resources = types.flatMap((type) =>
      Array.from({ length: 100 }, (_, index) => ({
        type,
        id: `${type}-${index}`,
        name: `${'a'.repeat(200)}`,
        row: {},
        referencedBy: [],
      })),
    )
    const slugs = [...assignSlugs(resources).values()]
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs.every((slug) => slug.length <= 64)).toBe(true)
    expect(slugs.every((slug) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug))).toBe(true)

    const nonAscii = assignSlugs([
      { type: 'workflow', id: 'unicode', name: '全中文名字', row: {}, referencedBy: [] },
    ]).get('unicode')
    expect(nonAscii).toBe('workflow-workflow')
  })
})

describe('agent 行为字段真 DB 往返', () => {
  test('非默认 runtime 与声明 inputs 跨实例保持，不静默回落', async () => {
    const source = createInMemoryDb(MIGRATIONS)
    const target = createInMemoryDb(MIGRATIONS)
    const sourceHome = mkdtempSync(join(tmpdir(), 'rfc271-agent-src-'))
    const targetHome = mkdtempSync(join(tmpdir(), 'rfc271-agent-dst-'))
    try {
      await seedUser(source, 'u1')
      await seedUser(target, 'u1')
      for (const db of [source, target]) {
        await db.insert(runtimes).values({
          id: ulid(),
          name: 'custom-runtime',
          protocol: 'opencode',
          enabled: true,
        })
      }
      const inputs = [
        { name: 'repository', kind: 'path<dir>', required: true, description: 'repo root' },
      ]
      await source.insert(agents).values({
        id: 'SOURCE_AGENT',
        name: 'typed-agent',
        description: '',
        outputs: '[]',
        inputs: JSON.stringify(inputs),
        runtime: 'custom-runtime',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)

      const exported = await exportResourcePackage(
        source,
        actorOf('u1'),
        { type: 'agent', id: 'SOURCE_AGENT' },
        { appHome: sourceHome },
      )
      const pkg = await parseResourcePackage(exported.zip)
      const preview = await buildPackagePreview(target, actorOf('u1', ['agents:create']), pkg, {
        box,
        importId: ulid(),
      })
      const receipt = await commitResourcePackage(
        { db: target, appHome: targetHome, box },
        actorOf('u1', ['agents:create']),
        {
          pkg,
          previewToken: preview.previewToken,
          decisions: [{ localSlug: 'agent-typed-agent', action: 'new' }],
        },
      )
      const imported = target
        .select()
        .from(agents)
        .where(eq(agents.id, receipt.root?.resourceId ?? ''))
        .get()
      expect(imported?.runtime).toBe('custom-runtime')
      expect(JSON.parse(imported?.inputs ?? '[]')).toEqual(inputs)
    } finally {
      removeTempDirSync(sourceHome)
      removeTempDirSync(targetHome)
    }
  })
})

describe('exact root fence 覆盖闭包之后的 live 读取窗口', () => {
  test('初检后、最终复核前 version 漂移 ⇒ 409，不返回混合快照', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc271-final-fence-'))
    try {
      await seedUser(db, 'u1')
      await seedWorkflow(db, {
        id: 'WF1',
        name: 'racy',
        builtin: false,
        owner: 'u1',
        version: 1,
      })

      let workflowReads = 0
      const racedDb = new Proxy(db as object, {
        get(target, property, receiver) {
          const original = Reflect.get(target, property, receiver)
          if (property !== 'select' || typeof original !== 'function') {
            return typeof original === 'function' ? original.bind(target) : original
          }
          return (...args: unknown[]) => {
            const builder = original.apply(target, args)
            return new Proxy(builder as object, {
              get(queryTarget, queryProperty, queryReceiver) {
                const queryMethod = Reflect.get(queryTarget, queryProperty, queryReceiver)
                if (queryProperty !== 'from' || typeof queryMethod !== 'function') {
                  return typeof queryMethod === 'function'
                    ? queryMethod.bind(queryTarget)
                    : queryMethod
                }
                return (table: unknown) => {
                  if (table === workflows) {
                    workflowReads += 1
                    if (workflowReads === 2) {
                      db.update(workflows)
                        .set({ version: 2, updatedAt: 2 })
                        .where(eq(workflows.id, 'WF1'))
                        .run()
                    }
                  }
                  return queryMethod.call(queryTarget, table)
                }
              },
            })
          }
        },
      }) as unknown as DbClient

      expect(
        await codeOf(
          exportResourcePackage(
            racedDb,
            actorOf('u1'),
            { type: 'workflow', id: 'WF1' },
            // workflow 的导出 fence 是**两维**（version + aclRevision）：ACL 写路径
            // 不推 version，只比 version 会看不见 private→public。少给一维会先被
            // 「给了就必须给全」判 package-invalid，测不到这里要测的 TOCTOU。
            { appHome, expect: { expectedVersion: 1, expectedAclRevision: 0 } },
          ),
        ),
      ).toBe('package-root-changed')
      expect(workflowReads).toBeGreaterThanOrEqual(2)
    } finally {
      removeTempDirSync(appHome)
    }
  })

  test('root 未变但传递依赖在遍历后漂移 ⇒ 409，不拼接跨版本闭包', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'rfc271-closure-fence-'))
    try {
      await seedUser(db, 'u1')
      await db.insert(mcps).values({
        id: 'M1',
        name: 'tools',
        description: '',
        type: 'remote',
        config: JSON.stringify({ url: 'https://v1.test/mcp' }),
        enabled: true,
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)
      await db.insert(agents).values({
        id: 'A1',
        name: 'root',
        description: '',
        outputs: '[]',
        inputs: '[]',
        permission: '{}',
        skills: '[]',
        dependsOn: '[]',
        mcp: '["M1"]',
        plugins: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        ownerUserId: 'u1',
        visibility: 'private',
        createdAt: 1,
        updatedAt: 1,
      } as never)

      let mcpReads = 0
      const racedDb = new Proxy(db as object, {
        get(target, property, receiver) {
          const original = Reflect.get(target, property, receiver)
          if (property !== 'select' || typeof original !== 'function') {
            return typeof original === 'function' ? original.bind(target) : original
          }
          return (...args: unknown[]) => {
            const builder = original.apply(target, args)
            return new Proxy(builder as object, {
              get(queryTarget, queryProperty, queryReceiver) {
                const queryMethod = Reflect.get(queryTarget, queryProperty, queryReceiver)
                if (queryProperty !== 'from' || typeof queryMethod !== 'function') {
                  return typeof queryMethod === 'function'
                    ? queryMethod.bind(queryTarget)
                    : queryMethod
                }
                return (table: unknown) => {
                  if (table === mcps && ++mcpReads === 2) {
                    db.update(mcps)
                      .set({ config: JSON.stringify({ url: 'https://v2.test/mcp' }), updatedAt: 2 })
                      .where(eq(mcps.id, 'M1'))
                      .run()
                  }
                  return queryMethod.call(queryTarget, table)
                }
              },
            })
          }
        },
      }) as unknown as DbClient

      expect(
        await codeOf(
          exportResourcePackage(racedDb, actorOf('u1'), { type: 'agent', id: 'A1' }, { appHome }),
        ),
      ).toBe('package-closure-changed')
      expect(mcpReads).toBeGreaterThanOrEqual(2)
    } finally {
      removeTempDirSync(appHome)
    }
  })
})
