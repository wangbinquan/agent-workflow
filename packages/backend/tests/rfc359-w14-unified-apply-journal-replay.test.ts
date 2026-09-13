// RFC-359 —— 统一 apply 引擎的 **journal 三态重放 / 失败终态**双引擎对拍。
//
// # 这份文件为什么存在（它是一次退役的前置条件）
//
// 这些判据此前只锁在**通用 bundle 引擎**（`services/bundle/apply.ts` 的 `applyResourceBundle`）
// 上，由 `rfc271-bundle-engine.test.ts` 的「I2/I3 · claim 与三态重放」一组守着，而那台引擎
// 只有 SQLite 走过。资源包 apply 两台引擎合一（plan §5dv）之后生产侧只剩统一那一台，
// 那组判据锁的是**不再运行的代码**——删它之前，同一批问题必须先在统一引擎上、且在
// **两个 provider** 上各问一遍。这就是那一遍。
//
// # 问的是什么
//
// 「commit 成功但响应丢了、用户重试」这条路径上，journal 的三种状态各有一个**用户可见**的答案：
//
//   ① `committed` ⇒ 原样回放上次那份回执，**不产生第二份资源**；
//   ② `failed`    ⇒ 409 明说上次失败，**绝不**因为这次载荷是好的就静默重跑；
//   ③ 未结（`prepared` / `applying`）⇒ 409 未结，拒绝而不是猜。
//
// 外加失败侧的两条：pre-commit 抛错 ⇒ **零资源可见** 且 journal 终态化为 `failed` 并带原因。
//
// # 怎么在两个引擎上都造出「提交事务中途失败」
//
// 用 `helpers/faultTrigger` 在 `agents` 上挂一条 BEFORE INSERT 的 ABORT 触发器：两个引擎
// 同一份文案、同一条判据。它落在 journal **认领之后**、提交事务之内，正是要测的那一段。
// PostgreSQL 那台的库是整份测试共用的，所以每处都 try/finally 卸掉。

import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { agents, resourceBundleApplies, users } from '@/db/schema'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { encodeZip } from '@/util/zip'
import { describeEachProvider } from './helpers/eachProvider'
import { dropAbortTrigger, installAbortTrigger } from './helpers/faultTrigger'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'
import { removeTempDirSync } from './fixtures/tempDir'

const OWNER = 'w14-journal-owner'
const T0 = 1_700_000_000_000
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

const agentPackageZip = (name: string): Uint8Array =>
  encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: agent-${name}
  type: agent
  name: ${name}
resources:
  - slug: agent-${name}
    type: agent
    name: ${name}
