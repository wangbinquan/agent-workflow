// RFC-271 T14–T17（决策 27）—— intent 的 skill / plugin **原地更新**。
//
// 此前这两类被一个显式特例挡在门外：`copyOnlyTargetsFor` 无条件把它们标成
// 「in-place update for this resource type is not supported yet」，于是无论资源
// 归谁，intent 都只能提议复制一份。
//
// 本批次解开的是**那个特例**，不是权限判据。所以这里是一组**双向锁**：
//   · 自己拥有的 skill/plugin ⇒ 不再进 copy-only（能原地改）
//   · **他人拥有的仍然强制 copy** —— `ownerUserId` 那条判据一字未动
// 少了后一半，这个改动就从「能力扩张」变成了越权。

//
// 覆盖验收条款：AC-K1（自己的 skill/plugin 可原地更新）/ AC-K2（他人的仍强制 copy）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import type { Actor } from '../src/auth/actor'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { plugins, skills } from '../src/db/schema'
import { resolveIntentApplyResourcePreflight } from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePreflight'
import { createResourceCatalogAclIdentityReadPort } from '../src/modules/resource-catalog/infrastructure/aclReadRepository'

// RFC-355 T7：锚点跟着实现走。这条断言当年打在 `services/intent/applyChangeset.ts` 上，
// RFC-349 把 apply 引擎搬进 infrastructure 后那里只剩装配门面，断言等于空跑；现在直接
// 钉住引擎本体。
// RFC-359 —— 两台 apply 引擎合一，三个锚点全部挪到**生产在用的那一份**上：
// 引擎 `sqliteIntentApplyOperations.ts` → `postgresqlIntentApplyOperations.ts`；
// 参与者 `legacyIntentApplyResourceParticipants.ts` → `postgresqlIntentApplyResourcePorts.ts`；
// 工件生命周期 `sqliteIntentApplyArtifactLifecycle.ts` → `postgresqlIntentApplyArtifactLifecycle.ts`。
const SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'intent',
  'infrastructure',
  'postgresqlIntentApplyOperations.ts',
)
const PARTICIPANT_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'aggregateAdapters',
  'postgresqlIntentApplyResourcePorts.ts',
)
const ARTIFACT_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'intent',
  'domain',
  'journalArtifacts.ts',
)
const ARTIFACT_LIFECYCLE_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'intent',
  'infrastructure',
  'postgresqlIntentApplyArtifactLifecycle.ts',
)

const actorOf = (id: string) =>
  buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
  })

/** manifest 里的一行：handle → 资源。 */
const entry = (handle: string, resourceType: string, resourceId: string) =>
  ({ handle, resourceType, resourceId }) as never

async function copyOnlyTargetsFor(
  db: ProviderNeutralDatabase,
  actor: Actor,
  manifest: Parameters<typeof resolveIntentApplyResourcePreflight>[2],
  changeset: Parameters<typeof resolveIntentApplyResourcePreflight>[3],
) {
  return (
    await resolveIntentApplyResourcePreflight(
      createResourceCatalogAclIdentityReadPort(db),
      actor.user.id,
      manifest,
      changeset,
    )
  ).copyOnlyTargets
}

