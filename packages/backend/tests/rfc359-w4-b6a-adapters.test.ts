// RFC-359 W4-B6 批 a —— source-control / event-center 四对适配器合一，两个引擎各跑一遍：工作区维护存储、仓库工作区存储
// （仓库组图版本核对走统一事务 + 能力矩阵 advisory lock，聚合索引提示与凭据擦除后的存储回收走能力矩阵）、
// 事件响应规则存储、自定义事件源存储（发布事务末尾的 CAS）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  memories,
  repoGroupNodes,
  scheduledTasks,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { createCustomEventSourceStore } from '@/modules/event-center/infrastructure/customEventSourceStore'
import { createEventResponseRuleStore } from '@/modules/event-center/infrastructure/eventResponseRuleStore'
import type { CustomEventSourceDraft } from '@/modules/event-center/domain/customEventSource'
import type {
  EventSourceDescriptor,
  EventTypeDescriptor,
} from '@/modules/event-center/domain/model'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { DrizzleWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/workspaceMaintenanceStore'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b6a_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

async function seedCachedRepo(db: ProviderNeutralDatabase): Promise<string> {
  const id = `cr_${ulid()}`
  await db.insert(cachedRepos).values({
    id,
    urlHash: `h_${id}`,
    urlRedacted: `https://example.invalid/${id}.git`,
    urlEnc: null,
    localPath: `/tmp/mirror/${id}`,
    lastFetchedAt: 1,
    createdAt: 1,
  })
  return id
}

async function seedTask(
  db: ProviderNeutralDatabase,
  owner: string,
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ownerUserId: owner,
    ...extra,
  })
  return id
}

function group(name: string) {
  return {
    id: `rg_${ulid()}`,
    name,
    description: '',
    version: 1,
    createdByUserId: null,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 2,
  }
}

function node(
  groupId: string,
  path: string,
  cachedRepoId: string | null,
  childGroupId: string | null,
) {
  return {
    groupId,
    path,
    attachmentKind:
      cachedRepoId !== null ? ('repo' as const) : childGroupId !== null ? ('group' as const) : null,
    cachedRepoId,
    // SQLite 的 CHECK：group 挂载不得带 ref / subdir。
    ref: cachedRepoId !== null ? 'main' : '',
    subdir: '',
    childGroupId,
    readonly: false,
  }
}

