// RFC-291 面 A/B/F —— 提交入库把创建物写进会话挂载清单（apply 集成面）。
//
// 锁的是用户报告的缺陷：「一个意图创建任务所提交的节点，应该被自动挂接到该意图
// 创建任务里，不然我提交入库的东西我继续改的时候，发现没挂载不让改」——此前
// applyChangeset 的大事务只 bump commitSeq/contextRevision/currentDraftId，
// 完全不碰 context_manifest_json，于是新建资源下一轮只进 inventory 摘要，
// update 撞 intent-target-not-mounted。
//
// 设计门要求的加严（初版矩阵可 false-green，P2-e）：
//  · AC-4 不能只比清单字节——还要断言 journal 未新增行、回执是同一 journalId，
//    否则「重复执行但返回新回执」的实现也会绿。
//  · AC-8b 要覆盖谱系分叉（O→C1→C2 再从 O 派生），不能只测直接两次 copy。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { canonicalIntentJson, parseIntentChangeset } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, intentApplyJournal, intentDrafts, intentSessions, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import { createIntentSessionForTest as createIntentSession } from './helpers/intentResourceCatalogBinding'
import type { IntentContextManifest } from '../src/services/intent/manifest'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc291_00000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(),
}

async function seedUser(id: string, username: string): Promise<void> {
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
}

async function seedAgent(
  name: string,
  ownerUserId = OWNER,
): Promise<{ id: string; updatedAt: number }> {
  const id = ulid()
  const now = Date.now()
  await db.insert(agents).values({
    id,
    name,
    description: 'existing',
    outputs: JSON.stringify(['out']),
    ownerUserId,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof agents.$inferInsert)
  return { id, updatedAt: now }
}

function installDraft(
  sessionId: string,
  changeset: unknown,
  manifest: IntentContextManifest,
  revision = 1,
): { draftRevision: number; draftHash: string } {
  const parsed = parseIntentChangeset(JSON.stringify(changeset))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const draftId = ulid()
  const session = db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
  db.insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: session?.contextRevision ?? 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftRevision: revision, draftHash }
}

function deps(over: Partial<ApplyIntentDeps> = {}): ApplyIntentDeps {
  const resolved = { db, appHome, actor, ...over }
  return { ...resolved, ...intentApplyResourceBinding(db, resolved.actor) }
}

function manifestOf(sessionId: string): IntentContextManifest {
  const row = db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
  return JSON.parse(row?.contextManifestJson ?? '[]') as IntentContextManifest
}

function sessionRow(sessionId: string) {
  return db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
}

const createAgentOp = (opId: string, tempRef: string, name: string): unknown => ({
  opId,
  action: 'create',
  resourceType: 'agent',
  tempRef,
  payload: {
    name,
    description: 'made by intent',
    outputs: ['out'],
    skills: [],
    mcp: [],
    plugins: [],
    dependsOn: [],
    bodyMd: 'body',
  },
})

/** An in-place update op targeting a mounted handle (copy decisions reuse it). */
const updateAgentOp = (opId: string, target: string, description: string): unknown => ({
  opId,
  action: 'update',
  resourceType: 'agent',
  target,
  payload: {
    name: 'existing-agent',
    description,
    outputs: ['out'],
    skills: [],
    mcp: [],
    plugins: [],
    dependsOn: [],
    bodyMd: 'body',
  },
})

const mountedAgent = (
  handle: string,
  resourceId: string,
  updatedAt: number,
  over: Partial<IntentContextManifest[number]> = {},
): IntentContextManifest[number] => ({
  handle,
  resourceType: 'agent',
  resourceId,
  root: true,
  detail: true,
  fence: { kind: 'agent', updatedAt, aclRevision: 0 },
  dumpHash: 'x',
  ...over,
})