async function seedSkill(db: ProviderNeutralDatabase, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(skills)
    .values({
      id,
      name: `skill-${id.slice(-6)}`,
      description: '',
      sourceKind: 'managed',
      ownerUserId,
      visibility: 'public',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    .run()
  return id
}

async function seedPlugin(db: ProviderNeutralDatabase, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(plugins)
    .values({
      id,
      name: `plugin-${id.slice(-6)}`,
      description: '',
      spec: 'left-pad@1.0.0',
      optionsJson: '{}',
      enabled: true,
      sourceKind: 'npm',
      cachedPath: '/tmp/x',
      resolvedVersion: '1.0.0',
      ownerUserId,
      visibility: 'public',
      installedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    .run()
  return id
}

describeEachProvider('T14 · 自己拥有的 skill / plugin 不再被 copy-only 挡住', (harness) => {
  test('skill：自己的 ⇒ copy-only 里没有它', async () => {
    const db = harness.db
    const actor = actorOf('u1')
    const id = await seedSkill(db, 'u1')
    const out = await copyOnlyTargetsFor(db, actor, [entry('res#skill#1', 'skill', id)], {
      ops: [{ action: 'update', resourceType: 'skill', target: 'res#skill#1' }],
    })
    expect(out.size).toBe(0)
  })

  test('plugin：自己的 ⇒ copy-only 里没有它', async () => {
    const db = harness.db
    const actor = actorOf('u1')
    const id = await seedPlugin(db, 'u1')
    const out = await copyOnlyTargetsFor(db, actor, [entry('res#plugin#1', 'plugin', id)], {
      ops: [{ action: 'update', resourceType: 'plugin', target: 'res#plugin#1' }],
    })
    expect(out.size).toBe(0)
  })
})

describeEachProvider('T15 · **他人拥有的仍然强制 copy** —— ownerUserId 判据一字未动', (harness) => {
  test('skill：别人的 ⇒ copy-only，理由是 owner 而不是「尚不支持」', async () => {
    const db = harness.db
    const id = await seedSkill(db, 'u-someone-else')
    const out = await copyOnlyTargetsFor(db, actorOf('u1'), [entry('res#skill#1', 'skill', id)], {
      ops: [{ action: 'update', resourceType: 'skill', target: 'res#skill#1' }],
    })
    expect(out.get('res#skill#1')).toBe('owned by another user or built-in')
  })

  test('plugin：别人的 ⇒ 同上', async () => {
    const db = harness.db
    const id = await seedPlugin(db, 'u-someone-else')
    const out = await copyOnlyTargetsFor(db, actorOf('u1'), [entry('res#plugin#1', 'plugin', id)], {
      ops: [{ action: 'update', resourceType: 'plugin', target: 'res#plugin#1' }],
    })
    expect(out.get('res#plugin#1')).toBe('owned by another user or built-in')
  })

  test('六类走的是**同一条**判据（agent 的行为逐字不变，作为对照）', async () => {
    const db = harness.db
    const skillMine = await seedSkill(db, 'u1')
    const skillTheirs = await seedSkill(db, 'u2')
    const out = await copyOnlyTargetsFor(
      db,
      actorOf('u1'),
      [entry('res#skill#1', 'skill', skillMine), entry('res#skill#2', 'skill', skillTheirs)],
      {
        ops: [
          { action: 'update', resourceType: 'skill', target: 'res#skill#1' },
          { action: 'update', resourceType: 'skill', target: 'res#skill#2' },
        ],
      },
    )
    expect([...out.keys()]).toEqual(['res#skill#2'])
  })
})

describe('T17 · plugin 半边的两条要害（源码层）', () => {
  const src = readFileSync(PARTICIPANT_SRC, 'utf8')

  // RFC-359 —— 合一之前这条断言的是 legacy 那条路的形态：preflight 期 `getPluginById` 捕获
  // 整行 + 算基线 hash，把捕获的那一行**带进**提交期做整行 CAS。现行这条路换了机制、
  // 堵的是同一个窗口：提交期在事务里**自己重读**那一行，读到的就是提交那一刻的真值，
  // 没有「两次读之间」这段窗口可言；写回再挂一道 `updatedAt` 的 CAS 兜住重读与写回之间。
  test('基线与写回都取自提交事务里的那一次读', () => {
    const update = src.indexOf("requireOwner(actor, 'plugin', current)")
    expect(update, '语料失效：插件提交臂的 owner 核对没扫到').toBeGreaterThan(0)
    const reread = src.lastIndexOf('.from(plugins)', update)
    expect(reread, '核对之前必须有一次事务内重读').toBeGreaterThan(0)
    expect(src.indexOf('eq(plugins.updatedAt, current.updatedAt)', update)).toBeGreaterThan(update)
  })

  test('record-before-act：在 prestage 段内，落 artifact **早于** installPlugin', () => {
    // ⚠️ 断言的是**顺序**，不是「两个词都出现过」——record-before-act 的全部内容
    // 就是这个先后。（初版把锚打在了 `kind: 'plugin-install'` 上，结果命中的是
    // 文件顶部的类型声明，白测一场。）
    // 现行这条路把「算目录 / 装」封在 `planInstall` 交出的 staged capability 里：
    // `prepare` 只 plan（不动盘），`prestage` 先落 artifact 再 `stage()` 真装。
    // 顺序判据因此落在 prestage 段内的这两句上。
    const start = src.indexOf(
      'async prestage(_plan, prepared, context) {',
      src.indexOf('createPluginPort('),
    )
    const end = src.indexOf('async commitInTransaction(', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const prestage = src.slice(start, end)
    const recorded = prestage.indexOf('await context.recordArtifact(prepared.install.artifact)')
    const staged = prestage.indexOf('await prepared.install.stage()')
    expect(recorded).toBeGreaterThan(-1)
    expect(staged).toBeGreaterThan(recorded)
    // artifact 里带的生成代目录是 `planInstall` 在**动盘之前**算好的那一个：
    // `plannedGenerationDir(...)` 先算、`installPlugin(...)` 后装，两者在工件 owner 里同一个
    // 闭包内，顺序在那边钉。
    const owners = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'infrastructure',
        'aggregateAdapters',
        'postgresqlIntentApplyArtifactOwners.ts',
      ),
      'utf8',
    )
    const planned = owners.indexOf('const managedDirectory = plannedGenerationDir(')
    const installed = owners.indexOf('const result = await installPlugin(', planned)
    expect(planned).toBeGreaterThan(-1)
    expect(installed).toBeGreaterThan(planned)
  })

  test('收敛器只按完整 codec 的精确 generation 目录补偿', () => {
    const codec = readFileSync(ARTIFACT_SRC, 'utf8')
    const converger = readFileSync(ARTIFACT_LIFECYCLE_SRC, 'utf8')
    // 旧词汇的行仍按精确的生成代目录补偿（兼容面，见
    // `rfc359-w7-intent-apply-artifact-conformance`）；现行词汇的行走上面那一支。
    expect(converger).toContain(
      'rmSync(input.artifact.generationDir, { recursive: true, force: true })',
    )
    expect(codec).toContain('generationId: NonEmptyString')
    expect(codec).toContain('generationDir: NonEmptyString')
    expect(codec).toContain('INTENT_JOURNAL_ARTIFACT_VERSION = 1')
  })

  test('spec 没变就**不**预安装（避免为一次纯 options 编辑跑 npm）', () => {
    // 现行这条路把判断放在 `artifactsForPluginUpdate`：spec 逐字相同就回 null，
    // prestage 段随即整段跳过（`if (prepared.install === null) return`）。
    expect(src).toContain('if (row.spec === plan.payload.spec) return null')
    expect(src).toContain('if (prepared.install === null) return')
  })
})

describe('T14 · 那句「尚不支持」已经彻底消失', () => {
  test('源码里不再有该特例分支', () => {
    const src = readFileSync(SRC, 'utf8')
    expect(src).not.toContain('in-place update for this resource type is not supported yet')
  })
})
