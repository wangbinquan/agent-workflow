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
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { plugins, skills } from '../src/db/schema'
import { resolveIntentApplyResourcePreflight } from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'
import { createSqliteResourceCatalogAclIdentityReadPort } from '../src/modules/resource-catalog/infrastructure/sqliteAclReadRepository'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src', 'services', 'intent', 'applyChangeset.ts')
const PARTICIPANT_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'aggregateAdapters',
  'legacyIntentApplyResourceParticipants.ts',
)
const ARTIFACT_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'services',
  'intent',
  'journalArtifacts.ts',
)
const SQLITE_ARTIFACT_LIFECYCLE_SRC = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'intent',
  'infrastructure',
  'sqliteIntentApplyArtifactLifecycle.ts',
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
  db: DbClient,
  actor: Actor,
  manifest: Parameters<typeof resolveIntentApplyResourcePreflight>[2],
  changeset: Parameters<typeof resolveIntentApplyResourcePreflight>[3],
) {
  return (
    await resolveIntentApplyResourcePreflight(
      createSqliteResourceCatalogAclIdentityReadPort(db),
      actor.user.id,
      manifest,
      changeset,
    )
  ).copyOnlyTargets
}

async function seedSkill(db: DbClient, ownerUserId: string): Promise<string> {
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

async function seedPlugin(db: DbClient, ownerUserId: string): Promise<string> {
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

describe('T14 · 自己拥有的 skill / plugin 不再被 copy-only 挡住', () => {
  test('skill：自己的 ⇒ copy-only 里没有它', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const actor = actorOf('u1')
    const id = await seedSkill(db, 'u1')
    const out = await copyOnlyTargetsFor(db, actor, [entry('res#skill#1', 'skill', id)], {
      ops: [{ action: 'update', resourceType: 'skill', target: 'res#skill#1' }],
    })
    expect(out.size).toBe(0)
  })

  test('plugin：自己的 ⇒ copy-only 里没有它', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const actor = actorOf('u1')
    const id = await seedPlugin(db, 'u1')
    const out = await copyOnlyTargetsFor(db, actor, [entry('res#plugin#1', 'plugin', id)], {
      ops: [{ action: 'update', resourceType: 'plugin', target: 'res#plugin#1' }],
    })
    expect(out.size).toBe(0)
  })
})

describe('T15 · **他人拥有的仍然强制 copy** —— ownerUserId 判据一字未动', () => {
  test('skill：别人的 ⇒ copy-only，理由是 owner 而不是「尚不支持」', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedSkill(db, 'u-someone-else')
    const out = await copyOnlyTargetsFor(db, actorOf('u1'), [entry('res#skill#1', 'skill', id)], {
      ops: [{ action: 'update', resourceType: 'skill', target: 'res#skill#1' }],
    })
    expect(out.get('res#skill#1')).toBe('owned by another user or built-in')
  })

  test('plugin：别人的 ⇒ 同上', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedPlugin(db, 'u-someone-else')
    const out = await copyOnlyTargetsFor(db, actorOf('u1'), [entry('res#plugin#1', 'plugin', id)], {
      ops: [{ action: 'update', resourceType: 'plugin', target: 'res#plugin#1' }],
    })
    expect(out.get('res#plugin#1')).toBe('owned by another user or built-in')
  })

  test('六类走的是**同一条**判据（agent 的行为逐字不变，作为对照）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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

  test('基线 hash 与整行捕获来自**同一次**读取', () => {
    // 分两次读会让「两次读之间被人改掉」的窗口原样复现，而
    // `commitPluginPublishInTx` 的整行 CAS 正是为堵它而存在。
    expect(src).toContain('const captured = await dependencies.getPluginById(db, plan.resourceId)')
    expect(src).toContain('dependencies.pluginOperationConfigHashOf(captured)')
    // 捕获的那一行直接进提交，不再重读。
    expect(src).toContain('dependencies.commitPluginPublishInTx(tx, prepared.captured, {')
  })

  test('record-before-act：在 prestage 段内，落 artifact **早于** installPlugin', () => {
    // ⚠️ 断言的是**顺序**，不是「两个词都出现过」——record-before-act 的全部内容
    // 就是这个先后。（初版把锚打在了 `kind: 'plugin-install'` 上，结果命中的是
    // 文件顶部的类型声明，白测一场。）
    const start = src.indexOf('async prestage(plan, context)')
    const end = src.indexOf('participantInTransaction(', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const prestage = src.slice(start, end)
    const planned = prestage.indexOf('plannedGenerationDir(')
    const recorded = prestage.indexOf('recordArtifact({')
    const installed = prestage.indexOf('installPlugin(')
    expect(planned).toBeGreaterThan(-1)
    expect(recorded).toBeGreaterThan(planned)
    expect(installed).toBeGreaterThan(recorded)
    expect(prestage).toContain('generationId')
  })

  test('收敛器只按完整 codec 的精确 generation 目录补偿', () => {
    const codec = readFileSync(ARTIFACT_SRC, 'utf8')
    const converger = readFileSync(SQLITE_ARTIFACT_LIFECYCLE_SRC, 'utf8')
    expect(converger).toContain('rmSync(artifact.generationDir, { recursive: true, force: true })')
    expect(codec).toContain('generationId: NonEmptyString')
    expect(codec).toContain('generationDir: NonEmptyString')
    expect(codec).toContain('INTENT_JOURNAL_ARTIFACT_VERSION = 1')
  })

  test('spec 没变就**不**预安装（避免为一次纯 options 编辑跑 npm）', () => {
    expect(src).toContain("prepared.kind === 'plugin-update' && prepared.specChanged")
  })
})

describe('T14 · 那句「尚不支持」已经彻底消失', () => {
  test('源码里不再有该特例分支', () => {
    const src = readFileSync(SRC, 'utf8')
    expect(src).not.toContain('in-place update for this resource type is not supported yet')
  })
})