requirements: {}
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'agent-create',
              slug: `agent-${name}`,
              payload: {
                name,
                description: 'from package',
                outputs: [],
                syncOutputsOnIterate: true,
                permission: {},
                skills: [],
                dependsOn: [],
                mcp: [],
                plugins: [],
                frontmatterExtra: {},
                bodyMd: '',
              },
            },
          ],
          rootRef: `local:agent-${name}`,
        }),
      ),
    },
  ])

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-359 —— 统一 apply 引擎的 journal 三态重放', (harness) => {
  const ABORT = {
    name: 'w14_agents_abort',
    table: 'agents',
    error: 'forced agent insert failure',
  } as const

  async function fixture(): Promise<{
    readonly db: typeof harness.db
    readonly actor: Actor
    readonly deps: {
      db: typeof harness.db
      appHome: string
      box: ReturnType<typeof createSecretBoxFromKey>
    }
    commit(bytes: Uint8Array, importId: string): Promise<unknown>
  }> {
    const db = harness.db
    await db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Journal Owner',
      role: 'user',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    })
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w14-journal-'))
    roots.push(appHome)
    const actor = buildActor({
      user: {
        id: OWNER,
        username: OWNER,
        displayName: 'Journal Owner',
        role: 'user',
        status: 'active',
      },
      source: 'daemon',
    })
    const deps = { db, appHome, box: createSecretBoxFromKey(randomBytes(32)) }
    return {
      db,
      actor,
      deps,
      async commit(bytes: Uint8Array, importId: string) {
        const pkg = await parseResourcePackage(bytes)
        const preview = await buildPackagePreview(db, actor, pkg, { box: deps.box, importId })
        return commitResourcePackageForTest(deps, actor, {
          pkg,
          previewToken: preview.previewToken,
          decisions: [{ localSlug: pkg.manifest.root.slug, action: 'new' }],
        })
      },
    }
  }

  test('① 首次 apply ⇒ journal 落 committed，资源真的落库', async () => {
    const f = await fixture()
    const receipt = (await f.commit(agentPackageZip('worker'), ulid())) as {
      journalId: string
      applied: readonly { resourceType: string }[]
    }

    expect(receipt.applied).toHaveLength(1)
    expect(receipt.applied[0]?.resourceType).toBe('agent')
    const journal = await f.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.id, receipt.journalId))
    expect(journal[0]?.state).toBe('committed')
    expect(await f.db.select().from(agents)).toHaveLength(1)
  })

  test('② committed 重放 ⇒ 原回执逐字相同，且不产生第二份资源', async () => {
    const f = await fixture()
    const bytes = agentPackageZip('worker')
    const importId = ulid()
    const first = await f.commit(bytes, importId)
    const second = await f.commit(bytes, importId)

    expect(second).toEqual(first)
    expect(await f.db.select().from(agents)).toHaveLength(1)
    expect(await f.db.select().from(resourceBundleApplies)).toHaveLength(1)
  })

  test('③ failed 重放 ⇒ 409 明说上次失败，绝不因为这次载荷是好的就静默重跑', async () => {
    const f = await fixture()
    const bytes = agentPackageZip('worker')
    const importId = ulid()

    await installAbortTrigger(harness, ABORT)
    try {
      await expect(f.commit(bytes, importId)).rejects.toBeDefined()
    } finally {
      await dropAbortTrigger(harness, ABORT)
    }

    // 触发器已经卸掉——这一次的载荷完全健康。引擎仍然必须拒绝。
    const error = await f.commit(bytes, importId).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(error?.code).toBe('bundle-apply-failed-replay')
    expect(await f.db.select().from(agents)).toHaveLength(0)
  })

  test('④ 未结（prepared）重放 ⇒ 409 未结：拒绝，而不是猜', async () => {
    const f = await fixture()
    const importId = ulid()
    await f.db.insert(resourceBundleApplies).values({
      id: ulid(),
      scope: 'package',
      key: importId,
      actorUserId: OWNER,
      state: 'prepared',
      preparedArtifactsJson: '[]',
      createdAt: T0,
      updatedAt: T0,
    })

    const error = await f.commit(agentPackageZip('worker'), importId).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(error?.code).toBe('bundle-apply-unsettled')
    expect(await f.db.select().from(agents)).toHaveLength(0)
  })

  test('⑤ 提交事务中途失败 ⇒ 零资源可见，且 journal 终态化为 failed 并带原因', async () => {
    const f = await fixture()
    const importId = ulid()

    await installAbortTrigger(harness, ABORT)
    try {
      await expect(f.commit(agentPackageZip('worker'), importId)).rejects.toBeDefined()
    } finally {
      await dropAbortTrigger(harness, ABORT)
    }

    expect(await f.db.select().from(agents)).toHaveLength(0)
    const journal = await f.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.key, importId))
    expect(journal).toHaveLength(1)
    expect(journal[0]?.state).toBe('failed')
    // 「带原因」两个引擎都成立，但**原因的文案由驱动决定**：bun:sqlite 把 `RAISE(ABORT, …)`
    // 的文案原样抛出来，PostgreSQL 的 remote 驱动把它包进一段 `Failed query: insert into …
    // "agents" …` 里。判据因此锁「非空，且指得出是哪张表出的事」，不锁逐字文案——
    // 逐字锁会把一个驱动实现细节变成引擎分叉。
    expect(journal[0]?.error ?? '').not.toBe('')
    expect(journal[0]?.error ?? '').toMatch(/agent/i)
  })
})
