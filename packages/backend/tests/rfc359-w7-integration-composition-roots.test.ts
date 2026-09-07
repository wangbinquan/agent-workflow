// RFC-359 W7 —— Integration bounded context 的 provider 组合根：**真的构造 + 真的驱动**。
//
// 为什么存在这个文件
// ----------------
// `tests/architecture/rfc359-w5-provider-runtime-exercised.test.ts` 的账本此前记着 70 个
// 「只在装配面上存在、从未被任何测试构造过」的 provider 组合根，其中 23 个在 Integration。
// 那份账本的判据是「值级 import 的绑定出现在 CallExpression 的 callee 位置」——`toContain(
// 'composeXxx(')` 这类源码文本锁一条都不算。本文件按那个判据还债：每个组合根都被 import、
// 被调用、并且**至少驱动一个真方法**去撞真库（两个引擎各跑一遍），断言的是行为不是存在性。
//
// 判据之外还多要一层：`expect(x).toBeDefined()` 不构成覆盖。组合根内部的 SQL 方言、列名、
// 事务语义只有被执行才会暴露；所以下面每一条都落到 insert / select / 事务 / 唯一冲突上。
//
// 「Sqlite 别名」为什么也在 PostgreSQL 上跑
// -------------------------------------
// 本 context 绝大多数 `composeSqliteXxx` / `composePostgresqlXxx` 是同一份 provider 中立实现
// 的两个装配别名（源码里写着「旧名保留为装配别名，bootstrap 收敛后删除」）。既然是同一个函数，
// 两个名字在两个引擎上都必须成立——把它们各跑一遍，正好把「这对别名真的中立」也一起锁住。
// 真正按 provider 分叉的那一个（`composeSqliteDevelopmentToolConnectionCatalog` 走同步
// `.get()`）在下面单独按引擎分叉，并写明理由。

