// RFC-401 A1 —— agent 写入的错误矩阵（AC-2 的 agent 部分，design §9.2）。
//
// 同一非法输入经三条入口、两种 provider 得到同一 code / status / message / details：
//   · 普通编辑：agent 仓库（HTTP / MCP 的 CRUD 都经它）；
//   · Intent：确认后的 apply（会话 + 草稿 + resolveIntentBundle + apply 引擎）；
//   · 资源包：parse → preview → commit。
// proposal §5 第 1、3、4、5、6 项，用户 2026-11-02 确认以普通编辑现行行为为准。RFC-401 A1 之前三条入口各有一份
// 校验：Intent 报 `intent-name-conflict` / `acl-missing-refs` / `agent-runtime-not-found`，资源包报
// `package-external-unresolved`，包内依赖环落成 `internal-error`。
//
// Intent 的草稿校验（确认前给模型与用户的反馈：句柄未知、新建 agent 之间的 tempRef 环、新建 agent 的 branch port）
// 是场景校验，先于共同写入层（design §2.2），不在本矩阵里；这里的 Intent 输入都能通过草稿校验。
// 资源包的已选目标基线先于资源层 stale（proposal §5 第 11 项），stale 一例单独断言。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { CreateAgentSchema, type ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { collectPackageRequirements } from '@/services/resourcePackage/requirements'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture, patchAgentFixture, readAgentFixtures } from './helpers/model'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const OWNER = 'rfc401-owner'
const OTHER = 'rfc401-other'
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'user', status: 'active' },
  source: 'session',
})
const authority = actor as unknown as DirectAuthenticatedAuthority

/** 一个 agent 定义，引用都是资源 id；各入口按自己的形态表达（句柄、external 引用）。 */
interface Draft {
  readonly name: string
  readonly outputs?: readonly string[]
  readonly branchPorts?: readonly string[]
  readonly runtime?: string
  readonly dependsOn?: readonly string[]
  readonly mcp?: readonly string[]
  readonly plugins?: readonly string[]
  readonly skills?: readonly string[]
  readonly description?: string
}

interface Projection {
  readonly code: unknown
  readonly status: unknown
  readonly message: unknown
  readonly details: unknown
}

/** 闭包预检的 issues 带 rootAgentId（各入口铸的 id 不同），比较时抹掉。 */
function project(error: unknown): Projection {
  const value = error as {
    code?: unknown
    status?: unknown
    message?: unknown
    details?: unknown
  }
  const details = value.details as { issues?: { rootAgentId?: unknown }[] } | undefined
  return {
    code: value.code,
    status: value.status,
    message: value.message,
    details:
      details?.issues === undefined
        ? value.details
        : {
            ...details,
            issues: details.issues.map((issue) => ({ ...issue, rootAgentId: 'ROOT' })),
          },
  }
}

async function failureOf(run: () => Promise<unknown>): Promise<Projection> {
  try {
    await run()
  } catch (error) {
    return project(error)
  }
  throw new Error('expected the write to be rejected')
}

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

