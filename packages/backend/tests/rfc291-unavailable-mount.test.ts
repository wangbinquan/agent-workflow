// RFC-291 面 C —— 失效挂载「跳过 + 明示」，不再炸整轮（AC-9 / AC-9b / AC-10 / AC-11）。
//
// 此前：挂载的资源被删或失去可见性后，buildIntentDump 对该根直接 throw，整轮生成
// 失败，用户除了手动取消挂载没有自救路径。自动挂载上线后会话里挂着的资源变多，
// 踩中概率等比上升。
//
// 设计门（两路独立同发）指出初版修法不够：只把根检查的 throw 改成 skip，覆盖不到
// **逐资源 materialize** 阶段——catalog 是内存快照，真正 dump 一个 skill 时
// readSkillContent 会重新查库并抛 skill-not-found，绕过跳过路径继续炸。
//
// 同时锁住反向边界：**真错不吞**。非 not-found 类的失败（I/O 损坏等）必须照常抛，
// 否则一次真实故障会被伪装成「资源不可用」，把用户引向错误的自救动作。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skills, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { buildIntentDump } from '../src/services/intent/dumpBuilder'
import { buildIntentDoc } from '../src/services/intent/intentDoc'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291un_000000'
const OTHER = 'user_other_rfc291un_000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(),
}

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
}

async function seedAgent(name: string, ownerUserId = OWNER): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(agents).values({
    id,
    name,
    description: name,
    outputs: JSON.stringify(['out']),
    ownerUserId,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof agents.$inferInsert)
  return id
}

async function seedSkill(name: string): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(skills).values({
    id,
    name,
    description: name,
    ownerUserId: OWNER,
    visibility: 'private',
    contentVersion: 1,
    metaRevision: 1,
    createdAt: now,
    updatedAt: now,
  } as typeof skills.$inferInsert)
  return id
}

const mounts = (refs: Array<{ resourceType: 'agent' | 'skill'; resourceId: string }>) => refs

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-un-'))
  db = createInMemoryDb(MIGRATIONS)
  await seedUser(OWNER)
  await seedUser(OTHER)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describe('挂载根不可用时跳过而非抛错（AC-9 / AC-10）', () => {
  test('资源被删除：整轮不抛错，其余挂载与 inventory 照常', async () => {
    const alive = await seedAgent('alive-agent')
    const doomed = await seedAgent('doomed-agent')

    // 先建立一个含两个根的清单（handle 稳定用）
    const first = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: mounts([
        { resourceType: 'agent', resourceId: alive },
        { resourceType: 'agent', resourceId: doomed },
      ]),
    })
    const doomedHandle = first.manifest.find((e) => e.resourceId === doomed)?.handle
    expect(doomedHandle).toBeDefined()

    await db.delete(agents).where(eq(agents.id, doomed))

    const after = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: mounts([
        { resourceType: 'agent', resourceId: alive },
        { resourceType: 'agent', resourceId: doomed },
      ]),
      priorManifest: first.manifest,
      handleWatermark: first.handleWatermark,
    })

    // 不抛错，且被跳过的根被如实上报（只有 handle + 类型，没有名字）
    expect(after.unavailableMounts).toEqual([{ handle: doomedHandle!, resourceType: 'agent' }])

    // AC-10：条目保留、handle 不变、root 仍为 true、但没有 detail/fence
    const entry = after.manifest.find((e) => e.resourceId === doomed)
    expect(entry?.handle).toBe(doomedHandle!)
    expect(entry?.root).toBe(true)
    expect(entry?.detail).toBe(false)
    expect(entry?.fence).toBeUndefined()

    // 其余挂载照常 dump
    const aliveEntry = after.manifest.find((e) => e.resourceId === alive)
    expect(aliveEntry?.detail).toBe(true)
    expect(aliveEntry?.fence).toBeDefined()
    expect(after.seedFiles.some((f) => f.path.startsWith('mounted/'))).toBe(true)
  })

  test('失去可见性（他人 private）：同样跳过、不泄漏名字', async () => {
    const mine = await seedAgent('mine-agent')
    const foreign = await seedAgent('foreign-agent', OTHER)

    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: mounts([
        { resourceType: 'agent', resourceId: mine },
        { resourceType: 'agent', resourceId: foreign },
      ]),
    })

    expect(dump.unavailableMounts).toHaveLength(1)
    expect(dump.unavailableMounts[0]?.resourceType).toBe('agent')
    // 不可见资源的名字不得出现在任何产物里
    const allText = dump.seedFiles.map((f) => f.content).join('\n')
    expect(allText).not.toContain('foreign-agent')
    expect(JSON.stringify(dump.unavailableMounts)).not.toContain('foreign-agent')
  })

  test('materialize 期竞态：catalog 加载后资源才消失，仍不炸（设计门 P2-a / 路 1 F1）', async () => {
    // 这是初版修法覆盖不到的那条路径：根检查用的是内存快照，skill 的真正读取
    // 会重新查库。用 db 代理在 catalog 载入之后、skill 读取之前删掉该行。
    const skillId = await seedSkill('doomed-skill')
    let catalogLoaded = false
    let deleted = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (prop !== 'select' || typeof value !== 'function') return value
        return (...args: unknown[]) => {
          // 第一次 select 之后视作 catalog 已载入；随后立刻删除目标行。
          if (catalogLoaded && !deleted) {
            deleted = true
            db.delete(skills).where(eq(skills.id, skillId)).run()
          }
          catalogLoaded = true
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as DbClient

    const dump = await buildIntentDump({
      db: proxy,
      actor,
      appHome,
      mounts: mounts([{ resourceType: 'skill', resourceId: skillId }]),
    })
    // 关键断言：**没有抛错**，该根被记为不可用
    expect(dump.unavailableMounts.map((m) => m.resourceType)).toEqual(['skill'])
    expect(dump.manifest.find((e) => e.resourceId === skillId)?.detail).toBe(false)
  })

  test('AC-9b 真错不吞：非 not-found 的失败照常抛出', async () => {
    const skillId = await seedSkill('io-fault-skill')
    const boom = new Error('simulated disk failure')
    let calls = 0
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (prop !== 'select' || typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls += 1
          // 放过 catalog 载入阶段，在随后的 materialize 读取上抛一个真故障
          if (calls > 8) throw boom
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as DbClient

    await expect(
      buildIntentDump({
        db: proxy,
        actor,
        appHome,
        mounts: mounts([{ resourceType: 'skill', resourceId: skillId }]),
      }),
    ).rejects.toThrow('simulated disk failure')
  })
})