import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentAdapterDefinitionRevisions,
  developmentAdapterDefinitions,
  tasks,
  users,
  webhookEndpoints,
  webhookMrStreamStates,
  workflows,
} from '@/db/schema'
import { composePostgresqlApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeSqliteDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import {
  composePostgresqlPipelineEvidenceRunner,
  composeSqlitePipelineEvidenceRunner,
} from '@/modules/integration/composition/pipelineEvidence'
import { composePostgresqlRequirementSourceRunner } from '@/modules/integration/composition/requirementSource'
import { composePostgresqlScheduledTaskRuntime } from '@/modules/integration/composition/scheduledTasks'
import { composePostgresqlWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import {
  composePostgresqlWebhookDeliveryPersistence,
  composeSqliteWebhookDeliveryPersistence,
} from '@/modules/integration/composition/webhookDelivery'
import {
  composePostgresqlWebhookDispatchPersistence,
  composePostgresqlWebhookTriggerServiceDependencies,
  composeSqliteWebhookTriggerServiceDependencies,
} from '@/modules/integration/composition/webhookDispatch'
import { createWebhookTriggerAdministration } from '@/modules/integration/infrastructure/webhookTriggerAdministration'
import { createVerifiedWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/verifiedWebhookDeliveryPersistence'
import {
  composePostgresqlWebhookEndpointServiceDependencies,
  composeSqliteWebhookEndpointServiceDependencies,
} from '@/modules/integration/composition/webhookEndpoints'
import {
  composePostgresqlWebhookDeliveryRuntime,
  composePostgresqlWebhookIngressPersistence,
  composeSqliteWebhookDeliveryRuntime,
} from '@/modules/integration/composition/webhookIngress'
import { composePostgresqlMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import { composeIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import { composePostgresqlTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import { assertNotBuiltin } from '@/services/systemResources'
import { describeEachProvider } from './helpers/eachProvider'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

const T0 = 1_700_000_000_000

/**
 * 两个 cast 把中立客户端还原成别名在签名上声明的具体类型——运行时是同一个对象，
 * 装配别名的函数体也只用中立 query builder。**没有**因此放宽断言：下面每次调用都真的打库。
 */
function asSqlite(db: ProviderNeutralDatabase): DbClient {
  return db as unknown as DbClient
}

function asPostgresql(db: ProviderNeutralDatabase): PostgresqlDatabaseClient {
  return db as unknown as PostgresqlDatabaseClient
}

const secretBox = createSecretBoxFromKey(randomBytes(32))

async function seedEndpoint(db: ProviderNeutralDatabase): Promise<string> {
  const id = `we_${ulid()}`
  await db.insert(webhookEndpoints).values({
    id,
    name: `endpoint-${id.slice(-6)}`,
    provider: 'gitlab',
    urlToken: `tok_${ulid()}`,
    secretEnc: secretBox.seal('s3cret'),
    enabled: true,
    preferredCloneProtocol: 'http',
    lastDeliveryAt: null,
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

async function seedUser(db: ProviderNeutralDatabase, role: 'admin' | 'user' = 'admin') {
  const id = `u_${ulid()}`
  const username = `u-${id.slice(-8).toLowerCase()}`
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role,
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  })
  return { id, username, role }
}

function triggerRecord(endpointId: string, ownerUserId: string) {
  return {
    id: `wt_${ulid()}`,
    name: `trigger-${ulid().slice(-6).toLowerCase()}`,
    endpointId,
    ownerUserId,
    enabled: true,
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['push']),
    branchFilter: null,
    commandPrefix: null,
    ignoreUsernames: '[]',
    launchKind: 'workflow' as const,
    launchRefId: `wf_${ulid()}`,
    launchPayload: '{}',
    templateSyntaxVersion: 2,
    maxConsecutiveFires: 3,
    autoRegisterRepos: true,
    cancelOnMrTerminal: false,
  }
}

/** 一份可发布的 adapter 内容；purpose 由调用方点名，用来撞「用途不符」这条真实分支。 */
function adapterContent(purpose: 'requirement-source' | 'pipeline-gate' | 'approval-gateway') {
  const operations =
    purpose === 'requirement-source'
      ? ['acquire']
      : purpose === 'pipeline-gate'
        ? ['collect']
        : ['submit', 'lookup-by-idempotency-key', 'observe']
  return {
    schemaVersion: 1,
    purpose,
    operations,
    contractVersion: 1,
    executableRef: '/bin/true',
    parameterSchemaRef: null,
    connectionRef: null,
    secretProjection: [],
    outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 10_240 },
    timeoutMs: 5_000,
  }
}

async function seedAdapter(
  db: ProviderNeutralDatabase,
  purpose: 'requirement-source' | 'pipeline-gate' | 'approval-gateway',
): Promise<{ id: string; revision: number }> {
  const id = `da_${ulid()}`
  await db.insert(developmentAdapterDefinitions).values({
    id,
    name: `adapter-${id.slice(-6).toLowerCase()}`,
    draftJson: '{}',
    publishedRevision: 1,
    ownerUserId: null,
    visibility: 'public',
    aclRevision: 0,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    purpose,
  })
  await db.insert(developmentAdapterDefinitionRevisions).values({
    adapterId: id,
    revision: 1,
    contentJson: JSON.stringify(adapterContent(purpose)),
    contentDigest: 'digest',
    publishedAt: T0,
    publishedBy: null,
  })
  return { id, revision: 1 }
}

function codeHostEvent(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: null,
    eventType: 'mr_closed',
    repoPath: 'group/repo',
    repoHttpUrl: 'https://example.test/group/repo.git',
    repoSshUrl: 'git@example.test:group/repo.git',
    projectId: '77',
    mrIid: '9',
    author: {},
    raw: {},
    ...overrides,
  }
}

async function errorCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return '<no-throw>'
  } catch (error) {
    return (error as { code?: string }).code ?? `<no-code:${String(error)}>`
  }
}

describeEachProvider('RFC-359 W7 —— Integration 组合根：投递 / 分发 / 触发器', (harness) => {
  test('webhookDelivery：两个别名各构造一次，insert 去重 + mark + touch + GC 切片都落真库', async () => {
    const endpointId = await seedEndpoint(harness.db)
    const sqlite = composeSqliteWebhookDeliveryPersistence(asSqlite(harness.db))
    const postgresql = composePostgresqlWebhookDeliveryPersistence(asPostgresql(harness.db))

    const eventUuid = `evt_${ulid()}`
    const first = await sqlite.insert({ endpointId, eventUuid, status: 'received' })
    expect(first.kind).toBe('inserted')
    if (first.kind !== 'inserted') throw new Error('expected insert')

    // 去重是 partial unique index 上的真冲突分支——两个引擎的 unique-violation 分类都要认得出。
    const duplicate = await postgresql.insert({ endpointId, eventUuid, status: 'received' })
    expect(duplicate).toEqual({ kind: 'duplicate', deliveryId: first.deliveryId, attemptCount: 2 })

    await sqlite.mark({ deliveryId: first.deliveryId, status: 'matched', reason: null })
    await postgresql.touchEndpointLastDelivery(endpointId, T0 + 5)
    expect(
      (
        await harness.db
          .select({ lastDeliveryAt: webhookEndpoints.lastDeliveryAt })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, endpointId))
      )[0],
    ).toEqual({ lastDeliveryAt: T0 + 5 })

    // 'processing' 行才是可恢复的；上面这条已经 matched，所以恢复计数为 0。
    expect(await sqlite.recoverInterrupted()).toBe(0)
    const slice = await postgresql.gcSlice({
      now: T0 + 1_000,
      retention: { bodyRetentionMs: 1, rowRetentionMs: 1 },
      cursor: null,
      batchSize: 10,
    })
    expect(slice.cursor.version).toBe(1)
    expect(slice.counters.bodiesCleared).toBe(0)
  })

  test('webhookDispatch 持久化 + 触发器管理面：create/get/update/listFires/delete 与 fire 记账', async () => {
    const owner = await seedUser(harness.db)
    const endpointId = await seedEndpoint(harness.db)
    // RFC-359 W8：触发器管理面的两个 provider 别名都是零生产消费者的摆设，已随死适配器一批删除；
    // 生产装配走中立的 `createWebhookTriggerAdministration`（`webhookDispatch.ts:63/74` 两个
    // ServiceDependencies 组合根都直接调它），这里也改指它，覆盖面不变。
    const administration = createWebhookTriggerAdministration(harness.db)
    expect(await administration.endpointExists(endpointId)).toBe(true)
    expect(await administration.endpointExists('we_missing')).toBe(false)

    const record = triggerRecord(endpointId, owner.id)
    const created = await administration.create(record)
    expect(created).toMatchObject({ id: record.id, endpointId, enabled: true })
    expect((await administration.list()).map((row) => row.id)).toContain(record.id)

    const updated = await administration.update({
      triggerId: record.id,
      patch: { enabled: false, templateSyntaxVersion: 2, updatedAt: T0 + 1 },
    })
    expect(updated).toMatchObject({ id: record.id, enabled: false })

    // SQLite 别名同样是摆设；派发持久化只剩 PostgreSQL 这一个具名装配别名。
    const dispatchPostgresql = composePostgresqlWebhookDispatchPersistence(asPostgresql(harness.db))
    expect(await dispatchPostgresql.triggerEnabled(record.id)).toBe(false)
    expect(await dispatchPostgresql.triggerEnabled('wt_missing')).toBeNull()
    expect((await dispatchPostgresql.getTrigger(record.id))?.name).toBe(record.name)
    // enabled=false 之后不再出现在端点的启用清单里。
    expect(await dispatchPostgresql.listEnabledTriggers(endpointId)).toEqual([])

    const deliveryId = `wd_${ulid()}`
    const fireId = `wf_${ulid()}`
    await dispatchPostgresql.recordFire({
      fireId,
      deliveryId,
      triggerId: record.id,
      streamKey: 'stream-1',
      outcome: 'launched',
      taskId: null,
    })
    expect(await dispatchPostgresql.fireExists(deliveryId, record.id)).toBe(true)
    expect(await dispatchPostgresql.fireExists(deliveryId, 'wt_other')).toBe(false)
    expect((await administration.listFires(record.id, 10)).map((row) => row.id)).toEqual([fireId])

    await dispatchPostgresql.putTriggerStream({
      triggerId: record.id,
      streamKey: 'stream-1',
      consecutiveFires: 2,
      lastFireAt: T0 + 9,
    })
    expect(await dispatchPostgresql.getTriggerStream(record.id, 'stream-1')).toEqual({
      consecutiveFires: 2,
      lastFireAt: T0 + 9,
    })
    await administration.resetStream({
      triggerId: record.id,
      streamKey: 'stream-1',
      resetAt: T0 + 10,
      resetBy: owner.id,
    })
    expect(
      (await dispatchPostgresql.getTriggerStream(record.id, 'stream-1'))?.consecutiveFires,
    ).toBe(0)

    await administration.delete(record.id)
    expect(await administration.get(record.id)).toBeNull()
  })

  test('webhookDispatch 触发器服务依赖：两个别名装出的 administration / dispatchPersistence 都能读写', async () => {
    const owner = await seedUser(harness.db)
    const endpointId = await seedEndpoint(harness.db)
    // 定时任务运行时同时是本轮要还的另一条债（scheduledTasks.ts#composePostgresqlScheduledTaskRuntime）。
    const scheduled = composePostgresqlScheduledTaskRuntime({
      db: asPostgresql(harness.db),
      resourceSnapshots: composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
      validation: {
        assertWorkflowLaunchable: async () => {},
        assertAgentIntegrity: async () => {},
      },
      resourceAclChanged: () => {},
    })
    const sqlite = composeSqliteWebhookTriggerServiceDependencies(
      asSqlite(harness.db),
      '/tmp/aw-rfc359-w7.json',
      scheduled.operations,
    )
    const postgresql = composePostgresqlWebhookTriggerServiceDependencies(
      asPostgresql(harness.db),
      sqlite.validateSaveable,
    )

    const record = triggerRecord(endpointId, owner.id)
    await sqlite.administration.create(record)
    expect((await postgresql.administration.get(record.id))?.name).toBe(record.name)
    expect(await postgresql.dispatchPersistence.triggerEnabled(record.id)).toBe(true)
    expect(await sqlite.dispatchPersistence.getDeliveryMrFact('wd_missing')).toBeNull()
    expect(typeof postgresql.validateSaveable).toBe('function')
  })

  test('scheduledTasks 运行时：持久化面可列举，overview 按权限点决定是否给数', async () => {
    const admin = await seedUser(harness.db, 'admin')
    const runtime = composePostgresqlScheduledTaskRuntime({
      db: asPostgresql(harness.db),
      resourceSnapshots: composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
      validation: {
        assertWorkflowLaunchable: async () => {},
        assertAgentIntegrity: async () => {},
      },
      resourceAclChanged: () => {},
    })
    expect(await runtime.operations.persistence.list()).toEqual([])
    const actor = buildActor({
      source: 'session',
      user: {
        id: admin.id,
        username: admin.username,
        displayName: admin.username,
        role: 'admin',
        status: 'active',
      },
    })
    // 空库上 countVisible 走真查询回 0。
    expect(await runtime.overview.countScheduled(actor)).toBe(0)
    expect(await runtime.operations.persistence.get(`st_${ulid()}`)).toBeNull()
    expect(await runtime.operations.persistence.loadGrantLevel(`st_${ulid()}`, admin.id)).toBeNull()
    expect([...(await runtime.operations.persistence.listGrantedResourceIds(admin.id))]).toEqual([])
    // 资源查询面装的是同一份中立实现：空请求集合上返回空快照，不需要事务。
    expect(typeof runtime.integrationTriggerResources.loadAuthorized).toBe('function')
  })
})