describeEachProvider('RFC-359 W4-B6a —— 工作区维护与仓库工作区存储', (harness) => {
  test('GC 候选 / iso 认领释放；仓库组建 / 改 / 删的版本核对；缓存仓删除与凭据封存变更；存储回收', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const terminal = await seedTask(db, owner, {
      status: 'done',
      spaceKind: 'remote',
      finishedAt: 2,
      workspacePruningAt: 200,
    })
    const maintenance = new DrizzleWorkspaceMaintenanceStore(db)
    expect((await maintenance.listGcCandidates()).map((row) => row.id)).toContain(terminal)
    expect(await maintenance.releaseIsoClaim(terminal, 100)).toBe(false)
    expect(await maintenance.releaseIsoClaim(terminal, 200)).toBe(true)
    expect((await maintenance.listTasks([terminal]))[0]?.workspacePruningAt).toBeNull()

    const store = new DrizzleRepositoryWorkspaceStore(db)
    const repoA = await seedCachedRepo(db)
    const repoB = await seedCachedRepo(db)
    const a = group(`alpha-${ulid().toLowerCase()}`)
    expect(await store.createRepositoryGroup(a, [node(a.id, 'a', repoA, null)])).toBe('created')
    expect(
      await store.createRepositoryGroup(group(a.name.toUpperCase()), [
        node(a.id, 'a', repoA, null),
      ]),
    ).toBe('name-conflict')
    const b = group(`beta-${ulid().toLowerCase()}`)
    expect(
      await store.createRepositoryGroup(b, [
        node(b.id, 'b', repoB, null),
        node(b.id, 'child', null, a.id),
      ]),
    ).toBe('created')

    // 页查询会走聚合面板（count/sum + 索引提示）：两个引擎都要能跑。
    const page = await store.listCachedRepoPage({ limit: 10 })
    expect(page.rows.map((row) => row.id).sort()).toEqual([repoA, repoB].sort())
    expect(page.facets.all).toBe(2)

    const graph = () => [
      { id: a.id, version: 1 },
      { id: b.id, version: 1 },
    ]
    const updateInput = {
      id: a.id,
      name: a.name,
      description: 'renamed',
      updatedAt: 5,
      nodes: [node(a.id, 'a2', repoB, null)],
    }
    expect(
      await store.updateRepositoryGroup({
        ...updateInput,
        expectedGraphVersions: [{ id: a.id, version: 9 }],
      }),
    ).toEqual({ status: 'graph-stale' })
    expect(
      await store.updateRepositoryGroup({
        ...updateInput,
        id: 'missing',
        expectedGraphVersions: graph(),
      }),
    ).toEqual({ status: 'missing' })
    expect(
      await store.updateRepositoryGroup({
        ...updateInput,
        expectedVersion: 3,
        expectedGraphVersions: graph(),
      }),
    ).toEqual({ status: 'stale', actualVersion: 1 })
    expect(
      await store.updateRepositoryGroup({
        ...updateInput,
        name: b.name.toUpperCase(),
        expectedGraphVersions: graph(),
      }),
    ).toEqual({ status: 'name-conflict' })
    expect(
      await store.updateRepositoryGroup({
        ...updateInput,
        expectedVersion: 1,
        expectedGraphVersions: graph(),
      }),
    ).toEqual({ status: 'ok', version: 2 })
    const snapshot = await store.readRepositoryGroupSnapshot()
    expect(snapshot.groups.find((row) => row.id === a.id)).toMatchObject({
      description: 'renamed',
      version: 2,
    })
    expect(snapshot.nodes.filter((row) => row.groupId === a.id).map((row) => row.path)).toEqual([
      'a2',
    ])

    // 删除缓存仓：引用它的节点被摘掉，仓库行消失。
    await store.deleteCachedRepoAndDetachGroups(repoB)
    const detached = (
      await db.select().from(repoGroupNodes).where(eq(repoGroupNodes.groupId, a.id))
    )[0]
    expect(detached).toMatchObject({ attachmentKind: null, cachedRepoId: null })
    expect(await store.findCachedRepoById(repoB)).toBeNull()

    // 凭据封存变更在一笔事务里落到缓存仓与定时任务。
    const scheduleId = `sched_${ulid()}`
    await db.insert(scheduledTasks).values({
      id: scheduleId,
      name: 'nightly',
      ownerUserId: owner,
      launchKind: 'workflow',
      launchPayload: JSON.stringify({ workflowId: 'wf', name: 'n', inputs: {} }),
      scheduleSpec: JSON.stringify({ kind: 'cron', expression: '0 0 * * *', timezone: 'UTC' }),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.applyCredentialSealingMutation({
      cachedRepoUpdates: [{ id: repoA, patch: { urlEnc: 'sealed' } }],
      taskRepoUpdates: [],
      taskUpdates: [],
      scheduleUpdates: [{ id: scheduleId, launchPayload: '{"sealed":true}' }],
    })
    expect((await db.select().from(cachedRepos).where(eq(cachedRepos.id, repoA)))[0]?.urlEnc).toBe(
      'sealed',
    )
    expect(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)))[0]
        ?.launchPayload,
    ).toBe('{"sealed":true}')
    await store.compactAfterCredentialScrub()

    // 删组：归档 repo_group 记忆、摘掉子组引用、停用定时任务。
    const memoryId = `m_${ulid()}`
    await db.insert(memories).values({
      id: memoryId,
      scopeType: 'repo_group',
      scopeId: a.id,
      title: 'group memory',
      bodyMd: 'body',
      tags: '[]',
      status: 'approved',
      sourceKind: 'manual',
      sourceEventId: null,
      sourceTaskId: null,
      distillJobId: null,
      distillAction: null,
      supersedesId: null,
      supersededById: null,
      createdAt: 1,
    })
    expect(
      await store.deleteRepositoryGroup({
        id: a.id,
        scheduleIds: [scheduleId],
        expectedGraphVersions: [{ id: a.id, version: 1 }],
      }),
    ).toEqual({ status: 'graph-stale' })
    expect(
      await store.deleteRepositoryGroup({
        id: a.id,
        scheduleIds: [scheduleId],
        expectedGraphVersions: [
          { id: a.id, version: 2 },
          { id: b.id, version: 1 },
        ],
      }),
    ).toEqual({ status: 'ok', archivedMemories: 1, detachedReferences: 1, disabledSchedules: 1 })
    expect((await db.select().from(memories).where(eq(memories.id, memoryId)))[0]?.status).toBe(
      'archived',
    )
    expect(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)))[0],
    ).toMatchObject({ enabled: false, nextRunAt: null })
    const after = await store.readRepositoryGroupSnapshot()
    expect(after.groups.some((row) => row.id === a.id)).toBe(false)
    expect(after.nodes.find((row) => row.groupId === b.id && row.path === 'child')).toMatchObject({
      attachmentKind: null,
      childGroupId: null,
    })
  })
})

