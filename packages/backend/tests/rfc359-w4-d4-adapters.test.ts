// RFC-359 W4-D4 —— memory 目录、resource-catalog 的 scope 访问 participant、memory 的融合 participant、
// source-control 的仓库 scope 读取器合一之后，同一段断言在两个引擎上各跑一遍：
// 目录的创建 / 搜索（大小写不敏感、通配符按字面）/ 晋升与替代链 / 编辑 OCC / 归档 / 删除 / WS；
// 可见性与管理权由中立 participant 在同一事务里回答；scope 迁移把两个 participant 与 OCC 收在一个事务里
// （含测试缝下的回滚）；融合 participant 的选中 / 定序 / provenance 与仓库 scope 的存在性。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { MemoryWsMessage } from '@agent-workflow/shared'

import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  cachedRepos,
  memories,
  memoryScopeMoveEvents,
  repoGroups,
  resourceGrants,
  users,
  workflows,
} from '@/db/schema'
import type {
  AuthenticatedPrincipal,
  CommandContext,
  DirectCommandContextFactory,
  RequestAuthority,
} from '@/modules/identity-access/public/participants'
import {
  composeMemoryCatalogOperations,
  composeSkillMemoryFusionParticipantFactory,
  type MemoryCatalogTestHooks,
} from '@/modules/memory/composition'
import type { MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import { composeResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'
import {
  createRepositoryScopeAuthorizationInTx,
  repositoryScopeExistenceReads,
} from '@/modules/source-control/public/participants'
import { MEMORY_CHANNEL, memoryBroadcaster, resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

function authorityOf(actor: Actor): MemoryScopeAuthority {
  return Object.freeze({ authority: {} as RequestAuthority, actor })
}

async function seedUser(
  db: ProviderNeutralDatabase,
  role: 'admin' | 'user' = 'user',
): Promise<string> {
  const id = `u_d4_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function seedAgent(db: ProviderNeutralDatabase, ownerUserId: string): Promise<string> {
  const id = `agt_d4_${ulid()}`
  await db.insert(agents).values({
    id,
    name: id,
    description: 'd4',
    outputs: '[]',
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    ownerUserId,
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function seedWorkflow(db: ProviderNeutralDatabase, ownerUserId: string): Promise<string> {
  const id = `wf_d4_${ulid()}`
  await db.insert(workflows).values({
    id,
    name: id,
    definition: '{"$schema_version":1,"nodes":[],"edges":[]}',
    ownerUserId,
    visibility: 'private',
  })
  return id
}

async function seedGrant(
  db: ProviderNeutralDatabase,
  resourceType: 'agent' | 'workflow',
  resourceId: string,
  userId: string,
  level: 'read' | 'write',
  addedBy: string,
): Promise<void> {
  await db
    .insert(resourceGrants)
    .values({ resourceType, resourceId, userId, level, addedBy, addedAt: NOW })
}

/** 测试用命令上下文工厂：只回答「这个上下文是谁铸的」，与 identity-access 夹具同形，两个引擎共用。 */
function commandContexts() {
  const principals = new WeakMap<object, AuthenticatedPrincipal>()
  let sequence = 0
  const contexts: DirectCommandContextFactory = {
    fromAuthority() {
      throw new Error('not used')
    },
    fromAuthorityWithIdempotency() {
      throw new Error('not used')
    },
    resolveCommandContext(context) {
      const principal = principals.get(context)
      if (principal === undefined) throw new Error('untrusted-operation-context')
      return principal
    },
  }
  const contextFor = (userId: string, source: 'session' | 'pat' = 'session'): CommandContext => {
    sequence += 1
    const context: CommandContext = {
      authority: {} as RequestAuthority,
      operationId: `op_d4_${sequence}_${ulid()}`,
      correlationId: `corr_d4_${sequence}`,
      now: NOW,
    }
    principals.set(context, { userId, source })
    return context
  }
  return { contexts, contextFor }
}

function captureBroadcasts(): { readonly messages: MemoryWsMessage[]; stop(): void } {
  const messages: MemoryWsMessage[] = []
  const stop = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (message) => {
    messages.push(message)
  })
  return { messages, stop }
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

async function rejectsWithCode(promise: Promise<unknown>, expected: string): Promise<void> {
  let observed: string | undefined
  try {
    await promise
  } catch (error) {
    observed = code(error)
  }
  expect(observed).toBe(expected)
}

describeEachProvider('RFC-359 W4-D4 —— memory 目录与 participants', (harness) => {
  const catalogOf = (testHooks?: MemoryCatalogTestHooks) => {
    const { contexts, contextFor } = commandContexts()
    const catalog = composeMemoryCatalogOperations({
      db: harness.db,
      contexts,
      authorization: composeResourceScopeAccessParticipant(),
      ...(testHooks === undefined ? {} : { testHooks }),
    })
    return { catalog, contextFor }
  }

  test('目录：创建 / 搜索 / 晋升与替代链 / 编辑 OCC / 归档 / 删除 / WS', async () => {
    resetBroadcastersForTests()
    const { catalog } = catalogOf()
    const capture = captureBroadcasts()
    const first = await catalog.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: 'Deploy Runbook',
      bodyMd: 'Body about MEMORY',
      tags: ['ops'],
    })
    const second = await catalog.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: 'other',
      bodyMd: '100% literal',
      tags: ['dev'],
    })
    expect(first.status).toBe('candidate')

    // 搜索：大小写不敏感（两个引擎一致）；通配符按字面而不是 LIKE 语义。
    expect((await catalog.queries.list({ search: 'runbook' })).map((row) => row.id)).toEqual([
      first.id,
    ])
    expect((await catalog.queries.list({ search: '100%' })).map((row) => row.id)).toEqual([
      second.id,
    ])
    expect(await catalog.queries.list({ search: '%' })).toHaveLength(1)
    expect((await catalog.queries.list({ tag: 'ops' })).map((row) => row.id)).toEqual([first.id])
    expect(
      (await catalog.queries.listWithBody({ status: 'candidate' })).map((row) => row.bodyMd).sort(),
    ).toEqual(['100% literal', 'Body about MEMORY'])

    // 晋升：approve 记管理员；approve_and_supersede 建替代链；reject 是终态。
    const approved = await catalog.commands.promote(first.id, { action: 'approve' }, 'admin-1')
    expect(approved).toMatchObject({ status: 'approved', version: 1, approvedByUserId: 'admin-1' })
    const successor = await catalog.commands.createManual({
      scopeType: 'global',
      scopeId: null,
      title: 'Deploy Runbook v2',
      bodyMd: 'newer',
      tags: ['ops'],
    })
    const promoted = await catalog.commands.promote(
      successor.id,
      { action: 'approve_and_supersede', supersedeIds: [first.id] },
      'admin-1',
    )
    expect(promoted).toMatchObject({ status: 'approved', version: 2, supersedesId: first.id })
    expect((await catalog.queries.getById(successor.id))?.ancestors.map((row) => row.id)).toEqual([
      first.id,
    ])
    expect((await catalog.queries.getById(first.id))?.memory).toMatchObject({
      status: 'superseded',
      supersededById: successor.id,
    })
    await rejectsWithCode(
      catalog.commands.promote(first.id, { action: 'approve' }, 'admin-1'),
      'memory-not-candidate',
    )
    const rejected = await catalog.commands.promote(second.id, { action: 'reject' }, 'admin-1')
    expect(rejected.status).toBe('rejected')
    await rejectsWithCode(
      catalog.commands.patch(second.id, { title: 'nope' }),
      'memory-terminal-status',
    )

    // 编辑：只在内容真变时升版本；scope 不走 PATCH；幂等重存不发 WS。
    const patched = await catalog.commands.patch(successor.id, { title: 'Deploy Runbook v3' })
    expect(patched.changedFields).toEqual(['title'])
    expect(patched.memory.version).toBe(3)
    const idempotent = await catalog.commands.patch(successor.id, { title: 'Deploy Runbook v3' })
    expect(idempotent.changedFields).toEqual([])
    expect(idempotent.memory.version).toBe(3)
    await rejectsWithCode(
      catalog.commands.patch(successor.id, { scopeType: 'agent' } as never),
      'memory-scope-move-required',
    )
    await rejectsWithCode(catalog.commands.patch('missing', { title: 'x' }), 'memory-not-found')

    // 归档 / 反归档 / 删除。
    expect((await catalog.commands.archive(successor.id)).status).toBe('archived')
    expect((await catalog.commands.unarchive(successor.id)).status).toBe('approved')
    await rejectsWithCode(catalog.commands.archive(first.id), 'memory-not-approved')
    await catalog.commands.delete(second.id)
    expect(await catalog.queries.getById(second.id)).toBeNull()
    await rejectsWithCode(catalog.commands.delete(second.id), 'memory-not-found')

    capture.stop()
    expect(new Set(capture.messages.map((message) => message.type))).toEqual(
      new Set([
        'memory.candidate.created',
        'memory.candidate.promoted',
        'memory.superseded',
        'memory.updated',
        'memory.archived',
        'memory.unarchived',
        'memory.deleted',
      ]),
    )
    expect(capture.messages.filter((message) => message.type === 'memory.updated')).toHaveLength(1)

    // 分页与全量逐条相同（三层过滤都在 application 共用一份）。
    for (let index = 0; index < 5; index += 1) {
      const row = await catalog.commands.createManual({
        scopeType: 'global',
        scopeId: null,
        title: `page ${index}`,
        bodyMd: 'p',
        tags: [],
      })
      await catalog.commands.promote(row.id, { action: 'approve' }, 'admin-1')
    }
    const admin = authorityOf(actorOf('u_admin_d4', 'admin'))
    const full = (await catalog.queries.list({ status: 'approved' })).map((row) => row.id)
    const paged: string[] = []
    let cursor: string | null = null
    do {
      const page = await catalog.queries.listPage(
        admin,
        { status: 'approved' },
        { cursor, limit: 2 },
        { includeCandidates: true },
      )
      paged.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(paged).toEqual(full)
  })

  test('可见性与管理权：resource-catalog 的中立 participant 在同一事务里回答', async () => {
    const db = harness.db
    const { catalog } = catalogOf()
    const owner = await seedUser(db)
    const stranger = await seedUser(db)
    const writer = await seedUser(db)
    const reader = await seedUser(db)
    const agentId = await seedAgent(db, owner)
    const workflowId = await seedWorkflow(db, owner)
    await seedGrant(db, 'agent', agentId, writer, 'write', owner)
    await seedGrant(db, 'agent', agentId, reader, 'read', owner)
    const agentScope = { scopeType: 'agent' as const, scopeId: agentId }
    const workflowScope = { scopeType: 'workflow' as const, scopeId: workflowId }
    const globalScope = { scopeType: 'global' as const, scopeId: null }
    const admin = authorityOf(actorOf('u_admin_d4', 'admin'))
    const of = (id: string) => authorityOf(actorOf(id))

    expect(await catalog.queries.canView(of(owner), agentScope)).toBe(true)
    expect(await catalog.queries.canView(of(writer), agentScope)).toBe(true)
    expect(await catalog.queries.canView(of(reader), agentScope)).toBe(true)
    expect(await catalog.queries.canView(of(stranger), agentScope)).toBe(false)
    expect(await catalog.queries.canView(admin, agentScope)).toBe(true)
    expect(await catalog.queries.canView(of(stranger), globalScope)).toBe(true)

    expect(await catalog.queries.canManage(of(owner), agentScope)).toBe(true)
    expect(await catalog.queries.canManage(of(writer), agentScope)).toBe(true)
    expect(await catalog.queries.canManage(of(reader), agentScope)).toBe(false)
    expect(await catalog.queries.canManage(of(stranger), agentScope)).toBe(false)
    expect(await catalog.queries.canManage(of(owner), workflowScope)).toBe(true)
    expect(await catalog.queries.canManage(of(stranger), workflowScope)).toBe(false)
    expect(await catalog.queries.canManage(of(owner), globalScope)).toBe(false)
    expect(await catalog.queries.canManage(admin, globalScope)).toBe(true)

    const rows = [agentScope, globalScope, workflowScope]
    expect(await catalog.queries.filterVisible(of(stranger), rows)).toEqual([globalScope])
    expect(await catalog.queries.filterVisible(of(reader), rows)).toEqual([agentScope, globalScope])
    expect(await catalog.queries.filterVisible(admin, rows)).toEqual(rows)
    expect(
      (await catalog.queries.annotateManageRights(of(writer), rows)).map((row) => row.canManage),
    ).toEqual([true, false, false])
    expect(
      (await catalog.queries.annotateManageRights(admin, rows)).map((row) => row.canManage),
    ).toEqual([true, true, true])
  })

  test('scope 迁移：两个 participant 与 OCC 收在一个事务里，测试缝下的写入回滚', async () => {
    resetBroadcastersForTests()
    const db = harness.db
    const owner = await seedUser(db)
    const stranger = await seedUser(db)
    const reader = await seedUser(db)
    const admin = await seedUser(db, 'admin')
    const agentId = await seedAgent(db, owner)
    const workflowId = await seedWorkflow(db, owner)
    await seedGrant(db, 'agent', agentId, reader, 'read', owner)
    const repoId = `repo_d4_${ulid()}`
    await db.insert(cachedRepos).values({
      id: repoId,
      urlHash: repoId,
      localPath: `/tmp/${repoId}`,
      lastFetchedAt: NOW,
      createdAt: NOW,
    })
    const { catalog, contextFor } = catalogOf()
    const candidate = () =>
      catalog.commands.createManual({
        scopeType: 'agent',
        scopeId: agentId,
        title: 'move me',
        bodyMd: 'body',
        tags: [],
      })

    // owner：agent → 自己的 workflow，scope + 版本 + 持久事件原子落地，之后才发 WS。
    const moved = await candidate()
    const capture = captureBroadcasts()
    const context = contextFor(owner)
    const result = await catalog.commands.move(context, moved.id, {
      expectedVersion: moved.version,
      scopeType: 'workflow',
      scopeId: workflowId,
    })
    capture.stop()
    expect(result).toMatchObject({
      moved: true,
      memory: { scopeType: 'workflow', scopeId: workflowId, version: moved.version + 1 },
    })
    const events = await db
      .select()
      .from(memoryScopeMoveEvents)
      .where(eq(memoryScopeMoveEvents.memoryId, moved.id))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: context.operationId,
      actorUserId: owner,
      fromScopeType: 'agent',
      fromScopeId: agentId,
      toScopeType: 'workflow',
      toScopeId: workflowId,
      expectedVersion: moved.version,
      resultingVersion: moved.version + 1,
    })
    expect(capture.messages).toEqual([
      {
        type: 'memory.updated',
        memoryId: moved.id,
        changedFields: ['scopeType', 'scopeId'],
        version: moved.version + 1,
      },
    ])
    // 同 scope 重放：不动版本、不发事件。
    const same = await catalog.commands.move(contextFor(owner), moved.id, {
      expectedVersion: moved.version + 1,
      scopeType: 'workflow',
      scopeId: workflowId,
    })
    expect(same).toMatchObject({ moved: false, memory: { version: moved.version + 1 } })

    // 授权：看不见当前 scope 的人得到 not-found；只读授权得到 forbidden；repo scope 只认 bypass。
    const guarded = await candidate()
    await rejectsWithCode(
      catalog.commands.move(contextFor(stranger), guarded.id, {
        expectedVersion: guarded.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
      'memory-scope-target-not-found',
    )
    await rejectsWithCode(
      catalog.commands.move(contextFor(reader), guarded.id, {
        expectedVersion: guarded.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
      'memory-scope-forbidden',
    )
    await rejectsWithCode(
      catalog.commands.move(contextFor(owner), guarded.id, {
        expectedVersion: guarded.version,
        scopeType: 'repo',
        scopeId: repoId,
      }),
      'memory-scope-forbidden',
    )
    await rejectsWithCode(
      catalog.commands.move(contextFor(admin), guarded.id, {
        expectedVersion: guarded.version,
        scopeType: 'repo',
        scopeId: 'repo-does-not-exist',
      }),
      'memory-scope-target-not-found',
    )
    const toRepo = await catalog.commands.move(contextFor(admin), guarded.id, {
      expectedVersion: guarded.version,
      scopeType: 'repo',
      scopeId: repoId,
    })
    expect(toRepo).toMatchObject({ moved: true, memory: { scopeType: 'repo', scopeId: repoId } })

    // OCC 与状态门。
    const stale = await candidate()
    await rejectsWithCode(
      catalog.commands.move(contextFor(owner), stale.id, {
        expectedVersion: stale.version + 7,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
      'resource-operation-stale',
    )
    await catalog.commands.promote(stale.id, { action: 'approve' }, admin)
    await rejectsWithCode(
      catalog.commands.move(contextFor(owner), stale.id, {
        expectedVersion: stale.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
      'memory-move-status-forbidden',
    )
    await expect(
      catalog.commands.move(
        { authority: {} as RequestAuthority, operationId: 'forged', correlationId: 'x', now: NOW },
        stale.id,
        { expectedVersion: stale.version, scopeType: 'global', scopeId: null },
      ),
    ).rejects.toThrow('untrusted-operation-context')

    // 测试缝：授权判定之后目标被删——二次判定抛 not-found，整个事务回滚（目标行、记忆行、事件、WS 都不变）。
    const raced = await candidate()
    const faulted = catalogOf({
      afterMoveAuthorizationInTransaction: async (tx) => {
        await tx.delete(workflows).where(eq(workflows.id, workflowId))
      },
    })
    const racedCapture = captureBroadcasts()
    await rejectsWithCode(
      faulted.catalog.commands.move(faulted.contextFor(owner), raced.id, {
        expectedVersion: raced.version,
        scopeType: 'workflow',
        scopeId: workflowId,
      }),
      'memory-scope-target-not-found',
    )
    racedCapture.stop()
    expect(await db.select().from(workflows).where(eq(workflows.id, workflowId))).toHaveLength(1)
    expect((await catalog.queries.getById(raced.id))?.memory).toMatchObject({
      scopeType: 'agent',
      scopeId: agentId,
      version: raced.version,
    })
    expect(
      await db
        .select()
        .from(memoryScopeMoveEvents)
        .where(eq(memoryScopeMoveEvents.memoryId, raced.id)),
    ).toHaveLength(0)
    expect(racedCapture.messages).toEqual([])
  })

  test('融合 participant 与仓库 scope 读取器', async () => {
    const db = harness.db
    const { catalog } = catalogOf()
    const make = async (title: string) => {
      const row = await catalog.commands.createManual({
        scopeType: 'global',
        scopeId: null,
        title,
        bodyMd: 'b',
        tags: [],
      })
      await catalog.commands.promote(row.id, { action: 'approve' }, 'admin-1')
      return row.id
    }
    const third = await make('c')
    const second = await make('b')
    const first = await make('a')
    await catalog.commands.archive(third)
    const fusion = composeSkillMemoryFusionParticipantFactory()
    const fused = await harness.session.transaction(
      async (tx) =>
        await fusion.inTransaction(tx).markFused({
          memoryIds: [third, second, first],
          skillId: 'skl_d4',
          skillName: 'skill-d4',
          skillVersion: 2,
          fusionId: 'fus_d4',
          actorUserId: 'u_fuser',
          now: NOW,
        }),
    )
    expect(fused).toEqual([first, second].sort())
    expect((await db.select().from(memories).where(eq(memories.id, first)))[0]).toMatchObject({
      status: 'fused',
      fusedIntoSkillId: 'skl_d4',
      fusedIntoSkill: 'skill-d4',
      fusedIntoSkillVersion: 2,
      fusedFusionId: 'fus_d4',
      fusedByUserId: 'u_fuser',
    })
    expect((await catalog.queries.listFusedInto('skl_d4')).map((row) => row.id)).toEqual(
      [first, second].sort(),
    )
    const unfused = await harness.session.transaction(
      async (tx) =>
        await fusion.inTransaction(tx).unfuseAboveVersion({ skillId: 'skl_d4', aboveVersion: 1 }),
    )
    expect(unfused).toEqual([first, second].sort())
    expect((await db.select().from(memories).where(eq(memories.id, second)))[0]).toMatchObject({
      status: 'approved',
      fusedIntoSkillId: null,
      fusedIntoSkillVersion: null,
    })
    expect(await catalog.queries.listFusedInto('skl_d4')).toEqual([])

    const repoId = `repo_d4_${ulid()}`
    const groupId = `grp_d4_${ulid()}`
    await db.insert(cachedRepos).values({
      id: repoId,
      urlHash: repoId,
      localPath: `/tmp/${repoId}`,
      lastFetchedAt: NOW,
      createdAt: NOW,
    })
    await db
      .insert(repoGroups)
      .values({ id: groupId, name: groupId, createdAt: NOW, updatedAt: NOW })
    const repositories = createRepositoryScopeAuthorizationInTx(repositoryScopeExistenceReads)
    const facts = await harness.session.transaction(async (tx) => ({
      repo: await repositories.exists(tx, { kind: 'repo', id: repoId }),
      missingRepo: await repositories.exists(tx, { kind: 'repo', id: 'nope' }),
      group: await repositories.exists(tx, { kind: 'repo_group', id: groupId }),
      missingGroup: await repositories.exists(tx, { kind: 'repo_group', id: 'nope' }),
      bypass: await repositories.canManage(
        tx,
        { hasResourceAclBypass: true },
        { kind: 'repo', id: repoId },
      ),
      plain: await repositories.canManage(
        tx,
        { hasResourceAclBypass: false },
        { kind: 'repo', id: repoId },
      ),
    }))
    expect(facts).toEqual({
      repo: true,
      missingRepo: false,
      group: true,
      missingGroup: false,
      bypass: true,
      plain: false,
    })
  })
})
