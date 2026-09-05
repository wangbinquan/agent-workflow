// RFC-359 W4-B4 批 c —— identity-access / memory 两对合一，两个引擎各跑一遍：OIDC provider 仓库（写路径走统一原语的
// serializable，slug 撞库经引擎能力矩阵归类）与记忆蒸馏工作存储（含会话捕获 sink 合一）。

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  authLoginPolicy,
  cachedRepos,
  memories,
  memoryDistillJobs,
  nodeRuns,
  taskFeedback,
  tasks,
  userIdentities,
  users,
  workflows,
} from '@/db/schema'
import { DrizzleOidcProviderRepository } from '@/modules/identity-access/infrastructure/oidcProviderRepository'
import type { InsertOidcProviderRecord } from '@/modules/identity-access/application/ports/oidcProviderPersistence'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b4c_${ulid()}`
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

function providerRecord(slug: string, extra: Partial<InsertOidcProviderRecord> = {}) {
  return {
    id: `oidc_${ulid()}`,
    slug,
    displayName: slug,
    issuerUrl: `https://issuer.invalid/${slug}`,
    clientId: 'client',
    clientSecretEnc: 'sealed',
    scopes: 'openid profile email',
    provisioning: 'auto' as const,
    allowedEmailDomainsJson: '[]',
    iconUrl: null,
    enabled: true,
    authorizationEndpoint: null,
    tokenEndpoint: null,
    userinfoEndpoint: null,
    userinfoRequestStyle: 'get_bearer' as const,
    jwksUri: null,
    trustEmailVerified: true,
    usernameClaim: null,
    gitNameClaim: null,
    emailClaim: null,
    subjectClaim: null,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...extra,
  } satisfies InsertOidcProviderRecord
}

describeEachProvider('RFC-359 W4-B4c —— OIDC provider 仓库', (harness) => {
  test('插入 / 查找 / slug 撞库 / 最后一个登录家族 / subject claim 锁定 / 删除与强制删除', async () => {
    const db = harness.db
    const repository = new DrizzleOidcProviderRepository(db)
    const slugA = `a-${ulid().toLowerCase()}`
    const slugB = `b-${ulid().toLowerCase()}`
    const a = providerRecord(slugA)
    const b = providerRecord(slugB, { enabled: false })
    expect(await repository.insert(a)).toEqual({ ok: true, value: a })
    expect(await repository.insert(b)).toEqual({ ok: true, value: b })
    expect(await repository.insert(providerRecord(slugA))).toEqual({
      ok: false,
      code: 'oidc-slug-taken',
    })
    expect((await repository.list()).map((row) => row.id).sort()).toEqual([a.id, b.id].sort())
    expect((await repository.listEnabled()).map((row) => row.id)).toEqual([a.id])
    expect((await repository.findById(b.id))?.slug).toBe(slugB)
    expect(await repository.findById('missing')).toBeNull()
    expect((await repository.findBySlug(slugA))?.id).toBe(a.id)
    expect(await repository.findBySlug('missing')).toBeNull()

    expect(
      await repository.patch({
        id: 'missing',
        updates: { displayName: 'x', updatedAt: 2 },
        subjectClaimChanges: false,
      }),
    ).toEqual({ ok: false, code: 'oidc-provider-not-found' })
    expect(
      await repository.patch({
        id: b.id,
        updates: { slug: slugA, updatedAt: 2 },
        subjectClaimChanges: false,
      }),
    ).toEqual({ ok: false, code: 'oidc-slug-taken' })
    const renamed = await repository.patch({
      id: b.id,
      updates: { displayName: 'renamed', updatedAt: 3 },
      subjectClaimChanges: false,
    })
    expect(renamed).toMatchObject({ ok: true, value: { id: b.id, displayName: 'renamed' } })
    expect((await repository.findById(b.id))?.displayName).toBe('renamed')

    // 密码登录已关闭 ⇒ 不能停用最后一个启用的 provider；开第二个之后就可以。
    await db
      .insert(authLoginPolicy)
      .values({ id: 'global', passwordLoginEnabled: false, oidcDefaultRole: 'user', updatedAt: 1 })
      .onConflictDoUpdate({ target: authLoginPolicy.id, set: { passwordLoginEnabled: false } })
    expect(
      await repository.patch({
        id: a.id,
        updates: { enabled: false, updatedAt: 4 },
        subjectClaimChanges: false,
      }),
    ).toEqual({ ok: false, code: 'last-enabled-oidc-required' })
    expect(await repository.remove({ id: a.id, force: false })).toEqual({
      ok: false,
      code: 'last-enabled-oidc-required',
    })
    expect(
      (
        await repository.patch({
          id: b.id,
          updates: { enabled: true, updatedAt: 5 },
          subjectClaimChanges: false,
        })
      ).ok,
    ).toBe(true)
    expect(
      (
        await repository.patch({
          id: a.id,
          updates: { enabled: false, updatedAt: 6 },
          subjectClaimChanges: false,
        })
      ).ok,
    ).toBe(true)

    // 已有身份挂在 provider 上 ⇒ subject claim 锁定，删除需要 force。
    const userId = await seedUser(db)
    await db.insert(userIdentities).values({
      id: `ident_${ulid()}`,
      userId,
      providerId: b.id,
      subject: 'sub-1',
      email: null,
      emailVerified: 0,
      linkedAt: 7,
    })
    expect(
      await repository.patch({
        id: b.id,
        updates: { subjectClaim: 'uid', updatedAt: 8 },
        subjectClaimChanges: true,
      }),
    ).toEqual({ ok: false, code: 'subject-claim-locked-by-identities' })
    expect(
      (
        await repository.patch({
          id: b.id,
          updates: { subjectClaim: 'uid', updatedAt: 9 },
          subjectClaimChanges: false,
        })
      ).ok,
    ).toBe(true)
    // b 现在是唯一启用的 provider，先恢复 a，再删 b。
    await repository.patch({
      id: a.id,
      updates: { enabled: true, updatedAt: 10 },
      subjectClaimChanges: false,
    })
    expect(await repository.remove({ id: b.id, force: false })).toEqual({
      ok: false,
      code: 'provider-still-linked',
    })
    expect(await repository.remove({ id: b.id, force: true })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await repository.findById(b.id)).toBeNull()
    expect(
      (await db.select().from(userIdentities).where(eq(userIdentities.providerId, b.id))).length,
    ).toBe(0)
    expect(await repository.remove({ id: 'missing', force: false })).toEqual({
      ok: false,
      code: 'oidc-provider-not-found',
    })
  })
})