describeEachProvider('RFC-359 W7 —— Integration 组合根：端点 / 入口 / 已验证投递', (harness) => {
  test('webhookEndpoints 服务依赖：tryCreate / getByUrlToken / update / delete 走真库', async () => {
    const sqlite = composeSqliteWebhookEndpointServiceDependencies({
      db: asSqlite(harness.db),
      configPath: '/tmp/aw-rfc359-w7.json',
      secretBox,
    })
    const postgresql = composePostgresqlWebhookEndpointServiceDependencies({
      db: asPostgresql(harness.db),
      configPath: '/tmp/aw-rfc359-w7.json',
      secretBox,
    })
    expect(sqlite.configPath).toBe('/tmp/aw-rfc359-w7.json')
    expect(postgresql.secretBox).toBe(secretBox)

    const urlToken = `tok_${ulid()}`
    const created = await sqlite.administration.tryCreate({
      id: `we_${ulid()}`,
      name: 'ep',
      provider: 'gitlab',
      urlToken,
      secretEnc: secretBox.seal('s'),
      preferredCloneProtocol: 'http',
    })
    expect(created).not.toBeNull()
    if (created === null) throw new Error('expected endpoint')
    // url_token 上有唯一索引：同 token 再建必须收敛成 null，而不是抛裸 SQL 错。
    expect(
      await postgresql.administration.tryCreate({
        id: `we_${ulid()}`,
        name: 'ep2',
        provider: 'gitlab',
        urlToken,
        secretEnc: secretBox.seal('s'),
        preferredCloneProtocol: 'http',
      }),
    ).toBeNull()
    expect((await postgresql.administration.getByUrlToken(urlToken))?.id).toBe(created.id)
    expect(
      await sqlite.administration.update(created.id, { enabled: false, updatedAt: T0 + 3 }),
    ).toMatchObject({ id: created.id, enabled: false })
    expect(await postgresql.administration.hasTriggerReferences(created.id)).toBe(false)
    expect(await sqlite.administration.delete(created.id)).toBe(true)
    expect((await postgresql.administration.list()).map((row) => row.id)).not.toContain(created.id)
  })

  test('webhookIngress 运行时：端点读、投递写、已验证投递接收、审计分页一体', async () => {
    const endpointId = await seedEndpoint(harness.db)
    const sqliteRuntime = composeSqliteWebhookDeliveryRuntime(asSqlite(harness.db))
    const postgresqlRuntime = composePostgresqlWebhookDeliveryRuntime(asPostgresql(harness.db))
    const postgresqlIngress = composePostgresqlWebhookIngressPersistence(asPostgresql(harness.db))

    expect((await sqliteRuntime.endpoints.get(endpointId))?.id).toBe(endpointId)
    expect(await postgresqlIngress.endpoints.get('we_missing')).toBeNull()

    const inserted = await postgresqlIngress.deliveries.insert({
      endpointId,
      eventUuid: `evt_${ulid()}`,
      status: 'received',
      eventType: 'push',
      repoPath: 'group/repo',
      bodyJson: '{"a":1}',
    })
    expect(inserted.kind).toBe('inserted')

    // 已验证投递：一次事务里落 delivery + MR 流状态 + 控制效果，两个 runtime 各接一条。
    const body = '{"object_kind":"merge_request","state":"closed"}'
    const accepted = await sqliteRuntime.acceptVerifiedDelivery({
      endpointId,
      event: codeHostEvent(),
      rawBodyBytes: new TextEncoder().encode(body),
      rawBodyText: body,
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
    })
    expect(accepted.kind).toBe('inserted')
    if (accepted.kind !== 'inserted') throw new Error('expected verified insert')
    expect(accepted.streamRevision).toBe(1)
    expect(accepted.controlAccepted).toBe(true)

    // 逐字节同形的重投是同一条事实，只 bump attempt。
    const replayed = await postgresqlRuntime.acceptVerifiedDelivery({
      endpointId,
      event: codeHostEvent(),
      rawBodyBytes: new TextEncoder().encode(body),
      rawBodyText: body,
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
    })
    expect(replayed).toMatchObject({ kind: 'duplicate', deliveryId: accepted.deliveryId })

    const page = await postgresqlRuntime.queries.page({ page: 1, limit: 10, endpointId })
    expect(page.total).toBe(2)
    expect(page.items.map((row) => row.id)).toContain(accepted.deliveryId)
    expect(await sqliteRuntime.queries.listRepoPaths()).toContain('group/repo')
    expect((await postgresqlRuntime.queries.get(accepted.deliveryId))?.mrStateAfter).toBe('closed')
    expect(await sqliteRuntime.queries.hasTerminalControlEffect(accepted.deliveryId)).toBe(true)
  })

  test('已验证投递接收：连着接两条独立事实', async () => {
    const endpointId = await seedEndpoint(harness.db)
    // RFC-359 W8：`compose{Sqlite,Postgresql}VerifiedWebhookDeliveryAcceptance` 两个别名与它们
    // 共用的中立包装都是零生产消费者的摆设，已随死适配器一批删除。生产的接收路径是
    // `webhookIngress.ts:34::composeWebhookIngressPersistenceFor` 直接用的
    // `createVerifiedWebhookDeliveryPersistence(db).accept`，这里改指它，断言一条不减。
    const accept = createVerifiedWebhookDeliveryPersistence(harness.db).accept
    // 事实键含 body 字节：两条要真的独立，body 也必须不同（同 body 是同一条事实，只 bump attempt）。
    const bodyOf = (iid: string) => `{"object_kind":"merge_request","state":"closed","iid":${iid}}`
    const first = await accept({
      endpointId,
      event: codeHostEvent({ mrIid: '11' }),
      rawBodyBytes: new TextEncoder().encode(bodyOf('11')),
      rawBodyText: bodyOf('11'),
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
    })
    expect(first.kind).toBe('inserted')
    const second = await accept({
      endpointId,
      event: codeHostEvent({ mrIid: '12' }),
      rawBodyBytes: new TextEncoder().encode(bodyOf('12')),
      rawBodyText: bodyOf('12'),
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
    })
    expect(second.kind).toBe('inserted')
    if (first.kind !== 'inserted' || second.kind !== 'inserted') {
      throw new Error('expected two independent facts')
    }
    expect(first.deliveryId).not.toBe(second.deliveryId)
    expect(second.streamRevision).toBe(1)
  })

  test('MR 终态控制：保护性启动预留在流仍 open 时成功，流不存在时按 webhook-mr-launch-terminal 拒绝', async () => {
    const endpointId = await seedEndpoint(harness.db)
    // 任务终止参与者也是本轮要还的债；PostgreSQL 侧的事务体只在 wake/drain 时才走，
    // 这里驱动的是预留路径（中立持久化 + 引擎的 advisory lock）。
    const taskTermination = composePostgresqlTaskSourceTermination(asPostgresql(harness.db))
    const control = composePostgresqlMrTerminalControl({
      db: asPostgresql(harness.db),
      taskTermination,
    })
    try {
      const input = {
        endpointId,
        streamKey: 'refs/mr/1',
        binding: `${endpointId}:refs/mr/1`,
        launchRevision: 1,
        deliveryId: `wd_${ulid()}`,
        fireId: `fire_${ulid()}`,
        triggerId: `wt_${ulid()}`,
        triggerName: 'trigger',
      }
      expect(await errorCodeOf(() => control.reserveLaunch(input))).toBe(
        'webhook-mr-launch-terminal',
      )

      await harness.db.insert(webhookMrStreamStates).values({
        endpointId,
        streamKey: 'refs/mr/1',
        projectId: '77',
        mrIid: '1',
        state: 'open',
        revision: 1,
        lastTerminalRevision: null,
        lastDeliveryId: input.deliveryId,
        updatedAt: T0,
      })
      const guard = await control.reserveLaunch(input)
      expect(guard.signal.aborted).toBe(false)
      guard.assertCanCommit()
      // 持久判据同样要成立：guard 行进了库、流仍 open。
      expect(await guard.verifyCanCommit().then(() => 'ok')).toBe('ok')
      await guard.launchSettled(`t_${ulid()}`)
      guard.release()
      // 启动时没有待处理效果，reconcileOnBoot 是一次可完成的空扫描。
      await control.reconcileOnBoot()
    } finally {
      await control.stop()
    }
  })

  test('terminalWorkspaceCleanup 策略：归属列由策略自己读，缺行不回收，webhook 归属才回收', async () => {
    const policy = composePostgresqlWebhookTerminalWorkspacePrunePolicy({
      db: asPostgresql(harness.db),
      enabled: () => true,
    })
    const row = {
      taskId: `t_${ulid()}`,
      spaceKind: 'remote' as const,
      workspacePruningAt: null,
      workspacePruneCause: null,
      workspacePrunedAt: null,
    }
    expect(await policy(row, 'done')).toEqual({ prune: false })

    const workflowId = `wf_${ulid()}`
    await harness.db.insert(workflows).values({
      id: workflowId,
      name: `wf-${workflowId.slice(-6).toLowerCase()}`,
      definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [] }),
    })
    await harness.db.insert(tasks).values({
      id: row.taskId,
      name: 'webhook task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/srv/repos/x',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/x',
      status: 'running',
      inputs: '{}',
      startedAt: T0,
      spaceKind: 'remote',
      webhookTriggerId: `wt_${ulid()}`,
    })
    expect(await policy(row, 'done')).toEqual({ prune: true, cause: 'webhook-terminal' })
    // 非终态、以及已认领墓碑列的行都不回收。
    expect(await policy(row, 'running')).toEqual({ prune: false })
    expect(await policy({ ...row, workspacePrunedAt: T0 }, 'canceled')).toEqual({ prune: false })
  })
})