beforeEach(async () => {
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc291-'))
  db = createInMemoryDb(MIGRATIONS)
  await seedUser(OWNER, 'owner')
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

describe('提交入库 → 创建物自动挂载（AC-1 / AC-3）', () => {
  test('本次 create 的资源全部成为挂载根，且 contextRevision 恰好 +1', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build' })
    const before = sessionRow(session.id)
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [createAgentOp('op-1', '$new:a', 'alpha'), createAgentOp('op-2', '$new:b', 'beta')],
      },
      [],
    )

    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })

    const manifest = manifestOf(session.id)
    const createdIds = receipt.applied.map((a) => a.resourceId).sort()
    expect(createdIds).toHaveLength(2)
    // 两个创建物都在清单里、都是 root、且尚未 dump（没有 fence）
    for (const id of createdIds) {
      const entry = manifest.find((e) => e.resourceId === id)
      expect(entry).toBeDefined()
      expect(entry?.root).toBe(true)
      expect(entry?.detail).toBe(false)
      expect(entry?.fence).toBeUndefined()
    }
    // 挂载与 epoch 递增同事务，只 +1
    expect(sessionRow(session.id)?.contextRevision).toBe((before?.contextRevision ?? 0) + 1)
  })

  test('挂载写在提交大事务内：事务失败则资源与清单一起回滚（AC-3）', async () => {
    // 只测「成功后终值」区分不出「写在同一事务」与「写在第二个事务但恰好成功」，
    // 所以这里在大事务最后一步之后注入故障，断言两者**双双**回滚。
    const { session } = await createIntentSession(db, actor, { message: 'build' })
    const draft = installDraft(
      session.id,
      { $schema_version: 1, ops: [createAgentOp('op-1', '$new:a', 'alpha')] },
      [],
    )

    await expect(
      applyIntentChangeset(
        deps({
          faults: {
            inTxAfterOps: () => {
              throw new Error('boom-after-ops')
            },
          },
        }),
        { sessionId: session.id, clientMutationId: ulid(), ...draft, decisions: [] },
      ),
    ).rejects.toThrow()

    expect(db.select().from(agents).all()).toHaveLength(0)
    expect(manifestOf(session.id)).toEqual([])
  })
})

describe('replay 幂等（AC-4）', () => {
  test('同一 clientMutationId 重复提交：清单不变、journal 不新增、回执同一 journalId', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build' })
    const draft = installDraft(
      session.id,
      { $schema_version: 1, ops: [createAgentOp('op-1', '$new:a', 'alpha')] },
      [],
    )
    const mutationId = ulid()

    const first = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: mutationId,
      ...draft,
      decisions: [],
    })
    const manifestAfterFirst = JSON.stringify(manifestOf(session.id))
    const revisionAfterFirst = sessionRow(session.id)?.contextRevision
    const journalAfterFirst = db.select().from(intentApplyJournal).all().length

    const second = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: mutationId,
      ...draft,
      decisions: [],
    })

    // 回执逐字段相同（同一 journalId ⇒ 没有第二次真正执行）
    expect(second.journalId).toBe(first.journalId)
    expect(second.commitSeq).toBe(first.commitSeq)
    expect(db.select().from(intentApplyJournal).all()).toHaveLength(journalAfterFirst)
    // 清单与 epoch 逐字节不变（不会重复追加条目 / 漂移 handle）
    expect(JSON.stringify(manifestOf(session.id))).toBe(manifestAfterFirst)
    expect(sessionRow(session.id)?.contextRevision).toBe(revisionAfterFirst)
    expect(db.select().from(agents).all()).toHaveLength(1)
  })
})