describeEachProvider('RFC-359 W4-B4c —— 记忆蒸馏工作存储', (harness) => {
  test('入队 / 到期与同键列表 / 状态推进 / 恢复与重试 / 取消 / 提示与结果落库 / 候选写入 / 任务范围', async () => {
    const db = harness.db
    const captured: string[] = []
    const store = new DrizzleMemoryDistillWorkStore(db, async (input) => {
      captured.push(input.distillJobId)
    })
    const debounceKey = `k_${ulid()}`
    const scope = { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
    const job1 = `job_${ulid()}`
    const job2 = `job_${ulid()}`
    for (const [id, nextRunAt, createdAt] of [
      [job1, 10, 1],
      [job2, 50, 2],
    ] as const) {
      await store.enqueue({
        id,
        debounceKey,
        sourceKind: 'feedback',
        sourceEventId: `evt_${id}`,
        taskId: null,
        scope,
        nextRunAt,
        createdAt,
        outputLang: 'zh-CN',
      })
    }
    expect((await store.listDue(20, 10)).map((row) => row.id)).toEqual([job1])
    expect((await store.listDue(60, 1)).map((row) => row.id)).toEqual([job1])
    expect((await store.listPendingSiblings(debounceKey)).map((row) => row.id)).toEqual([
      job1,
      job2,
    ])

    await store.markRunning([job1], 11)
    expect((await store.listJobs('running')).map((row) => row.id)).toEqual([job1])
    expect((await store.listPendingSiblings(debounceKey)).map((row) => row.id)).toEqual([job2])
    expect(await store.recoverRunning()).toBe(1)
    expect((await store.listJobs('running')).length).toBe(0)

    await store.markRunning([job1], 12)
    await store.markFailed({ ids: [job1], attempts: 1, error: 'retry me', retryAt: 30, now: 13 })
    expect((await store.listDue(29, 10)).map((row) => row.id)).toEqual([])
    expect((await store.listDue(30, 10)).map((row) => row.id)).toEqual([job1])
    await store.markFailed({ ids: [job1], attempts: 2, error: 'give up', retryAt: null, now: 14 })
    expect((await store.listJobs('failed')).map((row) => row.id)).toEqual([job1])
    expect((await store.retryFailed(job1, 15))?.attempts).toBe(0)
    expect(await store.retryFailed(job1, 16)).toBeNull()
    expect(await store.cancelPending(job2, 17)).toBe(true)
    expect(await store.cancelPending(job2, 18)).toBe(false)
    await store.markDone([job1], 19)
    expect((await store.listJobs()).map((row) => row.status)).toEqual(['done', 'canceled'])

    await store.savePrompt(job1, '# prompt', '["m1"]')
    await store.saveSpawnResult(job1, { sessionId: 'ses-1', exitCode: 0, stderrExcerpt: null })
    const job = (await db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, job1)))[0]
    expect(job).toMatchObject({
      userPromptMd: '# prompt',
      dedupSnapshotIdsJson: '["m1"]',
      opencodeSessionId: 'ses-1',
      exitCode: 0,
    })
    await store.captureSession({
      distillJobId: job1,
      attemptIndex: 0,
      rootSessionId: 'ses-1',
      protocol: 'opencode',
    })
    expect(captured).toEqual([job1])

    const memoryId = `m_${ulid()}`
    await store.insertCandidate({
      memory: {
        id: memoryId,
        scopeType: 'global',
        scopeId: null,
        title: 'candidate',
        bodyMd: 'body',
        tags: ['x'],
        sourceKind: 'feedback',
        sourceEventId: `evt_${job1}`,
        sourceTaskId: null,
        distillJobId: job1,
        distillAction: 'new',
        supersedesId: null,
        supersededById: null,
        approvedByUserId: null,
        approvedAt: null,
        fusedIntoSkillId: null,
        status: 'candidate',
        version: 1,
        createdAt: 20,
      },
    })
    const candidate = (await db.select().from(memories).where(eq(memories.id, memoryId)))[0]
    expect(candidate).toMatchObject({ status: 'candidate', tags: '["x"]', version: 1 })
    expect(await store.listApprovedMemories('global', null)).toEqual([])
    await db
      .update(memories)
      .set({ status: 'approved', approvedAt: 21 })
      .where(eq(memories.id, memoryId))
    expect(await store.listApprovedMemories('global', null)).toEqual([
      { id: memoryId, title: 'candidate', bodyMd: 'body', tagsJson: '["x"]' },
    ])

    const owner = await seedUser(db)
    const workflowId = `wf_${ulid()}`
    await db.insert(workflows).values({
      id: workflowId,
      name: workflowId,
      description: '',
      definition: SNAPSHOT,
      version: 1,
      schemaVersion: 2,
    })
    const repoId = `cr_${ulid()}`
    await db.insert(cachedRepos).values({
      id: repoId,
      urlHash: `h_${repoId}`,
      urlRedacted: 'https://example.invalid/repo.git',
      urlEnc: null,
      localPath: `/tmp/mirror/${repoId}`,
      lastFetchedAt: 1,
      createdAt: 1,
    })
    const taskId = `t_${ulid()}`
    await db.insert(tasks).values({
      id: taskId,
      name: taskId,
      workflowId,
      workflowSnapshot: SNAPSHOT,
      repoPath: '/tmp/repo',
      worktreePath: `/tmp/worktree/${taskId}`,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ownerUserId: owner,
      cachedRepoId: repoId,
    })
    expect(await store.findTaskScope(taskId)).toEqual({
      workflowSnapshot: SNAPSHOT,
      workgroupConfigJson: null,
      workflowId,
      cachedRepoId: repoId,
      cachedRepoExists: true,
    })
    expect(await store.findTaskScope('missing')).toBeNull()
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'n',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      promptText: 'hello',
    })
    expect(await store.listNodeRuns([runId, 'missing'])).toEqual([
      {
        id: runId,
        promptText: 'hello',
        promptPath: null,
        startedAt: null,
        opencodeSessionId: null,
      },
    ])
    expect(await store.listNodeRuns([])).toEqual([])
    const feedbackId = `fb_${ulid()}`
    await db.insert(taskFeedback).values({
      id: feedbackId,
      taskId,
      authorUserId: owner,
      bodyMd: 'fb',
      createdAt: 3,
      distilled: 0,
    })
    expect(await store.listFeedbackSources([feedbackId])).toEqual([
      { id: feedbackId, taskId, bodyMd: 'fb', createdAt: 3 },
    ])
    expect(await store.listClarifySources([])).toEqual([])
    expect(await store.listReviewSources(['missing'])).toEqual([])
    expect(await store.listReviewComments(['missing'])).toEqual([])
    expect(await store.listNodeRunEvents(['missing'])).toEqual([])
  })
})

test('源码锁：provider 命名的孪生实现不得复活', () => {
  const modules = resolve(import.meta.dir, '..', 'src', 'modules')
  for (const [context, stem] of [
    ['identity-access', 'OidcProviderRepository'],
    ['memory', 'MemoryDistillWorkStore'],
  ] as const) {
    for (const provider of ['sqlite', 'postgresql']) {
      expect(existsSync(resolve(modules, context, 'infrastructure', `${provider}${stem}.ts`))).toBe(
        false,
      )
    }
  }
})
