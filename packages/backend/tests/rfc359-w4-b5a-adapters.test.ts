// RFC-359 W4-B5 批 a —— code-capability / development-automation 九对机械合一的适配器，两个引擎各跑一遍：
// 能力模板持久化（同 owner 撞名经引擎能力矩阵归类成 ConflictError）、仓库能力参数读取、就绪度事实读取、
// 端点 / 连接事实读取、演示种子幂等落库、代码工作区读取（未启动 run 两个引擎都排最前）、轮次尝试投影
// （bigint 列回 number 不回字符串）、RFC-310 cutover 状态 upsert 与 legacy link、数字员工工作区持久化。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  cachedRepos,
  codeAiAttempts,
  codeHostConnections,
  codeRoundStages,
  developmentMissions,
  employeeCases,
  employeeReactionRounds,
  legacyCodeWorkItemLinks,
  nodeRuns,
  repoCapabilityConfig,
  taskRepos,
  tasks,
  users,
  webhookEndpoints,
  webhookTriggers,
} from '@/db/schema'
import type { CapabilityTemplateRecord } from '@/modules/code-capability/application/ports/capabilityTemplatePersistence'
import { createCapabilityParamRead } from '@/modules/code-capability/infrastructure/capabilityParamRead'
import { createCapabilityTemplatePersistence } from '@/modules/code-capability/infrastructure/capabilityTemplatePersistence'
import { createCodeWorkspaceRead } from '@/modules/code-capability/infrastructure/codeWorkspaceRead'
import { createCodeCapabilityDemoSeedPersistence } from '@/modules/code-capability/infrastructure/demoSeedPersistence'
import { createReadinessFactsRead } from '@/modules/code-capability/infrastructure/readinessFactsRead'
import { createRepoEndpointRead } from '@/modules/code-capability/infrastructure/repoEndpointRead'
import { createRoundAttemptsRead } from '@/modules/code-capability/infrastructure/roundAttemptsRead'
import { INITIAL_CUTOVER_STATE } from '@/modules/development-automation/domain/cutover'
import { createCutoverStore } from '@/modules/development-automation/infrastructure/cutoverStore'
import { createEmployeeWorkspacePersistence } from '@/modules/development-automation/infrastructure/employeeWorkspacePersistence'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function seedUser(db: ProviderNeutralDatabase): Promise<string> {
  const id = `u_b5a_${ulid()}`
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

function template(
  id: string,
  over: Partial<CapabilityTemplateRecord> = {},
): CapabilityTemplateRecord {
  return {
    id,
    name: id,
    description: null,
    capability: 'mr-review',
    scriptsJson: '[]',
    hooksJson: '[]',
    paramSchemaJson: '[]',
    paramDefaultsJson: '{}',
    agentBySlotJson: '{}',
    promptBySlotJson: '{}',
    paramsJson: '{}',
    stageContractVer: 1,
    ownerUserId: null,
    visibility: 'private',
    builtin: false,
    aclRevision: 0,
    upstreamId: null,
    upstreamVersion: null,
    baseDigest: null,
    baseSnapshotJson: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/b5a',
    worktreePath: `/tmp/b5a/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
  })
}

describeEachProvider(
  'RFC-359 W4-B5a —— code-capability / development-automation 机械合一适配器',
  (harness) => {
    test('能力模板持久化 / 参数读取 / 就绪度与端点事实 / 演示种子', async () => {
      const db = harness.db
      const owner = await seedUser(db)
      const persistence = createCapabilityTemplatePersistence(db)

      await persistence.insert(
        template('tpl-a', {
          ownerUserId: owner,
          paramSchemaJson: '[{"name":"x","kind":"number","required":false}]',
          paramDefaultsJson: '{"x":1}',
          paramsJson: '{"x":2}',
          agentBySlotJson: JSON.stringify({ reviewer: 'agent-b5a' }),
        }),
      )
      expect((await persistence.load('tpl-a'))?.name).toBe('tpl-a')
      expect((await persistence.list()).map((row) => row.id)).toContain('tpl-a')
      expect(
        await persistence.ownerNameExists({ ownerUserId: owner, name: 'tpl-a', excludeId: null }),
      ).toBe(true)
      expect(
        await persistence.ownerNameExists({
          ownerUserId: owner,
          name: 'tpl-a',
          excludeId: 'tpl-a',
        }),
      ).toBe(false)
      expect(
        await persistence.ownerNameExists({ ownerUserId: null, name: 'tpl-a', excludeId: null }),
      ).toBe(false)

      // 同 owner 撞名：两个引擎的唯一冲突都经能力矩阵归类成同一个 ConflictError。
      await expect(
        persistence.insert(template('tpl-dup', { ownerUserId: owner, name: 'tpl-a' })),
      ).rejects.toBeInstanceOf(ConflictError)
      await persistence.insert(template('tpl-b', { ownerUserId: owner }))
      await expect(
        persistence.replace(template('tpl-b', { ownerUserId: owner, name: 'tpl-a' })),
      ).rejects.toMatchObject({ code: 'capability-template-name-taken' })
      await persistence.replace(template('tpl-b', { ownerUserId: owner, description: 'renamed' }))
      expect((await persistence.load('tpl-b'))?.description).toBe('renamed')
      await persistence.delete('tpl-b')
      expect(await persistence.load('tpl-b')).toBeNull()

      // 仓库能力格 → 模板参数三元组。
      await db.insert(repoCapabilityConfig).values({
        id: ulid(),
        repoId: 'repo-b5a',
        capability: 'mr-review',
        templateId: 'tpl-a',
        enabled: true,
        readiness: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      const params = createCapabilityParamRead(db)
      expect(await params.find({ repoId: 'repo-b5a', capability: 'mr-review' })).toEqual({
        paramSchemaJson: '[{"name":"x","kind":"number","required":false}]',
        paramDefaultsJson: '{"x":1}',
        paramsJson: '{"x":2}',
      })
      expect(await params.find({ repoId: 'repo-b5a', capability: 'requirement' })).toBeNull()

      // 就绪度事实：模板存在性、槽位代理可见性、能力触发器。
      const facts = createReadinessFactsRead(db)
      expect(await facts.templateExists('tpl-a')).toBe(true)
      expect(await facts.templateExists('missing')).toBe(false)
      expect(await facts.agentSlotVisible({ templateId: 'tpl-a', slot: 'reviewer' })).toBe(false)
      await db.insert(agents).values({
        id: 'agent-b5a',
        name: 'agent-b5a',
        description: 'test',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(await facts.agentSlotVisible({ templateId: 'tpl-a', slot: 'reviewer' })).toBe(true)
      expect(await facts.agentSlotVisible({ templateId: 'tpl-a', slot: 'author' })).toBe(false)
      expect(await facts.agentSlotVisible({ templateId: 'missing', slot: 'reviewer' })).toBe(false)
      await db.insert(webhookEndpoints).values([
        {
          id: 'ep-b5a',
          name: 'ep',
          provider: 'gitlab',
          urlToken: 'aw_whk_b5a',
          secretEnc: 'sealed',
          enabled: true,
        },
        {
          id: 'ep-b5a-off',
          name: 'ep-off',
          provider: 'github',
          urlToken: 'aw_whk_b5a_off',
          secretEnc: 'sealed',
          enabled: false,
        },
      ])
      const trigger = (id: string, launchKind: 'code-round' | 'workflow', launchRefId: string) => ({
        id,
        name: id,
        endpointId: 'ep-b5a',
        ownerUserId: owner,
        repoScope: '{"kind":"all"}',
        eventTypes: '["merge_request"]',
        launchKind,
        launchRefId,
        launchPayload: '{}',
      })
      await db
        .insert(webhookTriggers)
        .values([
          trigger('tr-b5a', 'code-round', 'mr-review'),
          trigger('tr-b5a-other', 'code-round', 'requirement'),
          trigger('tr-b5a-wf', 'workflow', 'wf-1'),
        ])
      expect(
        (await facts.listCapabilityTriggers({ endpointId: 'ep-b5a', capability: 'mr-review' })).map(
          (row) => row.id,
        ),
      ).toEqual(['tr-b5a'])
      expect(await facts.repoEndpoints.listEnabledEndpoints()).toEqual([
        { id: 'ep-b5a', provider: 'gitlab' },
      ])

      // 端点 / 连接事实读取。
      const endpoints = createRepoEndpointRead(db)
      await db.insert(cachedRepos).values({
        id: 'repo-b5a',
        urlHash: 'b5a00001',
        urlRedacted: 'https://gitlab.invalid/g/p',
        localPath: '/tmp/b5a/repo-b5a',
        lastFetchedAt: NOW,
        createdAt: NOW,
      })
      expect(await endpoints.readRepoUrl('repo-b5a')).toBe('https://gitlab.invalid/g/p')
      expect(await endpoints.readRepoUrl('nope')).toBeNull()
      await db.insert(codeHostConnections).values({
        provider: 'gitlab',
        baseUrl: 'https://gitlab.invalid/api/v4',
        repositoryUrlPrefixesJson: '["https://gitlab.invalid/"]',
        tokenEnc: 'enc',
        tokenHint: '1234',
        updatedAt: NOW,
      })
      expect(await endpoints.listConnections()).toEqual([
        {
          provider: 'gitlab',
          baseUrl: 'https://gitlab.invalid/api/v4',
          repositoryUrlPrefixesJson: '["https://gitlab.invalid/"]',
        },
      ])

      // 演示种子：一次事务落模板 + 历史，重复 ensure 不覆盖既有行。
      const seed = createCodeCapabilityDemoSeedPersistence(db)
      const aggregate = {
        template: template('tpl-demo', { ownerUserId: owner }),
        history: {
          workItem: {
            id: 'wi-demo',
            codeHostEndpointId: 'ep-b5a',
            stableProjectId: 'demo/sample',
            capability: 'mr-review',
            anchorKind: 'mr' as const,
            anchorId: '42',
            status: 'settled' as const,
            epoch: 1,
            currentRoundId: 'round-demo',
            createdAt: NOW,
            updatedAt: NOW,
          },
          round: {
            id: 'round-demo',
            workItemId: 'wi-demo',
            roundSeq: 1,
            epoch: 1,
            baselineSha: '0000000000000000000000000000000000000000',
            stageContractVer: 1,
            outcome: 'published' as const,
            startedAt: NOW,
            endedAt: NOW + 1,
          },
          stages: [0, 1].map((index) => ({
            id: `round-demo-${String(index)}`,
            roundId: 'round-demo',
            stageSeq: index,
            stageName: `stage-${String(index)}`,
            stageKind: 'ai' as const,
            status: 'done' as const,
            startedAt: NOW + index,
            endedAt: NOW + index + 1,
          })),
        },
      }
      await seed.ensure(aggregate)
      await seed.ensure({
        ...aggregate,
        template: { ...aggregate.template, description: 'must not overwrite' },
      })
      expect((await persistence.load('tpl-demo'))?.description).toBeNull()
      expect(
        (await db.select().from(codeRoundStages).where(eq(codeRoundStages.roundId, 'round-demo')))
          .length,
      ).toBe(2)
      await seed.ensure({
        template: template('tpl-demo-bare', { ownerUserId: owner }),
        history: null,
      })
      expect(await persistence.load('tpl-demo-bare')).not.toBeNull()
    })

    test('代码工作区读取 / 轮次尝试投影', async () => {
      const db = harness.db
      const read = createCodeWorkspaceRead(db)
      expect(await read.findTask('missing')).toBeNull()

      await seedTask(db, 'task-b5a')
      // 无 task_repos 行：退回任务级工作树。
      expect(await read.findTask('task-b5a')).toMatchObject({
        id: 'task-b5a',
        status: 'running',
        repos: [
          {
            mountPath: '',
            worktreeDirName: '',
            worktreePath: '/tmp/b5a/task-b5a',
            baseCommit: null,
          },
        ],
      })
      await db.insert(taskRepos).values([
        {
          taskId: 'task-b5a',
          repoIndex: 1,
          repoPath: '/tmp/b5a/second',
          branch: 'agent-workflow/x',
          worktreePath: '/tmp/b5a/task-b5a/second',
          worktreeDirName: 'second',
        },
        {
          taskId: 'task-b5a',
          repoIndex: 0,
          repoPath: '/tmp/b5a/first',
          branch: 'agent-workflow/x',
          worktreePath: '/tmp/b5a/task-b5a/first',
          worktreeDirName: 'first',
        },
      ])
      expect((await read.findTask('task-b5a'))?.repos.map((repo) => repo.worktreeDirName)).toEqual([
        'first',
        'second',
      ])

      const run = (id: string, over: { startedAt?: number; status?: 'pending' | 'done' }) => ({
        id,
        taskId: 'task-b5a',
        nodeId: 'n',
        status: over.status ?? ('done' as const),
        retryIndex: 0,
        iteration: 0,
        ...(over.startedAt === undefined ? {} : { startedAt: over.startedAt }),
      })
      await db
        .insert(nodeRuns)
        .values([
          run('nr-b5a-late', { startedAt: NOW + 5 }),
          run('nr-b5a-early', { startedAt: NOW }),
          run('nr-b5a-unstarted', { status: 'pending' }),
        ])
      // 未启动的 run（started_at NULL）两个引擎都排最前。
      expect((await read.listNodeRuns('task-b5a')).map((row) => row.id)).toEqual([
        'nr-b5a-unstarted',
        'nr-b5a-early',
        'nr-b5a-late',
      ])
      expect(await read.findNodeRun('nr-b5a-late')).toMatchObject({
        id: 'nr-b5a-late',
        startedAt: NOW + 5,
        preSnapshot: null,
      })
      expect(await read.findNodeRun('missing')).toBeNull()

      const attempts = createRoundAttemptsRead(db)
      const attempt = (id: string, over: Partial<typeof codeAiAttempts.$inferInsert>) => ({
        id,
        roundId: 'round-b5a',
        stageName: 'review-shard',
        shardKey: '',
        rerunSeq: 0,
        attemptSeq: 0,
        status: 'validated' as const,
        startedAt: NOW,
        ...over,
      })
      // id 顺序与时间线相反：按 started_at / rerun / attempt 排序才是真序。
      await db
        .insert(codeAiAttempts)
        .values([
          attempt('zz-first', { status: 'failed' }),
          attempt('mm-second', { rerunSeq: 1, startedAt: NOW + 10, status: 'failed' }),
          attempt('aa-third', { attemptSeq: 1, startedAt: NOW + 20, endedAt: NOW + 30 }),
        ])
      expect((await attempts.load('round-b5a', 10)).map((row) => row.attemptId)).toEqual([
        'zz-first',
        'mm-second',
        'aa-third',
      ])
      expect((await attempts.load('round-b5a', 2)).length).toBe(2)
      expect((await attempts.load('round-b5a', 10))[2]).toEqual({
        attemptId: 'aa-third',
        stageName: 'review-shard',
        shardKey: '',
        rerunSeq: 0,
        attemptSeq: 1,
        status: 'validated',
        validationOutcome: null,
        sessionRef: null,
        nodeRunId: null,
        startedAt: NOW + 20,
        endedAt: NOW + 30,
      })
      expect(await attempts.load('round-none', 10)).toEqual([])
    })

    test('cutover 状态与 legacy link / 数字员工工作区持久化', async () => {
      const db = harness.db
      const cutover = createCutoverStore(db)
      expect(await cutover.readState()).toEqual(INITIAL_CUTOVER_STATE)
      await cutover.writeState(
        { phase: 'frozen', frozenAt: NOW, flippedAt: null, generation: null },
        NOW,
      )
      await cutover.writeState(
        { phase: 'live', frozenAt: NOW, flippedAt: NOW + 1, generation: 'g1' },
        NOW + 1,
      )
      expect(await cutover.readState()).toEqual({
        phase: 'live',
        frozenAt: NOW,
        flippedAt: NOW + 1,
        generation: 'g1',
      })
      await db.insert(developmentMissions).values({
        id: 'm-b5a',
        status: 'working',
        repositoryId: 'repo-1',
        sourceKind: 'direct',
        deliveryKind: 'create-merge-request',
        launchIdempotencyKey: 'idem-b5a',
        createdAt: NOW,
        updatedAt: NOW,
      })
      await cutover.insertLegacyLink({
        id: 'link-b5a',
        missionId: 'm-b5a',
        legacyWorkItemId: 'wi-1',
        legacyRoundId: null,
        cutoverReceiptJson: '{"from":"legacy"}',
        now: NOW,
      })
      expect(
        (
          await db
            .select()
            .from(legacyCodeWorkItemLinks)
            .where(eq(legacyCodeWorkItemLinks.id, 'link-b5a'))
        )[0],
      ).toMatchObject({
        missionId: 'm-b5a',
        legacyWorkItemId: 'wi-1',
        legacyRoundId: null,
        cutoverReceiptJson: '{"from":"legacy"}',
        createdAt: NOW,
      })

      const workspaces = createEmployeeWorkspacePersistence(db)
      await db.insert(employeeCases).values({
        id: 'case-b5a',
        name: 'case',
        employeeId: 'employee-1',
        employeeRevision: 1,
        typeId: 'development',
        typeRevision: 1,
        primaryContextId: 'ctx-1',
        executionPolicyRevision: 1,
        state: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(await workspaces.workspace('case-b5a')).toBeNull()
      await db.insert(cachedRepos).values({
        id: 'crepo-b5a',
        urlHash: 'b5a00002',
        localPath: '/tmp/b5a/crepo',
        lastFetchedAt: NOW,
        createdAt: NOW,
      })
      await workspaces.insertWorkspace({
        caseId: 'case-b5a',
        repositoryId: 'repo-1',
        cachedRepoId: 'crepo-b5a',
        baselineSha: 'abc',
        targetBranch: 'main',
        sourceBranch: 'aw/case-b5a',
        remoteHeadSha: null,
        state: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(await workspaces.workspace('case-b5a')).toMatchObject({
        cachedRepoId: 'crepo-b5a',
        sourceBranch: 'aw/case-b5a',
        state: 'active',
      })
      expect(await workspaces.repositoryLocalPath('crepo-b5a')).toBe('/tmp/b5a/crepo')
      expect(await workspaces.repositoryLocalPath('nope')).toBeNull()

      await db.insert(employeeReactionRounds).values({
        id: 'round-b5a',
        caseId: 'case-b5a',
        caseRevision: 1,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'rule-1',
        workItemRef: 'analyze',
        workContractId: 'contract-1',
        workContractVersion: 1,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        state: 'running',
        attemptOrdinal: 0,
        planJson: '{}',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(await workspaces.latestRoundState('round-b5a')).toBeNull()
      const state = (attemptOrdinal: number, checkpointDigest: string) => ({
        roundId: 'round-b5a',
        attemptOrdinal,
        caseId: 'case-b5a',
        baselineSha: 'abc',
        preStateJson: '{}',
        checkpointDigest,
        validationJson: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await workspaces.insertRoundState(state(0, 'd0'), 'error')
      await workspaces.insertRoundState(state(0, 'd0-ignored'), 'ignore')
      await expect(workspaces.insertRoundState(state(0, 'd0-error'), 'error')).rejects.toBeDefined()
      expect((await workspaces.roundState('round-b5a', 0))?.checkpointDigest).toBe('d0')
      await workspaces.upsertRoundState(state(1, 'd1'))
      await workspaces.upsertRoundState({ ...state(1, 'd1-upserted'), updatedAt: NOW + 1 })
      expect(await workspaces.latestRoundState('round-b5a')).toMatchObject({
        attemptOrdinal: 1,
        checkpointDigest: 'd1-upserted',
        updatedAt: NOW + 1,
      })
      await workspaces.updateRoundState({
        roundId: 'round-b5a',
        attemptOrdinal: 1,
        patch: { validationJson: '{"ok":true}', updatedAt: NOW + 2 },
      })
      expect(await workspaces.roundState('round-b5a', 1)).toMatchObject({
        validationJson: '{"ok":true}',
        updatedAt: NOW + 2,
      })
      expect((await workspaces.roundState('round-b5a', 0))?.validationJson).toBeNull()
      expect(await workspaces.roundState('round-b5a', 9)).toBeNull()
    })
  },
)
