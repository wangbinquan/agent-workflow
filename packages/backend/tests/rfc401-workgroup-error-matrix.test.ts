// RFC-401 A3b —— workgroup 写入的错误矩阵（AC-2 的 workgroup 部分，design §9.5）。
//
// 同一输入经三条入口、两种 provider 得到同一 code / status / message / details：普通编辑（目录模块的命令）、Intent（确认后的
// apply）、资源包（parse → preview → commit）。用户 2026-11-02 确认以普通编辑现行行为为准（proposal §5 第 1、7 项）：
//   · Intent 新建同名 workgroup 此前在解析期报 `intent-name-conflict`（422），现在与普通编辑一样报 `workgroup-name-in-use`（409）；
//   · Intent 人类成员无效此前报 `workgroup-human-inactive`（无 details），现在报 `workgroup-member-user-invalid`（details.userIds）；
//   · Intent 对不存在的 agent 成员此前报 `acl-missing-refs`（details 用 `id` 键），现在新建报 `workgroup-member-agent-invalid`；
//   · Intent 的 stale 此前不带 details；内容没变的成员名单此前每次更新都重建成员行。
//
// 只属于某条入口的错误保留场景码并先报：资源包的 external 解析（`package-external-unresolved`）、人类成员映射
// （`package-human-mapping-invalid`）与已选目标基线（`package-selected-target-changed`）各单独断言。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { parseResourcePackage } from '@/modules/resource-catalog/application/package/parse'
import { collectPackageRequirements } from '@/modules/resource-catalog/application/package/requirements'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture } from './helpers/model'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const OWNER = 'rfc401-a3b-owner'
const OTHER = 'rfc401-a3b-other'
const ACTIVE = 'rfc401-a3b-active'
const DISABLED = 'rfc401-a3b-disabled'
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

/** 一个成员：agent（按 id）或人类（按 user id；资源包按用户名映射）。 */
type Member =
  | { readonly kind: 'agent'; readonly id: string; readonly displayName: string }
  | { readonly kind: 'human'; readonly userId: string; readonly displayName: string }

interface Draft {
  readonly name: string
  readonly description?: string
  readonly members: readonly Member[]
}

/** 三条入口都写全的固定字段（Intent 的更新载荷要求完整快照）。 */
const FIXED = {
  instructions: 'work',
  mode: 'free_collab' as const,
  switches: { shareOutputs: true, directMessages: false, blackboard: false },
  maxRounds: 20,
  completionGate: true,
  clarifyBudget: 3,
  fanOut: false,
}

