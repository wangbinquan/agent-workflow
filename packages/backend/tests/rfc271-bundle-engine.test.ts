// RFC-271 T9/T13 —— `BundleApply` 引擎的承重不变量。
//
// 每个 describe 对应 `design/RFC-271-*/invariants.md` 的一条 I 项。这些不变量都
// 不是「设计得漂亮」，而是各自对应一次真实事故形态：
//
//   I1  串行键 ≠ 幂等 namespace ——— 拿常量当串行键，所有导入全局串行
//   I2  duplicate 查询先于其它校验 ——— 排后面则已提交的重放会报错而不是回执
//   I3  重放**三态** ——— 「总是返回 receipt」只覆盖三分之一
//   I5  预铸 id 早于 preflight ——— 晚了则同包引用一律报「不存在」
//   I8  post-commit 绝不补偿 ——— 把一次**已成功**的导入回滚掉
//   I9  收敛的 active set / 10 分钟下限 / 补偿失败不终态化
//   T12 每个 update 目标在事务内断言 owner ——— 「只能覆盖自己的」

//
// 覆盖验收条款：AC-15b（update 目标须归 actor 所有，最终事务拒伪造覆盖）/ AC-20b（pre-commit 失败零可见） / AC-24f（重放三态）/ AC-B4（承重不变量）/ AC-B4b（事务钩子）/ AC-B6（ops 可空） / AC-20（任一步失败或 SIGKILL ⇒ 启动收敛能证明前滚还是回滚）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { agents, mcps, resourceBundleApplies } from '../src/db/schema'
import { applyResourceBundle, convergeResourceBundleApplies } from '../src/services/bundle/apply'
import type { BundleApplyProvider } from '../src/services/bundle/provider'
import { createMcp } from '../src/services/mcp'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirSync(d)
})

const actorOf = (id: string, role: 'user' | 'admin' = 'user') =>
  buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'daemon',
  })

function makeProvider(over: Partial<BundleApplyProvider> = {}): BundleApplyProvider {
  return {
    idempotencyKey: { scope: 'package', key: ulid() },
    serializationKey: ulid(),
    actor: actorOf('u1'),
    resolveExternal: async (ref: string) => ref.slice('external:'.length),
    readSkillFile: () => new Uint8Array(),
    ...over,
  }
}

const bundleOf = (ops: unknown[]): ResourceBundle =>
  ({ bundleVersion: 1, ops, rootRef: null }) as unknown as ResourceBundle