describeEachProvider('RFC-401 A1 agent error matrix', (harness) => {
  let db: PersistenceDb
  let appHome: string
  const box = createSecretBoxFromKey(randomBytes(32))

  beforeEach(async () => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-matrix-'))
    roots.push(appHome)
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    const { users, runtimes, mcps, plugins } = tablesOf(db)
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
    await insertOne(db, runtimes, {
      id: 'rt-live',
      name: 'rt-live',
      protocol: 'opencode',
      binaryPath: null,
      model: null,
    } as PersistenceTables['runtimes']['$inferInsert'])
    await insertOne(db, runtimes, {
      id: 'rt-off',
      name: 'rt-off',
      protocol: 'opencode',
      binaryPath: null,
      model: null,
      enabled: false,
    } as PersistenceTables['runtimes']['$inferInsert'])
    await agentFixture(db, [
      {
        id: 'base',
        name: 'base',
        ownerUserId: OWNER,
        visibility: 'private',
        outputs: '["yes","no"]',
        frontmatterExtra: '{"branchPorts":["yes"]}',
      },
      { id: 'peer', name: 'peer', ownerUserId: OWNER, visibility: 'private' },
    ])
    await insertOne(db, mcps, {
      id: 'm-hidden',
      name: 'm-hidden',
      type: 'local',
      config: '{"command":["echo"]}',
      ownerUserId: OTHER,
      visibility: 'private',
      createdAt: 1,
      updatedAt: 1,
    } as PersistenceTables['mcps']['$inferInsert'])
    await insertOne(db, plugins, {
      id: 'p-off',
      name: 'p-off',
      spec: 'fixture@1.0.0',
      sourceKind: 'npm',
      cachedPath: '/tmp/rfc401-plugin',
      installedAt: 1,
      enabled: false,
      ownerUserId: OWNER,
      createdAt: 1,
      updatedAt: 1,
    } as PersistenceTables['plugins']['$inferInsert'])
  })

  const fenceOf = async (id: string) => {
    const row = (await readAgentFixtures(db, { id }))[0]!
    return { expectedUpdatedAt: row.updatedAt, expectedAclRevision: row.aclRevision }
  }

  // ── 普通编辑 ───────────────────────────────────────────────────────────────
  function repository() {
    return createAgentRepository({
      db,
      semantics: createAgentPersistenceSemantics({
        db,
        authorization: composeResourceCatalogFor({ db }).authorization,
        taskReferences: composeSubjectTaskReferencePort,
      }),
    })
  }

  function createAgentOf(draft: Draft) {
    return CreateAgentSchema.parse({
      name: draft.name,
      description: draft.description ?? '',
      outputs: draft.outputs ?? [],
      bodyMd: 'x',
      dependsOn: draft.dependsOn ?? [],
      mcp: draft.mcp ?? [],
      plugins: draft.plugins ?? [],
      skills: (draft.skills ?? []).map((skillId) => ({ kind: 'managed', skillId })),
      ...(draft.runtime === undefined ? {} : { runtime: draft.runtime }),
      ...(draft.branchPorts === undefined ? {} : { branchPorts: draft.branchPorts }),
    })
  }

  const ordinary = {
    create: (draft: Draft) => repository().create(authority, createAgentOf(draft)),
    async update(id: string, draft: Draft, fence?: Awaited<ReturnType<typeof fenceOf>>) {
      const { name: _name, ...patch } = createAgentOf(draft)
      return repository().update(authority, id, patch, fence ?? (await fenceOf(id)))
    },
  }

  // ── Intent ────────────────────────────────────────────────────────────────
  interface IntentOp {
    readonly action: 'create' | 'update'
    readonly id?: string
    readonly draft: Draft
    readonly staleFence?: boolean
  }

  async function intentApply(ops: readonly IntentOp[]): Promise<unknown> {
    const handles = new Map<string, string>()
    const manifest: Record<string, unknown>[] = []
    const handleOf = (type: string, id: string, detail = false) => {
      const key = `${type}:${id}`
      const existing = handles.get(key)
      if (existing !== undefined) return existing
      const handle = `res#${type}#${handles.size + 1}`
      handles.set(key, handle)
      manifest.push({ handle, resourceType: type, resourceId: id, root: detail, detail })
      return handle
    }
    for (const op of ops) {
      if (op.action !== 'update') continue
      const fence = await fenceOf(op.id!)
      const handle = handleOf('agent', op.id!, true)
      const entry = manifest.find((candidate) => candidate.handle === handle)!
      entry.fence = {
        kind: 'agent',
        updatedAt: op.staleFence === true ? fence.expectedUpdatedAt - 1 : fence.expectedUpdatedAt,
        aclRevision: fence.expectedAclRevision,
      }
    }
    const changeset = {
      $schema_version: 1,
      ops: ops.map((op, index) => ({
        opId: `op-${index + 1}`,
        action: op.action,
        resourceType: 'agent',
        ...(op.action === 'create'
          ? { tempRef: `$new:a${index + 1}` }
          : { target: handleOf('agent', op.id!, true) }),
        payload: {
          name: op.draft.name,
          description: op.draft.description ?? '',
          outputs: op.draft.outputs ?? [],
          bodyMd: 'x',
          dependsOn: (op.draft.dependsOn ?? []).map((id) => handleOf('agent', id)),
          mcp: (op.draft.mcp ?? []).map((id) => handleOf('mcp', id)),
          plugins: (op.draft.plugins ?? []).map((id) => handleOf('plugin', id)),
          skills: (op.draft.skills ?? []).map((id) => handleOf('skill', id)),
          ...(op.draft.runtime === undefined ? {} : { runtime: op.draft.runtime }),
          ...(op.draft.branchPorts === undefined ? {} : { branchPorts: op.draft.branchPorts }),
        },
      })),
    }
    const sessionId = ulid()
    const draftId = ulid()
    const changesetJson = JSON.stringify(changeset)
    const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
    const { intentSessions, intentDrafts } = tablesOf(db)
    await insertOne(db, intentSessions, {
      id: sessionId,
      ownerUserId: OWNER,
      title: 'rfc401',
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
    create: (draft: Draft) => intentApply([{ action: 'create', draft }]),
    update: (id: string, draft: Draft) => intentApply([{ action: 'update', id, draft }]),
  }

  // ── 资源包 ────────────────────────────────────────────────────────────────
  interface PackageOp {
    readonly slug: string
    readonly draft: Draft
    /** 本包内的依赖（slug）。 */
    readonly localDependsOn?: readonly string[]
    /** overwrite 到既有 agent。 */
    readonly overwrite?: string
  }

  function packageBytes(ops: readonly PackageOp[]): Uint8Array {
    const bundleOps = ops.map((op, index) => ({
      opId: `op-${index + 1}`,
      kind: 'agent-create',
      slug: op.slug,
      payload: {
        name: op.draft.name,
        description: op.draft.description ?? '',
        outputs: op.draft.outputs ?? [],
        syncOutputsOnIterate: true,
        permission: {},
        skills: (op.draft.skills ?? []).map((id) => `external:${id}`),
        dependsOn: [
          ...(op.draft.dependsOn ?? []).map((id) => `external:${id}`),
          ...(op.localDependsOn ?? []).map((slug) => `local:${slug}`),
        ],
        mcp: (op.draft.mcp ?? []).map((id) => `external:${id}`),
        plugins: (op.draft.plugins ?? []).map((id) => `external:${id}`),
        frontmatterExtra: {},
        bodyMd: 'x',
        ...(op.draft.runtime === undefined ? {} : { runtime: op.draft.runtime }),
        ...(op.draft.branchPorts === undefined ? {} : { branchPorts: op.draft.branchPorts }),
      },
    }))
    const bundle = { bundleVersion: 1, ops: bundleOps, rootRef: `local:${ops[0]!.slug}` }
    const requirements = collectPackageRequirements(bundle as unknown as ResourceBundle)
    return encodeZip([
      {
        path: 'manifest.yaml',
        bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${ops[0]!.slug}
  type: agent
  name: ${ops[0]!.draft.name}
resources:
${ops.map((op) => `  - slug: ${op.slug}\n    type: agent\n    name: ${op.draft.name}`).join('\n')}
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
    ops: readonly PackageOp[],
    beforeCommit?: () => Promise<void>,
  ): Promise<unknown> {
    const pkg = await parseResourcePackage(packageBytes(ops))
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    await beforeCommit?.()
    return commitResourcePackageForTest({ db, appHome, box }, actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: ops.map((op) =>
        op.overwrite === undefined
          ? { localSlug: op.slug, action: 'new' as const }
          : { localSlug: op.slug, action: 'overwrite' as const, targetId: op.overwrite },
      ),
    })
  }

  const resourcePackage = {
    create: (draft: Draft) => packageApply([{ slug: 'candidate', draft }]),
    update: (id: string, draft: Draft) =>
      packageApply([{ slug: 'candidate', draft, overwrite: id }]),
  }

  async function expectSameFailure(
    expected: Projection,
    runs: Readonly<Record<string, () => Promise<unknown>>>,
  ): Promise<void> {
    const actual: Record<string, Projection> = {}
    for (const [entry, run] of Object.entries(runs)) actual[entry] = await failureOf(run)
    expect(actual).toEqual(Object.fromEntries(Object.keys(runs).map((entry) => [entry, expected])))
  }

  const createEverywhere = (draft: Draft) => ({
    ordinary: () => ordinary.create(draft),
    intent: () => intent.create(draft),
    resourcePackage: () => resourcePackage.create(draft),
  })

  const updateEverywhere = (id: string, draft: Draft) => ({
    ordinary: () => ordinary.update(id, draft),
    intent: () => intent.update(id, draft),
    resourcePackage: () => resourcePackage.update(id, draft),
  })

  test('same name as an existing agent of the same owner → agent-name-in-use / 409', async () => {
    await expectSameFailure(
      {
        code: 'agent-name-in-use',
        status: 409,
        message: "agent 'base' already exists",
        details: undefined,
      },
      createEverywhere({ name: 'base' }),
    )
  })

  test('missing direct dependency → agent-dependency-not-found', async () => {
    await expectSameFailure(
      {
        code: 'agent-dependency-not-found',
        status: 422,
        message: 'agent references unknown agent dependency(s): gone',
        details: { notFound: ['gone'] },
      },
      createEverywhere({ name: 'fresh', dependsOn: ['gone'] }),
    )
  })

  test('missing MCP / plugin → mcp-not-found / plugin-not-found', async () => {
    await expectSameFailure(
      {
        code: 'mcp-not-found',
        status: 422,
        message: 'agent references unknown mcp(s): m-gone',
        details: { notFound: ['m-gone'] },
      },
      createEverywhere({ name: 'fresh', mcp: ['m-gone'] }),
    )
    await expectSameFailure(
      {
        code: 'plugin-not-found',
        status: 422,
        message: 'agent references unknown plugin(s): p-gone',
        details: { notFound: ['p-gone'] },
      },
      createEverywhere({ name: 'fresh', plugins: ['p-gone'] }),
    )
  })

  // 普通编辑的新增引用只认启用的 plugin：新引用一个停用的 plugin 与引用不存在的同报 plugin-not-found。
  test('new reference to a disabled plugin → plugin-not-found', async () => {
    await expectSameFailure(
      {
        code: 'plugin-not-found',
        status: 422,
        message: 'agent references unknown plugin(s): p-off',
        details: { notFound: ['p-off'] },
      },
      createEverywhere({ name: 'fresh', plugins: ['p-off'] }),
    )
  })

  // 普通编辑：缺失的 managed skill 由 RFC-228 闭包预检报（design §2.2 对 proposal §5 第 4 项的更正）。
  test('missing managed skill → agent-resources-invalid with the closure issue', async () => {
    await expectSameFailure(
      {
        code: 'agent-resources-invalid',
        status: 422,
        message: 'agent resource closure is invalid (1 issue)',
        details: {
          issues: [
            { code: 'skill-not-found', refKind: 'skill', rootAgentId: 'ROOT', direct: true },
          ],
        },
      },
      createEverywhere({ name: 'fresh', skills: ['s-gone'] }),
    )
  })

  test('missing / disabled runtime → runtime-not-found / runtime-disabled', async () => {
    await expectSameFailure(
      {
        code: 'runtime-not-found',
        status: 422,
        message: 'agent references unknown runtime: rt-ghost',
        details: { notFound: ['rt-ghost'] },
      },
      createEverywhere({ name: 'fresh', runtime: 'rt-ghost' }),
    )
    await expectSameFailure(
      {
        code: 'runtime-disabled',
        status: 422,
        message: 'agent references disabled runtime: rt-off; enable it or pick another',
        details: { disabled: ['rt-off'] },
      },
      createEverywhere({ name: 'fresh', runtime: 'rt-off' }),
    )
  })

  test("another user's private MCP → acl-missing-refs", async () => {
    await expectSameFailure(
      {
        code: 'acl-missing-refs',
        status: 422,
        message: "you do not have access to: mcp 'm-hidden'",
        details: { missing: [{ type: 'mcp', name: 'm-hidden' }] },
      },
      createEverywhere({ name: 'fresh', mcp: ['m-hidden'] }),
    )
  })

  test('self-dependency → agent-dependency-self', async () => {
    await expectSameFailure(
      {
        code: 'agent-dependency-self',
        status: 422,
        message: 'agent cannot depend on itself',
        details: undefined,
      },
      updateEverywhere('base', { name: 'base', outputs: ['yes', 'no'], dependsOn: ['base'] }),
    )
  })

  test('cycle through an existing agent → agent-dependency-cycle', async () => {
    await patchAgentFixture(db, { id: 'peer' }, { dependsOn: '["base"]' })
    await expectSameFailure(
      {
        code: 'agent-dependency-cycle',
        status: 422,
        message: 'agent dependency graph contains a cycle',
        details: undefined,
      },
      updateEverywhere('base', { name: 'base', outputs: ['yes', 'no'], dependsOn: ['peer'] }),
    )
  })

  // 已在用的 plugin 后来被停用：全量检查 enabled（RFC-031）。
  test('existing reference to a plugin that was disabled later → plugin-disabled', async () => {
    await patchAgentFixture(db, { id: 'base' }, { plugins: '["p-off"]' })
    await expectSameFailure(
      {
        code: 'plugin-disabled',
        status: 422,
        message: 'agent references disabled plugin(s): p-off',
        details: { disabled: ['p-off'] },
      },
      updateEverywhere('base', {
        name: 'base',
        outputs: ['yes', 'no'],
        plugins: ['p-off'],
        description: 'changed',
      }),
    )
  })

  // 存着的 branch port 不在新的 outputs 里（Intent 的草稿校验在 apply 时看不到存着的 branch port，由写入层报）。
  test('stored branch port that the new outputs no longer declare → branch-port-not-declared', async () => {
    await expectSameFailure(
      {
        code: 'branch-port-not-declared',
        status: 422,
        message: 'agent branchPorts reference undeclared output port(s): yes',
        details: { notFound: ['yes'] },
      },
      updateEverywhere('base', { name: 'base', outputs: ['no'] }),
    )
  })

  test('stale revision → resource-operation-stale (package: its selected-target baseline first)', async () => {
    const staleFence = await fenceOf('base')
    const draft: Draft = { name: 'base', outputs: ['yes', 'no'], description: 'changed' }
    await expectSameFailure(
      {
        code: 'resource-operation-stale',
        status: 409,
        message: "agent 'base' changed; reload and retry",
        details: { resource: 'agent' },
      },
      {
        ordinary: async () => {
          await patchAgentFixture(
            db,
            { id: 'base' },
            { updatedAt: staleFence.expectedUpdatedAt + 5 },
          )
          return ordinary.update('base', draft, staleFence)
        },
        intent: () => intentApply([{ action: 'update', id: 'base', draft, staleFence: true }]),
      },
    )
    // 资源包：已选目标在 preview 之后变化，由场景基线先报（proposal §5 第 11 项）。
    expect(
      await failureOf(() =>
        packageApply([{ slug: 'candidate', draft, overwrite: 'base' }], async () => {
          const fence = await fenceOf('base')
          await patchAgentFixture(db, { id: 'base' }, { updatedAt: fence.expectedUpdatedAt + 5 })
        }),
      ),
    ).toMatchObject({ code: 'package-selected-target-changed', status: 409 })
  })

  // 批内依赖环：只有 Intent 与资源包能一次写多个 agent。此前 Intent 在排序时报 `intent-draft-invalid`，资源包抛普通
  // Error 落成 `internal-error`；现在由写入参与者以本批最终 dependsOn 报普通编辑的错误。
  test('dependency cycle inside one batch → agent-dependency-cycle; self-dependency → agent-dependency-self', async () => {
    await expectSameFailure(
      {
        code: 'agent-dependency-cycle',
        status: 422,
        message: 'agent dependency graph contains a cycle',
        details: undefined,
      },
      {
        intent: () =>
          intentApply([
            {
              action: 'update',
              id: 'base',
              draft: { name: 'base', outputs: ['yes', 'no'], dependsOn: ['peer'] },
            },
            { action: 'update', id: 'peer', draft: { name: 'peer', dependsOn: ['base'] } },
          ]),
        resourcePackage: () =>
          packageApply([
            { slug: 'x', draft: { name: 'x' }, localDependsOn: ['y'] },
            { slug: 'y', draft: { name: 'y' }, localDependsOn: ['x'] },
          ]),
      },
    )
    await expectSameFailure(
      {
        code: 'agent-dependency-self',
        status: 422,
        message: 'agent cannot depend on itself',
        details: undefined,
      },
      {
        resourcePackage: () =>
          packageApply([{ slug: 'x', draft: { name: 'x' }, localDependsOn: ['x'] }]),
      },
    )
  })

  test('references are deduplicated the same way on every entry (design §2.4)', async () => {
    await ordinary.create({ name: 'via-ordinary', dependsOn: ['peer', 'base', 'peer'] })
    await intent.create({ name: 'via-intent', dependsOn: ['peer', 'base', 'peer'] })
    await resourcePackage.create({ name: 'via-package', dependsOn: ['peer', 'base', 'peer'] })
    for (const name of ['via-ordinary', 'via-intent', 'via-package']) {
      const row = (await readAgentFixtures(db, { name }))[0]
      expect({ name, dependsOn: row?.dependsOn }).toEqual({
        name,
        dependsOn: JSON.stringify(['peer', 'base']),
      })
    }
  })
})