describeEachProvider('RFC-359 W4-B6a —— 事件响应规则存储', (harness) => {
  test('建 / 读 / 列 / 匹配 / 单调修订更新 / 结果记录 / 删', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const rules = createEventResponseRuleStore(db)
    const id = `rule_${ulid()}`
    const draft = {
      name: 'on push',
      enabled: true,
      eventTypeRef: { id: 'ev.push', revision: 1 },
      subjectMatch: 'prefix' as const,
      subjectPattern: 'repo:',
      target: { kind: 'workflow' as const, refId: 'wf_1', nameTemplate: 'run', inputs: {} },
    }
    const base = {
      id,
      ownerUserId: owner,
      sourceRef: { id: 'src.a', revision: 1 },
      subjectTypeId: 'repo',
      now: 10,
    }
    const created = await rules.create({ ...base, draft })
    expect(created).toMatchObject({ id, name: 'on push', subjectPattern: 'repo:', updatedAt: 10 })
    expect((await rules.get(id))?.target).toEqual(draft.target)
    expect(await rules.get('missing')).toBeNull()
    expect((await rules.list()).map((row) => row.id)).toContain(id)
    const observation = (subjectRef: string) =>
      ({
        sourceRef: { id: 'src.a', revision: 1 },
        eventTypeRef: { id: 'ev.push', revision: 1 },
        subject: { typeId: 'repo', subjectRef },
        summary: 'pushed',
        occurredAt: 1,
        dedupeKey: `k-${subjectRef}`,
        payloadArtifactRef: null,
        triggerParameters: null,
        routingFacts: {},
      }) as unknown as Parameters<typeof rules.matching>[0]
    expect((await rules.matching(observation('repo:x'))).map((row) => row.id)).toEqual([id])
    expect(await rules.matching(observation('other:x'))).toEqual([])
    // 同一毫秒内的两次编辑：修订必须单调递增。
    const updated = await rules.update({ ...base, now: 10, draft: { ...draft, name: 'renamed' } })
    expect(updated).toMatchObject({ name: 'renamed', updatedAt: 11 })
    expect(await rules.update({ ...base, id: 'missing', draft })).toBeNull()
    await rules.recordResult({ id, now: 12, state: 'launched', error: null })
    expect(await rules.get(id)).toMatchObject({
      lastFiredAt: 12,
      lastStatus: 'launched',
      lastError: null,
    })
    expect(await rules.remove(id)).toBe(true)
    expect(await rules.remove(id)).toBe(false)
  })
})