describeEachProvider('RFC-401 A3b workgroup error matrix', (harness) => {
  let db: PersistenceDb
  let appHome: string
  const box = createSecretBoxFromKey(randomBytes(32))

  beforeEach(async () => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-a3b-'))
    roots.push(appHome)
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    const { users } = tablesOf(db)
    for (const [id, status] of [
      [OWNER, 'active'],
      [OTHER, 'active'],
      [ACTIVE, 'active'],
      [DISABLED, 'disabled'],
    ] as const) {
      await insertOne(db, users, {
        id,
        username: id,
        displayName: id,
        role: 'user',
        status,
        createdAt: 1,
        updatedAt: 1,
      } as PersistenceTables['users']['$inferInsert'])
    }
    for (const [id, owner] of [
      ['a-own', OWNER],
      ['a-hidden', OTHER],
    ] as const) {
      await agentFixture(db, {
        id,
        name: id,
        description: '',
        ownerUserId: owner,
        visibility: 'private',
      })
    }
  })

  const membersOf = (draft: Draft) =>
    draft.members.map((member) =>
      member.kind === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.id,
            displayName: member.displayName,
            roleDesc: 'helps',
          }
        : {
            memberType: 'human' as const,
            userId: member.userId,
            displayName: member.displayName,
            roleDesc: 'helps',
          },
    )

  // ── 普通编辑 ───────────────────────────────────────────────────────────────
  function authority(): WorkgroupOperationContext {
    return new AuthorityClaimRegistry().mintDirectAuthority(
      { userId: OWNER, source: 'session' },
      { ...actor, userId: OWNER },
    ).actor
  }
  const catalog = () =>
    composeWorkgroupCatalog({
      db,
      taskReferences: composeSubjectTaskReferencePort,
      resourceCatalog: composeResourceCatalogFor({ db }),
    })

  const ordinary = {
    create: async (draft: Draft) =>
      catalog().operations.create.invoke(authority(), {
        name: draft.name,
        description: draft.description ?? '',
        ...FIXED,
        members: membersOf(draft),
      }),
    update: async (id: string, expectedVersion: number, draft: Draft) =>
      catalog().operations.update.invoke(authority(), {
        id,
        update: {
          expectedVersion,
          clientMutationId: ulid(),
          snapshot: {
            name: draft.name,
            description: draft.description ?? '',
            ...FIXED,
            outputContract: 'files',
            members: membersOf(draft),
          },
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
        ? handleOf('workgroup', op.id, { kind: 'workgroup', version: op.version })
        : undefined
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: op.action,
          resourceType: 'workgroup',
          ...(op.action === 'create' ? { tempRef: '$new:wg' } : { target }),
          payload: {
            name: draft.name,
            description: draft.description ?? '',
            ...FIXED,
            ...(op.action === 'update' ? { outputContract: 'files' } : {}),
            members: draft.members.map((member) =>
              member.kind === 'agent'
                ? {
                    memberType: 'agent',
                    agentRef: handleOf('agent', member.id),
                    displayName: member.displayName,
                    roleDesc: 'helps',
                  }
                : { memberType: 'human', displayName: member.displayName, roleDesc: 'helps' },
            ),
          },
        },
      ],
    }
    const decisions = draft.members.flatMap((member) =>
      member.kind === 'human'
        ? [
            {
              opId: 'op-1',
              slots: [{ slotId: `human:op-1:${member.displayName}`, value: member.userId }],
            },
          ]
        : [],
    )
    const sessionId = ulid()
    const draftId = ulid()
    const changesetJson = JSON.stringify(changeset)
    const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
    const { intentSessions, intentDrafts } = tablesOf(db)
    await insertOne(db, intentSessions, {
      id: sessionId,
      ownerUserId: OWNER,
      title: 'rfc401-a3b',
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
        decisions,
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
    const bundle = {
      bundleVersion: 1,
      ops: [
        {
          opId: 'op-1',
          kind: 'workgroup-create',
          slug: 'candidate',
          payload: {
            name: draft.name,
            description: draft.description ?? '',
            ...FIXED,
            leaderDisplayName: null,
            members: draft.members.map((member, sortOrder) =>
              member.kind === 'agent'
                ? {
                    memberType: 'agent',
                    agentRef: `external:${member.id}`,
                    displayName: member.displayName,
                    roleDesc: 'helps',
                    sortOrder,
                  }
                : {
                    memberType: 'human',
                    username: member.userId,
                    displayName: member.displayName,
                    roleDesc: 'helps',
                    sortOrder,
                  },
            ),
          },
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
  type: workgroup
  name: ${draft.name}
resources:
  - slug: candidate
    type: workgroup
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
      humanMemberMappings: draft.members.flatMap((member) =>
        member.kind === 'human'
          ? [{ workgroupSlug: 'candidate', username: member.userId, userId: member.userId }]
          : [],
      ),
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

  async function rowsNamed(name: string) {
    const { workgroups } = tablesOf(db)
    return db.select({ id: workgroups.id }).from(workgroups).where(eq(workgroups.name, name))
  }

  const agentMember = (id: string): Member => ({ kind: 'agent', id, displayName: 'worker' })

  test('a name the owner already uses → workgroup-name-in-use / 409 (proposal §5 #1)', async () => {
    await ordinary.create({ name: 'wg-taken', members: [agentMember('a-own')] })
    const draft: Draft = { name: 'wg-taken', members: [agentMember('a-own')] }
    await expectSameFailure(
      {
        code: 'workgroup-name-in-use',
        status: 409,
        message: "workgroup 'wg-taken' already exists",
        details: undefined,
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
        resourcePackage: () => packageApply(draft),
      },
    )
    expect(await rowsNamed('wg-taken')).toHaveLength(1)
  })

  test('an inactive human member → workgroup-member-user-invalid (proposal §5 #7)', async () => {
    const draft: Draft = {
      name: 'wg-inactive',
      members: [{ kind: 'human', userId: DISABLED, displayName: 'reviewer' }],
    }
    await expectSameFailure(
      {
        code: 'workgroup-member-user-invalid',
        status: 422,
        message: 'human member user(s) not active',
        details: { userIds: [DISABLED] },
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
      },
    )
    // 资源包的人类成员先经确认的映射落到用户（场景规则，先于共同写入层）。
    expect(await failureOf(() => packageApply(draft))).toMatchObject({
      code: 'package-human-mapping-invalid',
    })
    expect(await rowsNamed('wg-inactive')).toHaveLength(0)
  })

  test("another user's private agent → acl-missing-refs; the package reports its scene code first", async () => {
    const draft: Draft = { name: 'wg-hidden', members: [agentMember('a-hidden')] }
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
    expect(await failureOf(() => packageApply(draft))).toMatchObject({
      code: 'package-external-unresolved',
    })
  })

  test('a member agent that does not exist → workgroup-member-agent-invalid', async () => {
    const draft: Draft = { name: 'wg-missing', members: [agentMember('a-gone')] }
    await expectSameFailure(
      {
        code: 'workgroup-member-agent-invalid',
        status: 422,
        message: 'agent member id(s) do not exist',
        details: { agentIds: ['a-gone'] },
      },
      {
        ordinary: () => ordinary.create(draft),
        intent: () => intent.create(draft),
      },
    )
    expect(await failureOf(() => packageApply(draft))).toMatchObject({
      code: 'package-external-unresolved',
    })
  })

  test('a stale version → resource-operation-stale with the current revision', async () => {
    const seeded = (await ordinary.create({
      name: 'wg-stale',
      members: [agentMember('a-own')],
    })) as { id: string }
    await ordinary.update(seeded.id, 1, {
      name: 'wg-stale',
      description: 'second',
      members: [agentMember('a-own')],
    })
    const changed: Draft = {
      name: 'wg-stale',
      description: 'mine',
      members: [agentMember('a-own')],
    }
    const ordinaryFailure = await failureOf(() => ordinary.update(seeded.id, 1, changed))
    expect(ordinaryFailure).toMatchObject({
      code: 'resource-operation-stale',
      status: 409,
      message: `workgroup '${seeded.id}' is at version 2, expected 1`,
      details: { current: { workgroupId: seeded.id, version: 2 } },
    })
    expect(await failureOf(() => intent.update(seeded.id, 1, changed))).toEqual(ordinaryFailure)
    // 资源包的已选目标基线先于资源层 stale（proposal §5 第 11 项）。
    expect(
      await failureOf(() =>
        packageApply(changed, seeded.id, async () => {
          await ordinary.update(seeded.id, 2, {
            name: 'wg-stale',
            description: 'third',
            members: [agentMember('a-own')],
          })
        }),
      ),
    ).toMatchObject({ code: 'package-selected-target-changed' })
  })

  test('an Intent update that keeps the roster keeps the member rows (as ordinary saves do)', async () => {
    const seeded = (await ordinary.create({
      name: 'wg-roster',
      members: [agentMember('a-own')],
    })) as { id: string }
    const { workgroupMembers } = tablesOf(db)
    const before = await db
      .select({ id: workgroupMembers.id })
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, seeded.id))
    await intent.update(seeded.id, 1, {
      name: 'wg-roster',
      description: 'only the description changed',
      members: [agentMember('a-own')],
    })
    const after = await db
      .select({ id: workgroupMembers.id })
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, seeded.id))
    expect(after).toEqual(before)
  })
})