const agentCreate = (slug: string, name = slug) => ({
  opId: 'op-1',
  kind: 'agent-create',
  slug,
  payload: {
    name,
    description: '',
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
})

function makeDeps() {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-engine-'))
  dirs.push(appHome)
  return { db: createInMemoryDb(MIGRATIONS), appHome }
}

describe('I2/I3 · claim 与三态重放', () => {
  test('首次 apply 落 journal committed + receipt', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    const receipt = await applyResourceBundle(deps, {
      bundle: bundleOf([agentCreate('a')]),
      provider,
    })
    expect(receipt.applied).toHaveLength(1)
    expect(receipt.applied[0]?.resourceType).toBe('agent')
    const row = deps.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.id, receipt.journalId))
      .get()
    expect(row?.state).toBe('committed')
    // 资源真的落库了。
    const rows = await deps.db.select().from(agents)
    expect(rows).toHaveLength(1)
  })

  test('committed 重放 ⇒ **原 receipt**，且零副作用（不再创建第二个 agent）', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    const first = await applyResourceBundle(deps, {
      bundle: bundleOf([agentCreate('a')]),
      provider,
    })
    const second = await applyResourceBundle(deps, {
      bundle: bundleOf([agentCreate('a')]),
      provider,
    })
    expect(second).toEqual(first)
    expect(await deps.db.select().from(agents)).toHaveLength(1)
  })

  test('failed 重放 ⇒ 409 明说上次失败，**不**静默重跑', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    // 制造一次失败：payload 缺 name。
    await expect(
      applyResourceBundle(deps, {
        bundle: bundleOf([{ opId: 'op-1', kind: 'agent-create', slug: 'a', payload: {} }]),
        provider,
      }),
    ).rejects.toBeDefined()
    const err = await applyResourceBundle(deps, {
      bundle: bundleOf([agentCreate('a')]),
      provider,
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('bundle-apply-failed-replay')
    // 关键：没有因为「第二次 payload 是好的」就把它跑成功。
    expect(await deps.db.select().from(agents)).toHaveLength(0)
  })

  test('prepared/applying 重放 ⇒ 409 未结（拒绝，而不是猜）', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    // 手工塞一条未结 journal，模拟崩溃残留。
    const now = Date.now()
    deps.db
      .insert(resourceBundleApplies)
      .values({
        id: ulid(),
        scope: provider.idempotencyKey.scope,
        key: provider.idempotencyKey.key,
        actorUserId: 'u1',
        state: 'applying',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const err = await applyResourceBundle(deps, {
      bundle: bundleOf([agentCreate('a')]),
      provider,
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('bundle-apply-unsettled')
  })
})

describe('I5 · 预铸 id 早于 preflight —— 同包引用能解析', () => {
  test('agent A dependsOn 同包的 agent B（B 还没落库）', async () => {
    const deps = makeDeps()
    const ops = [
      {
        ...agentCreate('top'),
        payload: { ...agentCreate('top').payload, dependsOn: ['local:leaf'] },
      },
      agentCreate('leaf'),
    ]
    const receipt = await applyResourceBundle(deps, {
      bundle: bundleOf(ops),
      provider: makeProvider(),
    })
    expect(receipt.applied).toHaveLength(2)
    const rows = await deps.db.select().from(agents)
    const top = rows.find((r) => r.name === 'top')
    const leaf = rows.find((r) => r.name === 'leaf')
    expect(top).toBeDefined()
    // 引用真的回填成了 leaf 的 canonical id，而不是留着 `local:leaf`。
    expect(JSON.parse(top!.dependsOn as string)).toEqual([leaf!.id])
  })
})

describe('T12 · update 目标必须归 actor 所有', () => {
  test('伪造覆盖他人的 MCP ⇒ 事务内拒绝，且那一行没变', async () => {
    const deps = makeDeps()
    const victim = await createMcp(
      deps.db,
      {
        name: 'theirs',
        description: 'untouched',
        type: 'remote',
        config: { url: 'https://ok.test/mcp' },
        enabled: true,
      } as never,
      { ownerUserId: 'u-victim', actor: null },
    )
    await deps.db.update(mcps).set({ visibility: 'public' }).where(eq(mcps.id, victim.id)).run()

    const err = await applyResourceBundle(deps, {
      bundle: bundleOf([
        {
          opId: 'op-1',
          kind: 'mcp-update',
          target: `external:${victim.id}`,
          expect: { expectedConfigHash: 'whatever' },
          payload: {
            name: 'theirs',
            description: 'pwned',
            type: 'remote',
            config: { url: 'https://evil.test/mcp' },
            enabled: true,
          },
        },
      ]),
      provider: makeProvider({ actor: actorOf('u-attacker') }),
    }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('bundle-overwrite-not-owned')
    const after = deps.db.select().from(mcps).where(eq(mcps.id, victim.id)).get()
    expect(after?.description).toBe('untouched')
  })
})

describe('I8 · post-commit 绝不补偿', () => {
  test('幂等尾抛错时 journal 仍是 committed、资源仍然可见', async () => {
    const deps = makeDeps()
    const boom = new Error('roll-forward exploded')
    const err = await applyResourceBundle(
      {
        ...deps,
        faults: {
          afterTxBeforeRollForward: () => {
            throw boom
          },
        },
      },
      { bundle: bundleOf([agentCreate('a')]), provider: makeProvider() },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBe(boom)
    // 事务已持久化 ⇒ 这个包**已经生效**。补偿它才是 bug。
    expect(await deps.db.select().from(agents)).toHaveLength(1)
    const row = deps.db.select().from(resourceBundleApplies).get()
    expect(row?.state).toBe('committed')
  })
})

describe('pre-commit 失败 ⇒ 零可见 + journal failed', () => {
  test('big tx 之前抛错：一个资源都不落库', async () => {
    const deps = makeDeps()
    await expect(
      applyResourceBundle(
        {
          ...deps,
          faults: {
            beforeTx: () => {
              throw new Error('staging exploded')
            },
          },
        },
        { bundle: bundleOf([agentCreate('a')]), provider: makeProvider() },
      ),
    ).rejects.toBeDefined()
    expect(await deps.db.select().from(agents)).toHaveLength(0)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('failed')
  })
})

// I7 与 I13 此前**只有源码事实、没有测试**：`invariants.md` 的对照表把它们标成
// 「已验证」，靠的是「我读过代码，那几行确实在同一个 dbTxSync 里」。那不是回归防护
// ——把 `finalizeInTx` 挪出事务、或把 journal 的 committed 写成独立事务，源码看着
// 仍然合理，而两条不变量已经没了。
//
// 引擎早就留好了注入点（`faults.inTxAfterOps`），但它**一个测试都没用过**。这两条
// 就用它：在 big tx 内部、各 op 的 commit 内核之后抛错，然后断言**什么都没留下**。
// 资源、receipt、journal 三者只要有一个逃出事务，这里就会红。
describe('I13 · commit 内核 / receipt / journal 共处同一 big tx', () => {
  test('big tx 内部（各 op 之后）抛错 ⇒ 资源与 journal committed 一起消失', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    await expect(
      applyResourceBundle(
        {
          ...deps,
          faults: {
            inTxAfterOps: () => {
              throw new Error('exploded inside the big tx')
            },
          },
        },
        { bundle: bundleOf([agentCreate('a')]), provider },
      ),
    ).rejects.toBeDefined()

    // ① 资源没落库 —— commit 内核的写与这次抛错在同一事务。
    expect(await deps.db.select().from(agents)).toHaveLength(0)
    // ② journal 没到 committed。若 journal 的状态写在事务之外，这里会是 'committed'
    //    而资源却不存在 —— 那正是「幂等重放返回一个从未发生过的 receipt」的成因。
    const row = deps.db.select().from(resourceBundleApplies).get()
    expect(row?.state).toBe('failed')
    expect(row?.receiptJson ?? null).toBeNull()
  })

  test('同一幂等键重放：上一次是 failed ⇒ 409，而不是返回半个 receipt', async () => {
    const deps = makeDeps()
    const provider = makeProvider()
    const boom = {
      ...deps,
      faults: {
        inTxAfterOps: () => {
          throw new Error('exploded inside the big tx')
        },
      },
    }
    const bundle = bundleOf([agentCreate('a')])
    await expect(applyResourceBundle(boom, { bundle, provider })).rejects.toBeDefined()
    // 同一个 provider ⇒ 同一个 idempotencyKey。三态里的 failed 分支。
    const err = await applyResourceBundle(deps, { bundle, provider }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code).toBe('bundle-apply-failed-replay')
    expect(await deps.db.select().from(agents)).toHaveLength(0)
  })
})

describe('I7 · finalizeInTx 与资源写同事务、且在 journal committed 之前', () => {
  test('finalizeInTx 抛错 ⇒ 资源回滚（它没有在事务外单独跑）', async () => {
    const deps = makeDeps()
    const provider = makeProvider({
      finalizeInTx: () => {
        throw new Error('finalize exploded')
      },
    })
    await expect(
      applyResourceBundle(deps, { bundle: bundleOf([agentCreate('a')]), provider }),
    ).rejects.toBeDefined()
    expect(await deps.db.select().from(agents)).toHaveLength(0)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('failed')
  })

  test('finalizeInTx 拿得到 receipt（它在 receipt 之后、journal committed 之前）', async () => {
    const deps = makeDeps()
    let seen: { applied: unknown[] } | null = null
    const provider = makeProvider({
      finalizeInTx: (_tx, receipt) => {
        seen = receipt as { applied: unknown[] }
      },
    })
    await applyResourceBundle(deps, { bundle: bundleOf([agentCreate('a')]), provider })
    // 顺序是承重的：provenance / commitSeq 这类伴随写入需要 receipt 的内容，
    // 而它们必须与资源写、journal committed 原子发生。
    expect(seen).not.toBeNull()
    expect((seen as unknown as { applied: unknown[] }).applied).toHaveLength(1)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('committed')
  })
})

describe('I9 · 收敛', () => {
  test('10 分钟内的未结 journal **不**收割（慢安装不是崩溃）', async () => {
    const deps = makeDeps()
    const now = Date.now()
    deps.db
      .insert(resourceBundleApplies)
      .values({
        id: ulid(),
        scope: 'package',
        key: 'fresh',
        actorUserId: 'u1',
        state: 'applying',
        preparedArtifactsJson: '[]',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const out = await convergeResourceBundleApplies(deps.db, deps.appHome)
    expect(out.failed).toBe(0)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('applying')
  })

  test('超过下限的未结 journal ⇒ 补偿后标 failed', async () => {
    const deps = makeDeps()
    const old = Date.now() - 60 * 60 * 1000
    deps.db
      .insert(resourceBundleApplies)
      .values({
        id: ulid(),
        scope: 'package',
        key: 'stale',
        actorUserId: 'u1',
        state: 'prepared',
        preparedArtifactsJson: '[]',
        createdAt: old,
        updatedAt: old,
      })
      .run()
    const out = await convergeResourceBundleApplies(deps.db, deps.appHome)
    expect(out.failed).toBe(1)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('failed')
  })

  test('committed 的 journal 只前滚、**绝不**回滚', async () => {
    const deps = makeDeps()
    const old = Date.now() - 60 * 60 * 1000
    deps.db
      .insert(resourceBundleApplies)
      .values({
        id: ulid(),
        scope: 'package',
        key: 'done',
        actorUserId: 'u1',
        state: 'committed',
        receiptJson: JSON.stringify({ journalId: 'x', applied: [] }),
        preparedArtifactsJson: '[]',
        createdAt: old,
        updatedAt: old,
      })
      .run()
    const out = await convergeResourceBundleApplies(deps.db, deps.appHome)
    expect(out.rolledForward).toBe(1)
    expect(out.failed).toBe(0)
    expect(deps.db.select().from(resourceBundleApplies).get()?.state).toBe('committed')
  })
})

describe('I1 · 串行键与幂等 namespace 是两个概念（源码层）', () => {
  test('引擎按 `serializationKey` 上锁，不是按 `idempotencyKey.scope`', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'bundle', 'apply.ts'),
      'utf8',
    )
    expect(src).toContain('withApplyLock(input.provider.serializationKey')
    // 拿 scope 上锁会让所有导入全局串行——一个慢 npm 安装堵死所有人。
    expect(src).not.toContain('withApplyLock(input.provider.idempotencyKey.scope')
  })
})