describeEachProvider('RFC-359 W4-B6a —— 自定义事件源存储', (harness) => {
  test('建 / 改草稿 / 发布（修订冲突与 CAS）/ 已发布读取 / 订阅准入 / 退役', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const sources = createCustomEventSourceStore(db)
    const draft: CustomEventSourceDraft = {
      schemaVersion: 1,
      displayName: { 'zh-CN': '自定义源', 'en-US': 'Custom source' },
      description: { 'zh-CN': '测试用', 'en-US': 'for tests' },
      pollIntervalMs: 60_000,
      batchSize: 10,
      ingestionMode: 'occurrence',
      program: { language: 'bash', source: 'echo hi', timeoutMs: 5_000 },
      eventTypes: [
        {
          eventKey: 'ping',
          subjectTypeId: 'repo',
          payloadSchemaId: 'ping.v1',
          displayName: { 'zh-CN': 'ping', 'en-US': 'ping' },
          description: { 'zh-CN': 'ping 事件', 'en-US': 'ping event' },
          deliveryClass: 'ordinary',
          triggerParameters: null,
        },
      ],
      fixture: { subjects: [], cursorJson: null },
    }
    const id = `src_${ulid().toLowerCase()}`
    const created = await sources.create({ id, draft, ownerUserId: owner, now: 1 })
    expect(created).toMatchObject({
      id,
      publishedRevision: null,
      publishedDigest: null,
      retiredAt: null,
    })
    expect((await sources.get(id))?.draft.batchSize).toBe(10)
    expect(await sources.get('missing')).toBeNull()
    expect((await sources.list()).map((row) => row.id)).toContain(id)
    const edited = { ...draft, batchSize: 20 }
    expect((await sources.update({ id, draft: edited, now: 2 }))?.draft.batchSize).toBe(20)
    expect(await sources.update({ id: 'missing', draft: edited, now: 2 })).toBeNull()

    const receipt = {
      schemaVersion: 1 as const,
      draftDigest: 'd1',
      validatedAt: 3,
      observationCount: 1,
      stdoutDigest: 's1',
    }
    const source = {
      schemaVersion: 1,
      sourceRef: { id, revision: 1 },
      ownerTypeId: 'custom',
      displayName: draft.displayName,
      description: draft.description,
      observationMode: 'active',
      observerProgramRef: null,
    } as unknown as EventSourceDescriptor
    const eventType = {
      eventTypeRef: { id: `${id}.ping`, revision: 1 },
      sourceRef: { id, revision: 1 },
    } as unknown as EventTypeDescriptor
    // 草稿在验证后又被改过 ⇒ 拒绝发布。
    await expect(
      sources.publish({
        id,
        revision: 1,
        draft,
        digest: 'd1',
        validationReceipt: receipt,
        source,
        eventTypes: [eventType],
        actorUserId: owner,
        now: 4,
      }),
    ).rejects.toThrow('draft changed during validation')
    const published = await sources.publish({
      id,
      revision: 1,
      draft: edited,
      digest: 'd1',
      validationReceipt: receipt,
      source,
      eventTypes: [eventType],
      actorUserId: owner,
      now: 4,
    })
    expect(published.sourceRef).toEqual({ id, revision: 1 })
    expect(await sources.get(id)).toMatchObject({ publishedRevision: 1, publishedDigest: 'd1' })
    await expect(
      sources.publish({
        id,
        revision: 1,
        draft: edited,
        digest: 'd2',
        validationReceipt: receipt,
        source,
        eventTypes: [],
        actorUserId: owner,
        now: 5,
      }),
    ).rejects.toThrow('publish revision conflict')
    expect((await sources.getPublished({ id, revision: 1 }))?.contentDigest).toBe('d1')
    expect(await sources.getPublished({ id, revision: 2 })).toBeNull()
    expect(await sources.acceptsNewSubscriptions({ id, revision: 1 })).toBe(true)
    expect(await sources.acceptsNewSubscriptions({ id, revision: 2 })).toBe(false)
    expect(await sources.acceptsNewSubscriptions({ id: 'unknown-source', revision: 1 })).toBe(true)
    expect(await sources.retire(id, 6)).toBe(true)
    expect(await sources.retire(id, 7)).toBe(false)
    expect(await sources.acceptsNewSubscriptions({ id, revision: 1 })).toBe(false)
    expect(await sources.update({ id, draft: edited, now: 8 })).toBeNull()
    await expect(
      sources.publish({
        id,
        revision: 2,
        draft: edited,
        digest: 'd3',
        validationReceipt: receipt,
        source,
        eventTypes: [],
        actorUserId: owner,
        now: 9,
      }),
    ).rejects.toThrow('custom event source is unavailable')
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const modules = resolve(import.meta.dir, '..', 'src', 'modules')
  for (const [context, stem] of [
    ['source-control', 'WorkspaceMaintenanceStore'],
    ['source-control', 'RepositoryWorkspaceStore'],
    ['event-center', 'EventResponseRuleStore'],
    ['event-center', 'CustomEventSourceStore'],
  ] as const) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(modules, context, 'infrastructure', `${provider}${stem}.ts`))).toBe(
        false,
      )
    }
  }
})
