// RFC-401 A3 —— workflow 写入的错误矩阵（AC-2 的 workflow 部分，design §9.4）。
//
// 同一输入经三条入口、两种 provider 得到同一结果：普通编辑（目录模块的命令）、Intent（确认后的 apply）、资源包
// （parse → preview → commit）。用户 2026-11-02 确认以普通编辑现行行为为准，并放开 Intent 的两处更严规则：
//   · proposal §5 第 2 项：允许 workflow 重名（此前 Intent 报 `intent-name-conflict` / `workflow-name-in-use`）；
//   · proposal §5 第 8 项：保存时不做完整图校验（此前 Intent 提交期报 `intent-workflow-invalid`）。
// 此前 Intent 对不可见引用报的 details 用 `id` 键（普通编辑是 `name`）、按名字调用的不可见 workflow 逐个报且不带
// details；资源包按名字调用时不查可见性、也不要求规范 agent id。
//
// 只属于某条入口的错误保留场景码并先报（用户确认的同一组决定）：资源包无法在本实例解析的 external 引用
// （`package-external-unresolved`）与已选目标基线（`package-selected-target-changed`）各单独断言。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { WORKFLOW_SCHEMA_VERSION, type ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { collectPackageRequirements } from '@/services/resourcePackage/requirements'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture, workflowFixture } from './helpers/model'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'
import { workflowAuthorityFor, workflowCatalogFor } from './helpers/workflowCatalog'

const OWNER = 'rfc401-a3-owner'
const OTHER = 'rfc401-a3-other'
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'user', status: 'active' },
  source: 'session',
})

interface Projection {
  readonly code: unknown
  readonly status: unknown
  readonly message: unknown
  readonly details: unknown
}

async function failureOf(run: () => Promise<unknown>): Promise<Projection> {
  try {
    await run()
  } catch (error) {
    const value = error as {
      code?: unknown
      status?: unknown
      message?: unknown
      details?: unknown
    }
    return {
      code: value.code,
      status: value.status,
      message: value.message,
      details: value.details,
    }
  }
  throw new Error('expected the write to be rejected')
}

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

/** 每个节点的引用：自己可见的 agent、别人私有的 agent、缺 agent id、按名字调用一个 workflow、脚本节点。 */
type NodeRef =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'agent-missing-id' }
  | { readonly kind: 'call'; readonly name: string; readonly id: string }
  | { readonly kind: 'script' }

/** 三条入口形状相同的脚本节点（changeset 不得携带 env 值，这里干脆不带）。 */
const SCRIPT_NODE = {
  kind: 'script',
  language: 'python',
  script: 'print("hello")',
  dependencies: [],
  readonly: true,
} as const

interface Draft {
  readonly name: string
  readonly nodes: readonly NodeRef[]
  /** 一条指向 agent 上不存在端口的边——图校验才看得见的错误。 */
  readonly badEdge?: boolean
}

