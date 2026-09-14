// RFC-359 —— 两台 apply 引擎合一照出的**用户可见缺陷**，逐条钉成双引擎判据。
//
// # 为什么是这两条，为什么现在才有
//
// `rfc359-w5-t19d` 的覆盖对等账本里，`IntentApplyOperations` 长期是**本仓最深的一处倒挂**：
// `sqlite 21/3` 对 `postgresql 7/5`——判据几乎全喂在 SQLite 那一侧，PostgreSQL 那一侧的
// intent 提交臂在无人看管地漂移。账本的注释写的是「倒挂越深，合一时撞出行为差异的概率越大」；
// 这个文件就是那句话的兑现：合一当天照出三处缺陷，**全部**落在 PG 那一侧。
//
// 其中两条是「同一份 changeset，SQLite 上能提交、PostgreSQL 上被拒」，即用户拿本仓换个数据库
// 部署就会撞上的功能差异；它们进这个文件，一条 body 在两个引擎上各跑一遍：
//
//   ① **名字域的 dangle 容忍**（RFC-243 §5.3）。`call-workflow` / `call-workgroup` 按**名字**
//      选目标，而名字不是授权、也不必此刻就存在——解析不到任何行是**启动期**的问题。
//      PG 的 `assertNamedReferencesVisible` 此前在 `rows.length === 0` 时抛
//      `resource-reference-not-found`(422)，把「先建调用方、后建被调方」「被调方在另一台机器上」
//      这两类正常用法整个堵死。
//
//   ② **特权节点的回填**（RFC-270 镜头）。遮蔽是 permission-blind 的：无 `scripts:author` 的
//      作者**看到的就是打码后的定义**，他原样送回来的那份里 `script` / `env` / `dependencies`
//      装的是 `INTENT_REDACTED` 占位符。保存路径一直先按库里的现值回填再比敏感投影；PG 的
//      intent 提交臂此前直接拿用户送来的那份去比，于是**普通用户改不动任何含脚本节点的
//      工作流**——连改个描述都 403 `script-author-forbidden`。
//
// 第三条（in-place 改名：v1 契约是只能经 finalName / copy，SQLite 那台只挡了 agent 一类）
// 方向相反、强侧是 PG，判据在 `intent-privileged-node-capability` 里按契约钉着，不重复。

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { intentDrafts, intentSessions, users, workflows } from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const OWNER = 'user_rfc359_w41_owner'

const actor: Actor = {
  user: {
    id: OWNER,
    username: 'w41-owner',
    displayName: 'W41 owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  // 没有 `scripts:author`：②那条正是为这种作者存在的。
  permissions: new Set(['resource-acl:private']),
}

const SCRIPT_NODE = Object.freeze({
  id: 'script-1',
  kind: 'script',
  language: 'bash',
  script: 'echo "the real body"',
  env: { TOKEN: 'the-real-token' },
  dependencies: [],
  outputs: [],
  readonly: false,
})

/**
 * 作者**送回来**的那一份：三个被遮蔽的字段整个省掉。
 *
 * 这是 INTENT.md 教给模型的形态（`domain/teaching/nodeKinds.ts` 的 `SCRIPT_REDACTED_FIELDS`），
 * 也是唯一安全的那一种——把 `INTENT_REDACTED` 占位符原样填回去会先撞上**另一条**规则
 * （`intent-secret-value-forbidden`：secret carrier 必须是 ‹secret› 哨兵），那条与本用例无关。
 * 回填要恢复的正是这三个字段。
 */
const { script: _script, env: _env, dependencies: _dependencies, ...SENT_SCRIPT_NODE } = SCRIPT_NODE

let harness: ProviderHarness
let db: ProviderNeutralDatabase
let appHome: string

function definitionOf(nodes: readonly unknown[]) {
  return { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes, edges: [] }
}

async function seedSession(): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(intentSessions).values({
    id,
    ownerUserId: OWNER,
    title: 'w41',
    createdAt: now,
    updatedAt: now,
  } as typeof intentSessions.$inferInsert)
  return id
}

/** 把一份 changeset 直接装进 draft（本文件测的是 apply，不是 turn 引擎）。 */
async function installDraft(
  sessionId: string,
  changeset: unknown,
  manifestEntries: readonly unknown[] = [],
): Promise<{ draftRevision: number; draftHash: string }> {
  const changesetJson = JSON.stringify(changeset)
  const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
  const draftId = ulid()
  await db.insert(intentDrafts).values({
    id: draftId,
    sessionId,
    revision: 1,
    changesetJson,
    validationJson: '{"errors":[],"credentialFindings":[]}',
    draftHash,
    contextRevision: 0,
    createdAt: Date.now(),
  } as typeof intentDrafts.$inferInsert)
  await db
    .update(intentSessions)
    .set({
      currentDraftId: draftId,
      contextManifestJson: JSON.stringify(manifestEntries),
    })
    .where(eq(intentSessions.id, sessionId))
  return { draftRevision: 1, draftHash }
}

async function applyDraft(sessionId: string, draft: { draftRevision: number; draftHash: string }) {
  const { authority } = composeIdentityAccess(db).contexts.fromAuthenticatedPrincipal(
    { userId: OWNER, source: 'session' },
    'http',
  )
  return await composeIntentApplyOperations({
    db,
    appHome,
    aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
  }).apply({
    actor,
    authority,
    command: { sessionId, clientMutationId: ulid(), ...draft, decisions: [] },
  })
}