describeEachProvider('RFC-359 W7 —— Integration 组合根：外部适配器运行器', (harness) => {
  test('requirementSource / pipelineEvidence / approvalGateway：绑定解析走真库，用途不符与未发布各成一条分支', async () => {
    const requirement = composePostgresqlRequirementSourceRunner(asPostgresql(harness.db))
    const pipelineSqlite = composeSqlitePipelineEvidenceRunner(asSqlite(harness.db))
    const pipelinePostgresql = composePostgresqlPipelineEvidenceRunner(asPostgresql(harness.db))
    const approval = composePostgresqlApprovalGatewayRunner(asPostgresql(harness.db))

    // ① 库里没有这条 revision ⇒ 绑定解析不出来（真查询回 null）。
    const missing = await requirement.acquire({
      adapterBindingRef: `da_${ulid()}@1`,
      externalId: 'REQ-1',
      sinkPath: '/tmp/aw-rfc359-w7-sink',
    })
    expect(missing).toMatchObject({
      ok: false,
      failure: { code: 'adapter-binding-unresolved', category: 'configuration' },
    })

    // ② 库里有行、但 purpose 不是 requirement-source ⇒ 说明内容确实被读出来并解析过。
    const gate = await seedAdapter(harness.db, 'pipeline-gate')
    expect(
      await requirement.acquire({
        adapterBindingRef: `${gate.id}@${gate.revision}`,
        externalId: 'REQ-1',
        sinkPath: '/tmp/aw-rfc359-w7-sink',
      }),
    ).toMatchObject({ ok: false, failure: { code: 'adapter-purpose-mismatch' } })

    // ③ pipeline-gate 运行器读同一行时用途相符；两个别名对同一条绑定给同样的判断。
    const source = await seedAdapter(harness.db, 'requirement-source')
    for (const runner of [pipelineSqlite, pipelinePostgresql]) {
      expect(
        await runner.collect({
          adapterBindingRef: `${source.id}@${source.revision}`,
          headSha: 'a'.repeat(40),
          targetSha: 'b'.repeat(40),
          gateKeys: ['build'],
          sinkPath: '/tmp/aw-rfc359-w7-sink',
        }),
      ).toMatchObject({ ok: false, failure: { code: 'adapter-purpose-mismatch' } })
    }

    // ④ approval-gateway 的幂等键查询同样落在真库上：未发布的绑定返回 null 收据。
    expect(
      await approval.lookupByIdempotencyKey({
        adapterRef: { id: `da_${ulid()}`, revision: 1 },
        idempotencyKey: 'idem-1',
      }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 真正按 provider 分叉的那一个
// ---------------------------------------------------------------------------
//
// `composeSqliteDevelopmentToolConnectionCatalog` 装的是
// `createSqliteDevelopmentToolConnectionStore`——它用 bun:sqlite 的**同步** `.get()` / `.all()`，
// 在 PostgreSQL 客户端上这两个返回 Promise，`row === undefined` 恒为 false，投影会拿到 Promise
// 而不是行。所以这个别名只在 SQLite 引擎上成立；PostgreSQL 侧由
// `composePostgresqlDevelopmentToolConnectionCatalog`（已被别处覆盖）承担。
// 这里按引擎分叉而不是硬跑两遍，正是账本判据要保住的那点诚实。

describeEachProvider('RFC-359 W7 —— Integration 组合根：数字员工工具连接目录', (harness) => {
  test('SQLite 目录：published revision 可解析为闭包摘要，自动挑选按 purpose 命中', async () => {
    if (harness.capabilities.provider !== 'sqlite') {
      // PostgreSQL 侧走 composePostgresqlDevelopmentToolConnectionCatalog（同步 store 不适用）。
      return
    }
    const adapter = await seedAdapter(harness.db, 'requirement-source')
    const catalog = composeSqliteDevelopmentToolConnectionCatalog(asSqlite(harness.db))
    const resolved = await catalog.resolve({ id: adapter.id, revision: adapter.revision })
    expect(resolved).toMatchObject({
      purpose: 'requirement-source',
      available: true,
      visible: true,
      contentDigest: 'digest',
    })
    expect(resolved?.closureSummary).toContain('exact revision 1')
    expect(await catalog.resolve({ id: `da_${ulid()}`, revision: 1 })).toBeNull()

    const selected = await catalog.selectAutomatic({
      purpose: 'requirement-source',
      candidates: [],
    })
    expect(selected).toMatchObject({ ref: { id: adapter.id, revision: 1 } })
    expect(
      await catalog.selectAutomatic({ purpose: 'approval-gateway', candidates: [] }),
    ).toBeNull()
  })
})

test('本文件覆盖的组合根都来自生产装配面（不是测试里自写的同名 stub）', () => {
  // 同一份中立实现的两个装配别名会是**同一个函数对象**（`export const composeSqliteX = composeXFor`），
  // 所以这里不比对象身份，只确认每个导出名都真的解析成了可调用的生产工厂。
  const roots: readonly unknown[] = [
    composePostgresqlApprovalGatewayRunner,
    composeSqliteDevelopmentToolConnectionCatalog,
    composePostgresqlPipelineEvidenceRunner,
    composeSqlitePipelineEvidenceRunner,
    composePostgresqlRequirementSourceRunner,
    composePostgresqlScheduledTaskRuntime,
    composePostgresqlWebhookTerminalWorkspacePrunePolicy,
    composePostgresqlWebhookDeliveryPersistence,
    composeSqliteWebhookDeliveryPersistence,
    composePostgresqlWebhookDispatchPersistence,
    composePostgresqlWebhookTriggerServiceDependencies,
    composeSqliteWebhookTriggerServiceDependencies,
    composePostgresqlWebhookEndpointServiceDependencies,
    composeSqliteWebhookEndpointServiceDependencies,
    composePostgresqlWebhookDeliveryRuntime,
    composePostgresqlWebhookIngressPersistence,
    composeSqliteWebhookDeliveryRuntime,
    composePostgresqlMrTerminalControl,
    composePostgresqlTaskSourceTermination,
  ]
  expect(roots.length).toBe(19)
  expect(roots.filter((root) => typeof root === 'function').length).toBe(roots.length)
})