describeEachProvider('RFC-401 A3 workflow error matrix', (harness) => {
  let db: PersistenceDb
  let appHome: string
  const box = createSecretBoxFromKey(randomBytes(32))

  beforeEach(async () => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-a3-'))
    roots.push(appHome)
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    const { users } = tablesOf(db)
    for (const id of [OWNER, OTHER]) {
      await insertOne(db, users, {
        id,
        username: id,
        displayName: id,
        role: 'user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      } as PersistenceTables['users']['$inferInsert'])
    }
    const agent = (id: string, ownerUserId: string) =>
      agentFixture(db, {
        id,
        name: id,
        description: '',
        outputs: '["report"]',
        ownerUserId,
        visibility: 'private',
      })
    await agent('a-own', OWNER)
    await agent('a-hidden', OTHER)
    await workflowFixture(db, {
      id: 'wf-hidden',
      name: 'wf-hidden',
      description: '',
      definition: JSON.stringify(definitionOf([{ kind: 'agent', id: 'a-hidden' }])),
      version: 1,
      schemaVersion: 1,
      ownerUserId: OTHER,
      visibility: 'private',
      builtin: false,
      aclRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
  })

  /** 普通编辑与存储形状：节点带规范 agent id，调用节点带名字与 id 缓存。 */
  function definitionOf(nodes: readonly NodeRef[], badEdge = false): Record<string, unknown> {
    return {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: nodes.map((ref, index) => {
        const id = `n${index + 1}`
        switch (ref.kind) {
          case 'agent':
            return { id, kind: 'agent-single', agentId: ref.id, promptTemplate: 'go' }
          case 'agent-missing-id':
            return { id, kind: 'agent-single', promptTemplate: 'go' }
          case 'call':
            return { id, kind: 'call-workflow', workflowName: ref.name }
          case 'script':
            return { id, ...SCRIPT_NODE }
        }
      }),
      edges: badEdge
        ? [
            {
              id: 'e1',
              source: { nodeId: 'n1', portName: 'nope_not_a_port' },
              target: { nodeId: 'n1', portName: 'task' },
            },
          ]
        : [],
    }
  }

  // ── 普通编辑 ───────────────────────────────────────────────────────────────
  const authority = () => workflowAuthorityFor(OWNER, 'user')
  const catalog = () => workflowCatalogFor(db)

  const ordinary = {
    create: async (draft: Draft) =>
      catalog().operations.create.invoke(authority(), {
        submission: {
          kind: 'json-body',
          body: JSON.stringify({
            name: draft.name,
            description: '',
            definition: definitionOf(draft.nodes, draft.badEdge),
          }),
        },
      }),
    update: async (id: string, expectedVersion: number, draft: Draft) =>
      catalog().operations.update.invoke(authority(), {
        id,
        submission: {
          kind: 'json-body',
          body: JSON.stringify({
            expectedVersion,
            clientMutationId: ulid(),
            snapshot: {
              name: draft.name,
              description: '',
              definition: definitionOf(draft.nodes, draft.badEdge),
            },
          }),
        },
      }),
  }

  // ── Intent ────────────────────────────────────────────────────────────────
  async function intentApply(
    op:
      | { readonly action: 'create' }
      | { readonly action: 'update'; readonly id: string; readonly version: number },
    draft: Draft,
  ): Promise<unknown> {
    const manifest: Record<string, unknown>[] = []
    const handleOf = (type: string, id: string, fence?: Record<string, unknown>) => {
      const existing = manifest.find((entry) => entry.resourceId === id)
      if (existing !== undefined) return existing.handle as string
      const handle = `res#${type}#${manifest.length + 1}`
      manifest.push({
        handle,
        resourceType: type,
        resourceId: id,
        root: fence !== undefined,
        detail: fence !== undefined,
        ...(fence === undefined ? {} : { fence }),
      })
      return handle
    }
    const target =
      op.action === 'update'
        ? handleOf('workflow', op.id, { kind: 'workflow', version: op.version })
        : undefined
    const definition = {
      ...definitionOf([], draft.badEdge),
      nodes: draft.nodes.map((ref, index) => {
        const id = `n${index + 1}`
        switch (ref.kind) {
          case 'agent':
            return {
              id,
              kind: 'agent-single',
              agentRef: handleOf('agent', ref.id),
              promptTemplate: 'go',
            }
          case 'agent-missing-id':
            throw new Error('Intent changesets cannot omit the agent reference')
          case 'call':
            return {
              id,
              kind: 'call-workflow',
              workflowName: ref.name,
              workflowRef: handleOf('workflow', ref.id),
            }
          case 'script':
            return { id, ...SCRIPT_NODE }
        }
      }),
    }
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: op.action,
          resourceType: 'workflow',
          ...(op.action === 'create' ? { tempRef: '$new:wf' } : { target }),
          payload: { name: draft.name, description: '', definition },
        },
      ],
    }
    const sessionId = ulid()
    const draftId = ulid()
    const changesetJson = JSON.stringify(changeset)
    const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
    const { intentSessions, intentDrafts } = tablesOf(db)
    await insertOne(db, intentSessions, {
      id: sessionId,
      ownerUserId: OWNER,
      title: 'rfc401-a3',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as PersistenceTables['intentSessions']['$inferInsert'])
    await insertOne(db, intentDrafts, {
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    } as PersistenceTables['intentDrafts']['$inferInsert'])
    await db
      .update(intentSessions)
      .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
      .where(eq(intentSessions.id, sessionId))
    const { authority: requestAuthority } = composeIdentityAccess(
      db,
    ).contexts.fromAuthenticatedPrincipal({ userId: OWNER, source: 'session' }, 'http')
    return composeIntentApplyOperations({
      db,
      appHome,
      aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
    }).apply({
      actor,
      authority: requestAuthority,
      command: {
        sessionId,
        clientMutationId: ulid(),
        draftRevision: 1,
        draftHash,
        decisions: [],
      },
    })
  }

  const intent = {
    create: (draft: Draft) => intentApply({ action: 'create' }, draft),
    update: (id: string, version: number, draft: Draft) =>
      intentApply({ action: 'update', id, version }, draft),
  }

  // ── 资源包 ────────────────────────────────────────────────────────────────
  function packageBytes(draft: Draft): Uint8Array {
    const definition = {
      ...definitionOf([], draft.badEdge),
      nodes: draft.nodes.map((ref, index) => {
        const id = `n${index + 1}`
        switch (ref.kind) {
          case 'agent':
            return {
              id,
              kind: 'agent-single',
              agentRef: `external:${ref.id}`,
              promptTemplate: 'go',
            }
          case 'agent-missing-id':
            return { id, kind: 'agent-single', promptTemplate: 'go' }
          case 'call':
            return { id, kind: 'call-workflow', workflowRef: `name:workflow/${ref.name}` }
          case 'script':
            return { id, ...SCRIPT_NODE }
        }
      }),
    }
    const bundle = {
      bundleVersion: 1,
      ops: [
        {
          opId: 'op-1',
          kind: 'workflow-create',
          slug: 'candidate',
          payload: { name: draft.name, description: '', definition },
        },
      ],
      rootRef: 'local:candidate',
    }
    const requirements = collectPackageRequirements(bundle as unknown as ResourceBundle)
    return encodeZip([
      {
        path: 'manifest.yaml',
        bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: candidate
  type: workflow
  name: ${draft.name}
resources:
  - slug: candidate
    type: workflow
    name: ${draft.name}
requirements: ${JSON.stringify(requirements)}
secrets: []
danglingCallRefs: []
builtins: []
`),
      },
      { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
    ])
  }

  async function packageApply(
    draft: Draft,
    overwrite?: string,
    beforeCommit?: () => Promise<void>,
  ): Promise<unknown> {
    const pkg = await parseResourcePackage(packageBytes(draft))
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    await beforeCommit?.()
    return commitResourcePackageForTest({ db, appHome, box }, actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [
        overwrite === undefined
          ? { localSlug: 'candidate', action: 'new' as const }
          : { localSlug: 'candidate', action: 'overwrite' as const, targetId: overwrite },
      ],
    })
  }

  async function expectSameFailure(
    expected: Projection,
    runs: Readonly<Record<string, () => Promise<unknown>>>,
  ): Promise<void> {
    const actual: Record<string, Projection> = {}
    for (const [entry, run] of Object.entries(runs)) actual[entry] = await failureOf(run)
    expect(actual).toEqual(Object.fromEntries(Object.keys(runs).map((entry) => [entry, expected])))
  }

  async function namedRows(name: string) {
    const { workflows } = tablesOf(db)
    return db
      .select({ id: workflows.id, ownerUserId: workflows.ownerUserId })
      .from(workflows)
      .where(eq(workflows.name, name))
  }

  async function seedOwn(name: string) {
    const created = await ordinary.create({ name, nodes: [{ kind: 'agent', id: 'a-own' }] })
    return created as { id: string; version: number }
  }

  test('a name the owner already uses is allowed on every entry (proposal §5 #2)', async () => {
    await seedOwn('wf-same')
    const draft: Draft = { name: 'wf-same', nodes: [{ kind: 'agent', id: 'a-own' }] }
    await ordinary.create(draft)
    await intent.create(draft)
    await packageApply(draft)
    const rows = await namedRows('wf-same')
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.ownerUserId))).toEqual(new Set([OWNER]))
  })

  test('a workflow that fails graph validation is saved on every entry (proposal §5 #8)', async () => {
    const draft = (name: string): Draft => ({
      name,
      nodes: [{ kind: 'agent', id: 'a-own' }],
      badEdge: true,
    })
    await ordinary.create(draft('wf-graph-ordinary'))
    await intent.create(draft('wf-graph-intent'))
    await packageApply(draft('wf-graph-package'))
    for (const name of ['wf-graph-ordinary', 'wf-graph-intent', 'wf-graph-package'])
      expect(await namedRows(name)).toHaveLength(1)
  })

  test("calling another user's private workflow by name → acl-missing-refs with details", async () => {
    const draft: Draft = {
      name: 'wf-caller',
      nodes: [{ kind: 'call', name: 'wf-hidden', id: 'wf-hidden' }],
    }
    await expectSameFailure(
      {
        code: 'acl-missing-refs',
        status: 422,
        message: "you do not have access to: workflow 'wf-hidden'",
        details: { missing: [{ type: 'workflow', name: 'wf-hidden' }] },
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
        resourcePackage: () => packageApply(draft),
      },
    )
  })

  test("another user's private agent → acl-missing-refs; the package reports its scene code first", async () => {
    const draft: Draft = { name: 'wf-hidden-agent', nodes: [{ kind: 'agent', id: 'a-hidden' }] }
    await expectSameFailure(
      {
        code: 'acl-missing-refs',
        status: 422,
        message: "you do not have access to: agent 'a-hidden'",
        details: { missing: [{ type: 'agent', name: 'a-hidden' }] },
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
      },
    )
    // 资源包的 external 引用要先在本实例解析（场景引用解析，先于共同写入层）。
    expect(await failureOf(() => packageApply(draft))).toMatchObject({
      code: 'package-external-unresolved',
    })
  })

  test('a script node without scripts:author → script-author-forbidden; the package reports its scene code first', async () => {
    const draft: Draft = { name: 'wf-script', nodes: [{ kind: 'script' }] }
    await expectSameFailure(
      {
        code: 'script-author-forbidden',
        status: 403,
        message:
          'changing a script node (its body, language, dependencies, environment or write mode, its inbound wiring, or its wrapper placement) requires the scripts:author permission',
        details: undefined,
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
      },
    )
    // 资源包按包内容先要求导入权限：预览不提供「新建」这一动作（场景规则，先于共同写入层）。
    expect(await failureOf(() => packageApply(draft))).toMatchObject({
      code: 'package-decision-not-allowed',
    })
  })

  test('an agent node without a canonical agent id → workflow-agent-id-required', async () => {
    const draft: Draft = { name: 'wf-no-agent-id', nodes: [{ kind: 'agent-missing-id' }] }
    // 只有普通编辑能把这种定义送到共同写入层：Intent 的变更集 schema 与资源包的 wire 格式都要求 agent 引用（场景格式）。
    expect(await failureOf(() => ordinary.create(draft))).toEqual({
      code: 'workflow-agent-id-required',
      status: 422,
      message: 'agent-single nodes require a canonical agentId',
      details: { nodeIds: ['n1'] },
    })
    expect(await failureOf(() => packageApply(draft))).toMatchObject({ code: 'package-invalid' })
    expect(await namedRows('wf-no-agent-id')).toHaveLength(0)
  })

  test('a stale version → resource-operation-stale with the current revision', async () => {
    const seeded = await seedOwn('wf-stale')
    // 别人先保存了一版。
    await ordinary.update(seeded.id, 1, {
      name: 'wf-stale',
      nodes: [
        { kind: 'agent', id: 'a-own' },
        { kind: 'agent', id: 'a-own' },
      ],
    })
    const { workflows } = tablesOf(db)
    const [current] = await db.select().from(workflows).where(eq(workflows.id, seeded.id))
    const stale = (projection: Projection) => {
      expect(projection.code).toBe('resource-operation-stale')
      expect(projection.status).toBe(409)
      expect(projection.message).toBe(`workflow '${seeded.id}' changed; reload`)
      expect(projection.details).toMatchObject({
        current: { workflowId: seeded.id, version: current!.version },
      })
      return projection
    }
    const changed: Draft = { name: 'wf-stale', nodes: [] }
    const ordinaryFailure = stale(await failureOf(() => ordinary.update(seeded.id, 1, changed)))
    const intentFailure = stale(await failureOf(() => intent.update(seeded.id, 1, changed)))
    expect(intentFailure).toEqual(ordinaryFailure)
    // 资源包的已选目标基线先于资源层 stale（proposal §5 第 11 项）。
    expect(
      await failureOf(() =>
        packageApply(changed, seeded.id, async () => {
          await ordinary.update(seeded.id, current!.version, {
            name: 'wf-stale',
            nodes: [{ kind: 'agent', id: 'a-own' }],
          })
        }),
      ),
    ).toMatchObject({ code: 'package-selected-target-changed' })
  })
})