describe('copy：挂副本、卸原件、只留最新副本（AC-6 / AC-7 / AC-8b）', () => {
  test('copy 提交后副本是根、原件退根且 handle 保留', async () => {
    const foreign = await seedAgent('existing-agent', 'user_someone_else_000000000')
    const { session } = await createIntentSession(db, actor, { message: 'tweak' })
    const draft = installDraft(
      session.id,
      { $schema_version: 1, ops: [updateAgentOp('op-1', 'res#agent#1', 'tweaked')] },
      [mountedAgent('res#agent#1', foreign.id, foreign.updatedAt)],
    )

    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [
        { opId: 'op-1', applyMode: 'copy', slots: [{ slotId: 'name:op-1', value: 'my-copy' }] },
      ],
    })

    expect(receipt.applied[0]?.fromCopy).toBe(true)
    const copyId = receipt.applied[0]?.resourceId ?? ''
    const manifest = manifestOf(session.id)

    const origin = manifest.find((e) => e.resourceId === foreign.id)
    expect(origin?.root).toBe(false)
    expect(origin?.handle).toBe('res#agent#1') // handle 不回收，历史不断链

    const copy = manifest.find((e) => e.resourceId === copyId)
    expect(copy?.root).toBe(true)
    // 谱系记的是**根**（这里原件本身就是根）
    expect(copy?.copiedFromResourceId).toBe(foreign.id)
  })

  test('谱系分叉：O→C1→C2 之后再从 O 派生，C1 与 C2 都退根（设计门 P1-c）', async () => {
    const foreign = await seedAgent('existing-agent', 'user_someone_else_000000000')
    const { session } = await createIntentSession(db, actor, { message: 'tweak' })

    // ① O → C1
    const d1 = installDraft(
      session.id,
      { $schema_version: 1, ops: [updateAgentOp('op-1', 'res#agent#1', 'v1')] },
      [mountedAgent('res#agent#1', foreign.id, foreign.updatedAt)],
    )
    const r1 = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...d1,
      decisions: [
        { opId: 'op-1', applyMode: 'copy', slots: [{ slotId: 'name:op-1', value: 'copy-one' }] },
      ],
    })
    const c1 = r1.applied[0]?.resourceId ?? ''
    const c1Row = db.select().from(agents).where(eq(agents.id, c1)).get()

    // ② C1 → C2（对自己的副本再选 copy——服务端允许，applyMode 由用户 decision 决定）
    const d2 = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-2',
            action: 'update',
            resourceType: 'agent',
            target: 'res#agent#2',
            payload: {
              name: 'copy-one',
              description: 'v2',
              outputs: ['out'],
              skills: [],
              mcp: [],
              plugins: [],
              dependsOn: [],
              bodyMd: 'body',
            },
          },
        ],
      },
      [
        mountedAgent('res#agent#1', foreign.id, foreign.updatedAt, { root: false }),
        mountedAgent('res#agent#2', c1, c1Row?.updatedAt ?? Date.now(), {
          copiedFromResourceId: foreign.id,
        }),
      ],
      2,
    )
    const r2 = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...d2,
      decisions: [
        { opId: 'op-2', applyMode: 'copy', slots: [{ slotId: 'name:op-2', value: 'copy-two' }] },
      ],
    })
    const c2 = r2.applied[0]?.resourceId ?? ''

    // C2 的直接来源是 C1，但谱系根必须记成 O
    const afterTwo = manifestOf(session.id)
    expect(afterTwo.find((e) => e.resourceId === c2)?.copiedFromResourceId).toBe(foreign.id)
    expect(afterTwo.find((e) => e.resourceId === c1)?.root).toBe(false)

    // ③ 重新挂回 O，再从 O 派生 C3 —— C1 与 C2 必须一起退根
    const remounted = afterTwo.map((e) =>
      e.resourceId === foreign.id
        ? {
            ...e,
            root: true,
            detail: true,
            fence: { kind: 'agent' as const, updatedAt: foreign.updatedAt, aclRevision: 0 },
          }
        : e,
    )
    const d3 = installDraft(
      session.id,
      { $schema_version: 1, ops: [updateAgentOp('op-3', 'res#agent#1', 'v3')] },
      remounted,
      3,
    )
    const r3 = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...d3,
      decisions: [
        { opId: 'op-3', applyMode: 'copy', slots: [{ slotId: 'name:op-3', value: 'copy-three' }] },
      ],
    })
    const c3 = r3.applied[0]?.resourceId ?? ''

    const final = manifestOf(session.id)
    expect(final.find((e) => e.resourceId === c1)?.root).toBe(false)
    expect(final.find((e) => e.resourceId === c2)?.root).toBe(false) // 只记直接来源就会漏掉这条
    expect(final.find((e) => e.resourceId === c3)?.root).toBe(true)
    expect(final.find((e) => e.resourceId === foreign.id)?.root).toBe(false)
    // 同一谱系下只剩最新副本是根
    expect(final.filter((e) => e.root).map((e) => e.resourceId)).toEqual([c3])
  })
})

describe('handle 高水位随提交前进（AC-20）', () => {
  test('创建物 mint 的 ordinal 写回 handle_watermark_json', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [createAgentOp('op-1', '$new:a', 'alpha'), createAgentOp('op-2', '$new:b', 'beta')],
      },
      [],
    )
    await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })

    const watermark = JSON.parse(sessionRow(session.id)?.handleWatermarkJson ?? '{}') as Record<
      string,
      number
    >
    expect(watermark.agent).toBe(2)
  })

  test('高水位单调：不会被后续提交调低', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'build' })
    db.update(intentSessions)
      .set({ handleWatermarkJson: JSON.stringify({ agent: 9 }) })
      .where(eq(intentSessions.id, session.id))
      .run()
    const draft = installDraft(
      session.id,
      { $schema_version: 1, ops: [createAgentOp('op-1', '$new:a', 'alpha')] },
      [],
    )
    await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })
    const watermark = JSON.parse(sessionRow(session.id)?.handleWatermarkJson ?? '{}') as Record<
      string,
      number
    >
    expect(watermark.agent).toBe(9)
  })
})