describe('给构建 Agent 的明示（AC-11）', () => {
  test('Access notes 含 handle + 类型，且不含资源名字', () => {
    const doc = buildIntentDoc({
      sessionTitle: 't',
      turns: [],
      currentDraftJson: null,
      validationErrors: [],
      pendingQuestions: [],
      hiddenDependencyNote: null,
      unavailableMountNote:
        'Mounted resources unavailable this epoch (deleted, or no longer visible to you): res#agent#3 (agent). They are absent from mounted/; do not guess their contents, and do not target them with an update.',
      envelopeNonce: 'nonce',
      langDirective: 'x',
      privileges: { mayAuthorScripts: false, mayAuthorCodeHostCalls: false },
    })
    expect(doc).toContain('## Access notes')
    expect(doc).toContain('res#agent#3 (agent)')
  })

  test('两类 note 同时存在时各占一段，不互相顶掉', () => {
    const doc = buildIntentDoc({
      sessionTitle: 't',
      turns: [],
      currentDraftJson: null,
      validationErrors: [],
      pendingQuestions: [],
      hiddenDependencyNote: 'HIDDEN-DEP-NOTE',
      unavailableMountNote: 'UNAVAILABLE-MOUNT-NOTE',
      envelopeNonce: 'nonce',
      langDirective: 'x',
      privileges: { mayAuthorScripts: false, mayAuthorCodeHostCalls: false },
    })
    expect(doc).toContain('HIDDEN-DEP-NOTE')
    expect(doc).toContain('UNAVAILABLE-MOUNT-NOTE')
    expect(doc.match(/## Access notes/g)).toHaveLength(1)
  })

  test('都为 null 时不渲染该段', () => {
    const doc = buildIntentDoc({
      sessionTitle: 't',
      turns: [],
      currentDraftJson: null,
      validationErrors: [],
      pendingQuestions: [],
      hiddenDependencyNote: null,
      unavailableMountNote: null,
      envelopeNonce: 'nonce',
      langDirective: 'x',
      privileges: { mayAuthorScripts: false, mayAuthorCodeHostCalls: false },
    })
    expect(doc).not.toContain('## Access notes')
  })
})

describe('上游接线（AC-11 的 turnEngine 面）', () => {
  test('turnEngine 确实把 unavailableMounts 转成 note 传给 buildIntentDoc', () => {
    // 直接驱动完整一轮需要真实 runtime；这里用源码层断言兜住「忘记接线」这个
    // 具体失败模式——它是初版矩阵里最容易 false-green 的一条（设计门 P2-e）。
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'intent', 'turnEngine.ts'),
      'utf8',
    )
    expect(src).toContain('unavailableMountNote:')
    expect(src).toContain('dump.unavailableMounts')
  })
})
