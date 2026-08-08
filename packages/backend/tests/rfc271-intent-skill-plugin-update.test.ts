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

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { plugins, skills } from '../src/db/schema'
import { copyOnlyTargetsFor } from '../src/services/intent/applyChangeset'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src', 'services', 'intent', 'applyChangeset.ts')

const actorOf = (id: string) =>
  buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'daemon',
  })

/** manifest 里的一行：handle → 资源。 */
const entry = (handle: string, resourceType: string, resourceId: string) =>
  ({ handle, resourceType, resourceId }) as never

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
  const src = readFileSync(SRC, 'utf8')

  test('基线 hash 与整行捕获来自**同一次**读取', () => {
    // 分两次读会让「两次读之间被人改掉」的窗口原样复现，而
    // `commitPluginPublishInTx` 的整行 CAS 正是为堵它而存在。
    expect(src).toContain('const captured = await requirePluginRowForIntent(db, op.resourceId)')
    expect(src).toContain('pluginOperationConfigHashOf(rowToPluginForIntent(captured))')
    // 捕获的那一行直接进提交，不再重读。
    expect(src).toContain('commitPluginPublishInTx(tx, item.captured, {')
  })

  test('record-before-act：在 prestage 段内，落 artifact **早于** installPlugin', () => {
    // ⚠️ 断言的是**顺序**，不是「两个词都出现过」——record-before-act 的全部内容
    // 就是这个先后。（初版把锚打在了 `kind: 'plugin-install'` 上，结果命中的是
    // 文件顶部的类型声明，白测一场。）
    const start = src.indexOf('// ── prestage')
    const end = src.indexOf('deps.faults?.beforeTx?.()')
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

  test('收敛器能精确删掉 generation 目录；存量无该字段的行仍可解析', () => {
    expect(src).toContain(
      "artifact.kind === 'plugin-install' && artifact.generationDir !== undefined",
    )
    // 旧形态可选，不是必填——格式演进不能把存量 journal 判成不可补偿。
    expect(src).toContain('generationDir?: string')
  })

  test('spec 没变就**不**预安装（避免为一次纯 options 编辑跑 npm）', () => {
    expect(src).toContain("item.kind === 'plugin-update' && item.specChanged")
  })
})

describe('T14 · 那句「尚不支持」已经彻底消失', () => {
  test('源码里不再有该特例分支', () => {
    const src = readFileSync(SRC, 'utf8')
    expect(src).not.toContain('in-place update for this resource type is not supported yet')
  })
})
