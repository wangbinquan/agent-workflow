// RFC-359 W4-D7b —— Digital Employee OS 运行时案件持久化合一：案件创建（含上传认领）、计量 CAS、成员替换、
// 分页 / 搜索 / 成员制过滤、反应轮次的建—跑—结、收件箱投递去重与合并、outbox 认领 / 完成 / 重试、终止案件的级联，
// 同一段断言在两个引擎上各跑一遍。末尾一条源码锁保证该族不再出现 provider 专属文件。

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { employeeCases, employeeOsOutbox, users } from '@/db/schema'
import type { RuntimeCasePersistence } from '@/modules/digital-employee/application/ports/runtimeStore'
import type {
  EmployeeCaseRecord,
  EmployeeContextRecord,
} from '@/modules/digital-employee/domain/runtimeModel'
import { createEmployeeInputUploadPersistence } from '@/modules/digital-employee/infrastructure/inputUploadStore'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

function caseRecord(id: string, overrides: Partial<EmployeeCaseRecord> = {}): EmployeeCaseRecord {
  return {
    id,
    name: `Case ${id}`,
    employeeRef: { id: 'employee-1', revision: 1 },
    typeRef: { typeId: 'development', revision: 10 },
    primaryContextId: `${id}-context`,
    executionPolicyRevision: 1,
    maxDurationMs: null,
    consumedDurationMs: 0,
    maxTotalTokens: null,
    consumedTotalTokens: 0,
    ownerUserId: 'owner-1',
    launchOrigin: 'manual',
    state: 'active',
    terminalKind: null,
    blockReason: null,
    currentWorkItemRef: 'analyze-implement',
    activeRoundId: null,
    revision: 1,
    writerGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
    ...overrides,
  }
}