async function seedWorkflow(name: string, nodes: readonly unknown[]): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(workflows).values({
    id,
    name,
    description: '',
    definition: JSON.stringify(definitionOf(nodes)),
    version: 1,
    ownerUserId: OWNER,
    visibility: 'private',
    builtin: false,
    createdAt: now,
    updatedAt: now,
  } as typeof workflows.$inferInsert)
  return id
}

async function storedDefinition(id: string): Promise<{ nodes: Record<string, unknown>[] }> {
  const row = await db.select().from(workflows).where(eq(workflows.id, id)).get()
  return JSON.parse(row!.definition) as { nodes: Record<string, unknown>[] }
}

describeEachProvider('RFC-359 —— intent apply 的两条引擎分叉（同一份判据喂两个引擎）', (h) => {
  beforeEach(async () => {
    harness = h
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w41-'))
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    const now = Date.now()
    await db.insert(users).values({
      id: OWNER,
      username: 'w41-owner',
      displayName: 'W41 owner',
      role: 'user',
      status: 'active',
      passwordHash: null,
      createdAt: now,
      updatedAt: now,
    } as typeof users.$inferInsert)
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  test('①：按名字调用一个还不存在的工作流 —— 提交通过，留给启动期校验', async () => {
    const sessionId = await seedSession()
    const draft = await installDraft(sessionId, {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:caller',
          payload: {
            name: 'w41-caller',
            description: '',
            definition: definitionOf([
              { id: 'n1', kind: 'call-workflow', workflowName: 'does-not-exist-yet' },
            ]),
          },
        },
      ],
    })

    // 缺陷形态：PG 上此前当场 422 `resource-reference-not-found`，整包零落库。
    await applyDraft(sessionId, draft)

    const created = await db.select().from(workflows).where(eq(workflows.name, 'w41-caller')).get()
    expect(created, '悬空的名字不该阻止提交——那是启动期的事').not.toBeUndefined()
    const definition = JSON.parse(created!.definition) as { nodes: Record<string, unknown>[] }
    expect(definition.nodes[0]?.workflowName).toBe('does-not-exist-yet')
  })

  test('①b：按名字调用一个**别人私有**的工作流 —— 仍然拒绝（容忍的是「不存在」，不是「看不见」）', async () => {
    const other = 'user_rfc359_w41_other'
    const now = Date.now()
    await db.insert(users).values({
      id: other,
      username: 'w41-other',
      displayName: 'W41 other',
      role: 'user',
      status: 'active',
      passwordHash: null,
      createdAt: now,
      updatedAt: now,
    } as typeof users.$inferInsert)
    await db.insert(workflows).values({
      id: ulid(),
      name: 'w41-secret',
      description: '',
      definition: JSON.stringify(definitionOf([])),
      version: 1,
      ownerUserId: other,
      visibility: 'private',
      builtin: false,
      createdAt: now,
      updatedAt: now,
    } as typeof workflows.$inferInsert)

    const sessionId = await seedSession()
    const draft = await installDraft(sessionId, {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:caller',
          payload: {
            name: 'w41-peeker',
            description: '',
            definition: definitionOf([
              { id: 'n1', kind: 'call-workflow', workflowName: 'w41-secret' },
            ]),
          },
        },
      ],
    })

    // 同一个判据的另一半：解析得到行、但对这个作者不可见 ⇒ `acl-missing-refs`。
    // 「不存在」与「看不见」是两件事，容忍的只有前者。
    await expect(applyDraft(sessionId, draft)).rejects.toMatchObject({
      code: 'acl-missing-refs',
    })
    expect(
      await db.select().from(workflows).where(eq(workflows.name, 'w41-peeker')).get(),
      '被拒之后整包零落库',
    ).toBeUndefined()
  })

  test('②：无 scripts:author 的作者原样送回打码定义 —— 改得动，且脚本正文不丢', async () => {
    const workflowId = await seedWorkflow('w41-mixed', [
      { id: 'in1', kind: 'input', inputKey: 'k' },
      SCRIPT_NODE,
    ])
    const before = await db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
    const sessionId = await seedSession()
    const draft = await installDraft(
      sessionId,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'update',
            resourceType: 'workflow',
            target: 'res#workflow#1',
            payload: {
              name: 'w41-mixed',
              description: 'edited by a permissionless author',
              // 他看到的就是这份：特权字段全是占位符。
              definition: definitionOf([
                { id: 'in1', kind: 'input', inputKey: 'k' },
                SENT_SCRIPT_NODE,
              ]),
            },
          },
        ],
      },
      [
        {
          handle: 'res#workflow#1',
          resourceType: 'workflow',
          resourceId: workflowId,
          root: true,
          detail: true,
          fence: { kind: 'workflow', version: before!.version },
          dumpHash: 'x',
        },
      ],
    )

    // 缺陷形态：PG 上此前 403 `script-author-forbidden`——占位符 ≠ 正文。
    await applyDraft(sessionId, draft)

    const after = await db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
    expect(after!.description, '普通编辑必须落地').toBe('edited by a permissionless author')
    const script = (await storedDefinition(workflowId)).nodes.find((n) => n.kind === 'script')
    expect(script?.script, '脚本正文按库里的现值回填，不是把占位符当正文写进去').toBe(
      SCRIPT_NODE.script,
    )
    expect(script?.env).toEqual(SCRIPT_NODE.env)
  })
})