function contextRecord(caseId: string, stateJson = '{}'): EmployeeContextRecord {
  return {
    id: `${caseId}-context`,
    caseId,
    typeId: 'development.primary',
    schemaVersion: 1,
    revision: 1,
    lifecycleState: 'active',
    stateJson,
    artifactRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

async function seedCase(
  store: RuntimeCasePersistence,
  id: string,
  overrides: Partial<EmployeeCaseRecord> = {},
  stateJson = '{}',
): Promise<EmployeeCaseRecord> {
  const record = caseRecord(id, overrides)
  await store.createCase({
    caseRecord: record,
    primaryContext: contextRecord(id, stateJson),
    contextDigest: '0'.repeat(64),
    externalSubject: { typeId: 'test.subject', subjectRef: `subject:${id}` },
    eventOrigin: null,
    uploadClaims: [],
    initialMembers: [],
  })
  return record
}

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_d7b_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describeEachProvider('RFC-359 W4-D7b —— Digital Employee 运行时案件持久化', (harness) => {
  test('createCase：一笔事务落案件 / 上下文 / 外部主体绑定 / 生命周期 outbox，上传认领改 pending 为 claimed', async () => {
    const db = harness.db
    const store = createRuntimePersistence(db)
    const uploads = createEmployeeInputUploadPersistence(db)
    const upload = await uploads.create({
      actorUserId: 'owner-1',
      originalName: 'spec.md',
      bytes: 1,
      sha256: 'a'.repeat(64),
      blobRef: 'blob-1',
      idempotencyKey: null,
      now: NOW,
    })
    const id = `case_${ulid()}`
    const memberId = await seedUser(db)
    const record = caseRecord(id)
    await store.createCase({
      caseRecord: record,
      primaryContext: contextRecord(id, '{"needle":"Alpha"}'),
      contextDigest: '0'.repeat(64),
      externalSubject: { typeId: 'test.subject', subjectRef: `subject:${id}` },
      eventOrigin: { eventSubscriptionId: 'sub-1', eventDeliveryId: `delivery:${id}` },
      uploadClaims: [
        {
          uploadRef: upload.id,
          actorUserId: 'owner-1',
          sha256: upload.sha256,
          blobRef: upload.blobRef,
        },
      ],
      initialMembers: [
        { userId: memberId, role: 'collaborator', addedBy: 'owner-1', addedAt: NOW },
      ],
    })
    expect(await store.getCase(id)).toEqual(record)
    expect((await store.findCaseByEventDelivery(`delivery:${id}`))?.id).toBe(id)
    expect((await store.findCaseByExternalSubject('test.subject', `subject:${id}`))?.id).toBe(id)
    expect((await store.listContexts(id)).map((context) => context.stateJson)).toEqual([
      '{"needle":"Alpha"}',
    ])
    expect(await store.listCaseMembers(id)).toEqual([
      { caseId: id, userId: memberId, role: 'collaborator', addedBy: 'owner-1', addedAt: NOW },
    ])
    expect(await store.getCaseMemberRole(id, memberId)).toBe('collaborator')
    expect(await store.getCaseMemberRole(id, 'nobody')).toBeNull()
    // 上传已被认领：再按 pending 解析就不可认领；同一案件重解析仍拿得到。
    expect(
      await codeOf(() =>
        uploads.resolveForCase({
          ids: [upload.id],
          actorUserId: 'owner-1',
          caseId: 'other',
          now: NOW,
        }),
      ),
    ).toBe('employee-upload-not-claimable')
    expect(
      (
        await uploads.resolveForCase({
          ids: [upload.id],
          actorUserId: 'owner-1',
          caseId: id,
          now: NOW,
        })
      ).map((row) => row.state),
    ).toEqual(['claimed'])
    // 生命周期事件进了 outbox（dedupe 键幂等）。
    const outbox = await db
      .select({ id: employeeOsOutbox.id, kind: employeeOsOutbox.kind })
      .from(employeeOsOutbox)
      .where(eq(employeeOsOutbox.caseId, id))
    expect(outbox).toEqual([{ id: `case-lifecycle:${id}:1`, kind: 'event-publish' }])
    // 认领冲突：同一上传再认领一次 → 409，案件不落。
    const second = `case_${ulid()}`
    expect(
      await codeOf(() =>
        store.createCase({
          caseRecord: caseRecord(second),
          primaryContext: contextRecord(second),
          contextDigest: '0'.repeat(64),
          externalSubject: { typeId: 'test.subject', subjectRef: `subject:${second}` },
          eventOrigin: null,
          uploadClaims: [
            {
              uploadRef: upload.id,
              actorUserId: 'owner-1',
              sha256: upload.sha256,
              blobRef: upload.blobRef,
            },
          ],
          initialMembers: [],
        }),
      ),
    ).toBe('employee-upload-claim-conflict')
    expect(await store.getCase(second)).toBeNull()
  })

  test('计量：同 sourceRef 只记一次，revision 随生效递增；成员替换在同一事务改 owner 并返回变更前受众', async () => {
    const store = createRuntimePersistence(harness.db)
    const id = `case_${ulid()}`
    await seedCase(store, id)
    const memberA = await seedUser(harness.db)
    const receipt = {
      sourceRef: `metering:${id}`,
      caseId: id,
      roundId: 'round-1',
      durationMs: 321,
      totalTokens: 654,
      now: NOW + 1,
    }
    expect(await store.recordMetering(receipt)).toMatchObject({
      applied: true,
      caseRecord: { consumedDurationMs: 321, consumedTotalTokens: 654, revision: 2 },
    })
    expect(await store.recordMetering({ ...receipt, now: NOW + 2 })).toMatchObject({
      applied: false,
      caseRecord: { consumedDurationMs: 321, consumedTotalTokens: 654, revision: 2 },
    })
    expect(await codeOf(() => store.recordMetering({ ...receipt, durationMs: -1 }))).toBe(
      'employee-case-metering-invalid',
    )
    expect(await codeOf(() => store.recordMetering({ ...receipt, caseId: 'missing' }))).toBe(
      'employee-case-not-found',
    )

    const replaced = await store.replaceCaseMembers({
      caseId: id,
      ownerUserId: 'owner-2',
      members: [{ userId: memberA, role: 'observer' }],
      addedBy: 'owner-1',
      now: NOW + 3,
    })
    expect(replaced).toEqual({ previousOwnerUserId: 'owner-1', previousMemberUserIds: [] })
    expect(await store.getCase(id)).toMatchObject({ ownerUserId: 'owner-2', revision: 2 })
    expect((await store.listCaseMembers(id)).map((member) => [member.userId, member.role])).toEqual(
      [[memberA, 'observer']],
    )
    expect(
      await codeOf(() =>
        store.replaceCaseMembers({
          caseId: 'missing',
          ownerUserId: null,
          members: [],
          addedBy: 'x',
          now: 1,
        }),
      ),
    ).toBe('employee-case-not-found')
  })

  test('分页：视图 facets、成员制 mine / shared、终态目录状态、大小写不敏感搜索、游标', async () => {
    const store = createRuntimePersistence(harness.db)
    const employeeId = `employee_${ulid()}`
    const owner = `owner_${ulid()}`
    const member = await seedUser(harness.db)
    const seed = async (
      suffix: string,
      overrides: Partial<EmployeeCaseRecord>,
      stateJson?: string,
    ) =>
      seedCase(
        store,
        `${employeeId}-${suffix}`,
        { employeeRef: { id: employeeId, revision: 1 }, ownerUserId: owner, ...overrides },
        stateJson,
      )
    const active = await seed('active', { updatedAt: NOW + 10, name: 'Alpha Needle' })
    const waiting = await seed('waiting', { state: 'waiting', updatedAt: NOW + 20 })
    const blocked = await seed('blocked', {
      state: 'blocked',
      blockReason: 'operator NEEDLE',
      updatedAt: NOW + 30,
    })
    const done = await seed('done', {
      state: 'terminal',
      terminalKind: 'merged',
      terminalAt: NOW + 40,
      updatedAt: NOW + 40,
    })
    const canceled = await seed('canceled', {
      state: 'terminal',
      terminalKind: 'closed',
      terminalAt: NOW + 50,
      updatedAt: NOW + 50,
    })
    const shared = await seed(
      'shared',
      { ownerUserId: 'someone-else', updatedAt: NOW + 60 },
      '{"needle":"hidden"}',
    )
    await store.replaceCaseMembers({
      caseId: shared.id,
      ownerUserId: 'someone-else',
      members: [{ userId: member, role: 'collaborator' }],
      addedBy: 'someone-else',
      now: NOW + 61,
    })
    await store.replaceCaseMembers({
      caseId: active.id,
      ownerUserId: owner,
      members: [{ userId: member, role: 'observer' }],
      addedBy: owner,
      now: NOW + 62,
    })

    const all = await store.listCasesPage({ employeeId, view: 'all', cursor: null, limit: 100 })
    expect(all.facets).toEqual({ all: 6, active: 3, attention: 1, finished: 2 })
    expect(all.cases.map((row) => row.id)).toEqual([
      shared.id,
      canceled.id,
      done.id,
      blocked.id,
      waiting.id,
      active.id,
    ])
    expect(
      (
        await store.listCasesPage({ employeeId, view: 'attention', cursor: null, limit: 100 })
      ).cases.map((row) => row.id),
    ).toEqual([blocked.id])
    expect(
      (
        await store.listCasesPage({ employeeId, view: 'finished', cursor: null, limit: 100 })
      ).cases.map((row) => row.id),
    ).toEqual([canceled.id, done.id])
    expect(
      (
        await store.listCasesPage({
          employeeId,
          states: ['terminal'],
          terminalCatalogStatuses: ['done'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((row) => row.id),
    ).toEqual([done.id])
    expect(
      (
        await store.listCasesPage({
          employeeId,
          states: ['waiting', 'terminal'],
          terminalCatalogStatuses: ['canceled'],
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((row) => row.id),
    ).toEqual([canceled.id, waiting.id])
    expect(
      (await store.listCasesPage({ employeeId, states: [], view: 'all', cursor: null, limit: 100 }))
        .cases,
    ).toEqual([])
    // 成员制：mine = 发起人 ∨ 成员；shared = 成员 ∧ 非发起人（member 是 active 的 observer、shared 的 collaborator，两者 owner 都不是它）。
    expect(
      (
        await store.listCasesPage({
          employeeId,
          membership: { actorUserId: member, scope: 'mine' },
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((row) => row.id),
    ).toEqual([shared.id, active.id])
    expect(
      (
        await store.listCasesPage({
          employeeId,
          membership: { actorUserId: member, scope: 'shared' },
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases.map((row) => row.id),
    ).toEqual([shared.id, active.id])
    expect(
      (
        await store.listCasesPage({
          employeeId,
          membership: { actorUserId: owner, scope: 'shared' },
          view: 'all',
          cursor: null,
          limit: 100,
        })
      ).cases,
    ).toEqual([])
    // 搜索：大小写不敏感，覆盖名字 / 阻塞原因 / 主上下文状态；通配符按字面匹配。
    const search = async (q: string) =>
      (
        await store.listCasesPage({ employeeId, q, view: 'all', cursor: null, limit: 100 })
      ).cases.map((row) => row.id)
    expect(await search('needle')).toEqual([shared.id, blocked.id, active.id])
    expect(await search('ALPHA')).toEqual([active.id])
    expect(await search('%')).toEqual([])
    // 游标：按 (updatedAt, id) 降序翻页。
    const first = await store.listCasesPage({ employeeId, view: 'all', cursor: null, limit: 2 })
    expect(first.hasMore).toBe(true)
    const last = first.cases[first.cases.length - 1]!
    const second = await store.listCasesPage({
      employeeId,
      view: 'all',
      cursor: { updatedAt: last.updatedAt, id: last.id },
      limit: 2,
    })
    expect(second.cases.map((row) => row.id)).toEqual([done.id, blocked.id])
    expect(await store.listCases(employeeId, 'terminal')).toHaveLength(2)
    expect(
      (await store.listTerminalOutcomeGroups()).filter((group) => group.employeeId === employeeId),
    ).toEqual([
      { employeeId, terminalKind: 'closed', count: 1 },
      { employeeId, terminalKind: 'merged', count: 1 },
    ])
  })

  test('反应轮次：投递去重与合并、建轮次（CAS）、跑、重试、结算翻案件状态并入队生命周期事件', async () => {
    const store = createRuntimePersistence(harness.db)
    const id = `case_${ulid()}`
    await seedCase(store, id)
    const delivery = (deliveryId: string, eventId: string) => ({
      deliveryId,
      subscriptionId: 'sub-1',
      eventId,
      eventTypeRef: { id: 'event.type', revision: 1 },
      sourceRef: { id: 'source', revision: 1 },
      subject: { typeId: 'test.subject', subjectRef: `subject:${id}` },
      deliveryClass: 'default',
      occurredAt: NOW + 1,
      summary: 'hello',
      payloadArtifactRef: null,
    })
    expect(
      await store.acceptDelivery(id, `inbox_${id}_1`, delivery(`d1:${id}`, 'e1'), 5, NOW + 1),
    ).toBe(true)
    expect(
      await store.acceptDelivery(id, `inbox_${id}_1b`, delivery(`d1:${id}`, 'e1'), 5, NOW + 1),
    ).toBe(false)
    // 同主体同事件类型的第二条投递把前一条合并掉。
    expect(
      await store.acceptDelivery(id, `inbox_${id}_2`, delivery(`d2:${id}`, 'e2'), 7, NOW + 2),
    ).toBe(true)
    const inbox = await store.listInbox(id)
    expect(inbox.map((row) => [row.id, row.state])).toEqual([
      [`inbox_${id}_2`, 'pending'],
      [`inbox_${id}_1`, 'coalesced'],
    ])

    const round = {
      id: `round_${id}`,
      caseId: id,
      caseRevision: 1,
      inboxId: `inbox_${id}_2`,
      employeeRef: { id: 'employee-1', revision: 1 },
      ruleId: 'rule-1',
      workItemRef: 'analyze-implement',
      workContractRef: { contractId: 'development.implement-change', version: 1 },
      toolRef: null,
      executionPolicyRevision: 1,
      inputContextRefsJson: '[]',
      planJson: '{}',
      state: 'planned' as const,
      executionRef: null,
      outputJson: null,
      attemptOrdinal: 0,
      createdAt: NOW + 3,
      updatedAt: NOW + 3,
      settledAt: null,
    }
    const launch = {
      id: `launch_${id}`,
      caseId: id,
      kind: 'execution-launch' as const,
      payloadJson: '{}',
      dedupeKey: `launch:${id}`,
      attemptCount: 0,
    }
    // 期望 revision 不符 → 不建。
    expect(
      await store.createRound({
        round,
        plan: {} as never,
        inboxId: round.inboxId,
        expectedCaseRevision: 9,
        launchOutbox: launch,
      }),
    ).toBe(false)
    expect(
      await store.createRound({
        round,
        plan: {} as never,
        inboxId: round.inboxId,
        expectedCaseRevision: 1,
        launchOutbox: launch,
      }),
    ).toBe(true)
    expect(await store.getCase(id)).toMatchObject({ activeRoundId: round.id, revision: 2 })
    expect((await store.listInbox(id)).find((row) => row.id === round.inboxId)?.state).toBe(
      'claimed',
    )
    // 已有活动轮次 → 再建失败。
    expect(
      await store.createRound({
        round: { ...round, id: `round2_${id}` },
        plan: {} as never,
        inboxId: null,
        expectedCaseRevision: 2,
        launchOutbox: null,
      }),
    ).toBe(false)

    await store.markRoundRunning(round.id, 'exec-1', NOW + 4)
    expect((await store.listRunningRounds()).map((row) => row.id)).toContain(round.id)
    expect(
      await codeOf(() =>
        store.retryRound({
          roundId: round.id,
          expectedExecutionRef: 'stale',
          errorJson: '{}',
          attemptOrdinal: 1,
          nextAttemptAt: NOW + 5,
          launchOutbox: { ...launch, id: `retry_${id}`, dedupeKey: `retry:${id}` },
          now: NOW + 5,
        }),
      ),
    ).toBe('employee-reaction-retry-stale')
    await store.retryRound({
      roundId: round.id,
      expectedExecutionRef: 'exec-1',
      errorJson: '{"error":"boom"}',
      attemptOrdinal: 1,
      nextAttemptAt: NOW + 5,
      launchOutbox: { ...launch, id: `retry_${id}`, dedupeKey: `retry:${id}` },
      now: NOW + 5,
    })
    expect((await store.listRounds(id))[0]).toMatchObject({
      state: 'planned',
      attemptOrdinal: 1,
      executionRef: null,
    })
    await store.markRoundRunning(round.id, 'exec-2', NOW + 6)

    // outbox：认领 → 完成；lost claim 报错。
    const claimed = await store.claimOutbox({ workerId: 'worker-1', now: NOW + 7, leaseMs: 1_000 })
    expect(claimed).not.toBeNull()
    expect(
      await codeOf(() => store.completeOutbox(claimed!.id, 'worker-2', NOW + 8)),
    ).toBeUndefined()
    await store.completeOutbox(claimed!.id, 'worker-1', NOW + 8)
    const next = await store.claimOutbox({ workerId: 'worker-1', now: NOW + 9, leaseMs: 1_000 })
    expect(next?.id).not.toBe(claimed!.id)
    if (next !== null) {
      await store.retryOutbox({
        id: next.id,
        workerId: 'worker-1',
        error: 'transient',
        nextAttemptAt: NOW + 100,
        terminal: false,
        now: NOW + 10,
      })
    }

    await store.settleRound({
      roundId: round.id,
      state: 'completed',
      outputJson: '{"ok":true}',
      nextCaseState: 'waiting',
      nextWorkItemRef: 'review',
      now: NOW + 11,
    })
    expect(await store.getCase(id)).toMatchObject({
      state: 'waiting',
      activeRoundId: null,
      currentWorkItemRef: 'review',
      revision: 3,
    })
    expect((await store.listRounds(id))[0]).toMatchObject({
      state: 'completed',
      settledAt: NOW + 11,
    })
    expect((await store.listInbox(id)).find((row) => row.id === round.inboxId)?.state).toBe(
      'settled',
    )
    // 再结算是幂等的；不存在的轮次 404。
    await store.settleRound({
      roundId: round.id,
      state: 'completed',
      outputJson: null,
      now: NOW + 12,
    })
    expect(
      await codeOf(() =>
        store.settleRound({ roundId: 'missing', state: 'completed', outputJson: null, now: 1 }),
      ),
    ).toBe('employee-reaction-round-not-found')

    // block / resume / terminate。
    await store.blockCase(id, 'needs operator', NOW + 13)
    expect(await store.getCase(id)).toMatchObject({
      state: 'blocked',
      blockReason: 'needs operator',
      revision: 4,
    })
    expect(await store.resumeCase(id, NOW + 14)).toMatchObject({
      state: 'active',
      blockReason: null,
      revision: 5,
    })
    expect(await codeOf(() => store.resumeCase(id, NOW + 15))).toBe('employee-case-not-blocked')
    expect(
      await store.upgradePolicy({
        caseId: id,
        expectedRevision: 5,
        targetPolicyRevision: 2,
        now: NOW + 16,
      }),
    ).toMatchObject({ executionPolicyRevision: 2, revision: 6 })
    expect(
      await store.upgradePolicy({
        caseId: id,
        expectedRevision: 5,
        targetPolicyRevision: 3,
        now: NOW + 17,
      }),
    ).toBeNull()
    const terminated = await store.terminateCase(id, 'closed', NOW + 18)
    expect(terminated).toMatchObject({
      state: 'terminal',
      terminalKind: 'closed',
      writerGeneration: 2,
      terminalAt: NOW + 18,
    })
    expect(await codeOf(() => store.resumeCase(id, NOW + 19))).toBe('employee-case-terminal')
    // 终态后的投递直接 obsolete。
    expect(
      await store.acceptDelivery(id, `inbox_${id}_3`, delivery(`d3:${id}`, 'e3'), 1, NOW + 20),
    ).toBe(true)
    expect((await store.listInbox(id)).find((row) => row.id === `inbox_${id}_3`)?.state).toBe(
      'obsolete',
    )
    const lifecycle = await harness.db
      .select({ id: employeeOsOutbox.id })
      .from(employeeOsOutbox)
      .where(eq(employeeOsOutbox.caseId, id))
    expect(lifecycle.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        `case-lifecycle:${id}:1`,
        `case-lifecycle:${id}:3`,
        `case-lifecycle:${id}:4`,
        `case-lifecycle:${id}:5`,
        `case-lifecycle:${id}:7`,
      ]),
    )
    expect(
      await harness.db
        .select({ id: employeeCases.id })
        .from(employeeCases)
        .where(eq(employeeCases.id, id)),
    ).toHaveLength(1)
  })
})

test('源码锁：运行时案件存储不再有 provider 专属文件', () => {
  const infra = join(import.meta.dir, '..', 'src', 'modules', 'digital-employee', 'infrastructure')
  for (const legacy of ['sqliteRuntimeStore.ts', 'postgresqlRuntimeStore.ts']) {
    expect(existsSync(join(infra, legacy))).toBe(false)
  }
  const source = readFileSync(join(infra, 'runtimeStore.ts'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  expect(source).not.toMatch(
    /PostgresqlDatabaseClient|\bDbClient\b|dbTxSync|for update|\bilike\(|\blike\(/i,
  )
  expect(source).toContain('ProviderNeutralDatabase')
  expect(source).toContain('engine.lockAggregateRoot(')
  expect(source).toContain('engine.ascNullsFirst(')
})
