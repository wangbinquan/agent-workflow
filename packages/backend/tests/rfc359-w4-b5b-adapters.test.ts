// RFC-359 W4-B5 批 b —— code-capability 四对（评审人解析读取 / 工作项投影 / 投递链读取 / 模板上游持久化）+
// digital-employee 一对（反应轮次查询）合一，两个引擎各跑一遍：NULL settled_at 两引擎都排最后、count() 回 number、
// 分页游标、模板上游的锁定读 + 决策 + 落补丁在一个事务里。

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  capabilityTemplates,
  codeRoundStages,
  codeTriggerDeliveries,
  codeWorkItems,
  codeWorkRounds,
  employeeCases,
  employeeReactionRounds,
  repoCapabilityConfig,
} from '@/db/schema'
import type { TemplateUpstreamMergePatch } from '@/modules/code-capability/application/ports/templateUpstreamPersistence'
import { createDeliveryChainRead } from '@/modules/code-capability/infrastructure/deliveryChainRead'
import { DrizzleReviewerResolutionRead } from '@/modules/code-capability/infrastructure/reviewerResolutionRead'
import { createTemplateUpstreamPersistence } from '@/modules/code-capability/infrastructure/templateUpstreamPersistence'
import { createWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/workItemProjectionRead'
import { createReactionRoundQueries } from '@/modules/digital-employee/infrastructure/reactionRoundQueries'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

function template(id: string, over: Partial<typeof capabilityTemplates.$inferInsert> = {}) {
  return {
    id,
    name: id,
    capability: 'mr-review',
    agentBySlotJson: JSON.stringify({ reviewer: 'agent-b5b' }),
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

async function seedWorkItem(
  db: ProviderNeutralDatabase,
  id: string,
  createdAt: number,
  rounds: number,
): Promise<void> {
  await db.insert(codeWorkItems).values({
    id,
    codeHostEndpointId: 'ep-b5b',
    stableProjectId: 'proj-b5b',
    capability: 'mr-review',
    anchorKind: 'mr',
    anchorId: `mr-${id}`,
    status: 'idle',
    epoch: 1,
    createdAt,
    updatedAt: createdAt,
  })
  if (rounds === 0) return
  await db.insert(codeWorkRounds).values(
    Array.from({ length: rounds }, (_, index) => ({
      id: `${id}-r${String(index + 1)}`,
      workItemId: id,
      roundSeq: index + 1,
      epoch: 1,
      outcome: 'published' as const,
      startedAt: createdAt + index,
      endedAt: createdAt + index + 1,
    })),
  )
}

describeEachProvider(
  'RFC-359 W4-B5b —— code-capability / digital-employee 读取与上游持久化',
  (harness) => {
    test('评审人解析读取 / 反应轮次查询', async () => {
      const db = harness.db
      const reviewer = new DrizzleReviewerResolutionRead(db)
      expect(
        await reviewer.loadRepositoryCapability({
          repositoryId: 'repo-b5b',
          capability: 'mr-review',
        }),
      ).toBeNull()
      await db.insert(capabilityTemplates).values(template('tpl-b5b'))
      await db.insert(repoCapabilityConfig).values({
        id: ulid(),
        repoId: 'repo-b5b',
        capability: 'mr-review',
        templateId: 'tpl-b5b',
        enabled: true,
        readiness: 'ready',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(
        await reviewer.loadRepositoryCapability({
          repositoryId: 'repo-b5b',
          capability: 'mr-review',
        }),
      ).toEqual({
        templateId: 'tpl-b5b',
      })
      expect(await reviewer.loadTemplate('tpl-b5b')).toEqual({
        agentBySlotJson: JSON.stringify({ reviewer: 'agent-b5b' }),
      })
      expect(await reviewer.loadTemplate('missing')).toBeNull()
      expect(await reviewer.loadAgent('agent-b5b')).toBeNull()
      await db.insert(agents).values({
        id: 'agent-b5b',
        name: 'agent-b5b',
        description: 'test',
        outputs: '[]',
        permission: '{}',
        skills: '[]',
        frontmatterExtra: '{}',
        bodyMd: '',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect((await reviewer.loadAgent('agent-b5b'))?.name).toBe('agent-b5b')

      const rounds = createReactionRoundQueries(db)
      expect(await rounds.frozenPlan('missing')).toBeNull()
      expect(
        await rounds.lastSettledRound({ caseId: 'case-b5b', workItemRef: 'analyze' }),
      ).toBeNull()
      await db.insert(employeeCases).values({
        id: 'case-b5b',
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
      const round = (
        id: string,
        state: 'completed' | 'running',
        settledAt: number | null,
        workItemRef = 'analyze',
      ) => ({
        id,
        caseId: 'case-b5b',
        caseRevision: 1,
        employeeId: 'employee-1',
        employeeRevision: 1,
        ruleId: 'rule-1',
        workItemRef,
        workContractId: 'contract-1',
        workContractVersion: 1,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify({ roundRef: id }),
        state,
        attemptOrdinal: 0,
        createdAt: NOW,
        updatedAt: NOW,
        ...(settledAt === null ? {} : { settledAt }),
      })
      await db
        .insert(employeeReactionRounds)
        .values([
          round('rd-early', 'completed', NOW + 10),
          round('rd-late', 'completed', NOW + 20),
          round('rd-unsettled', 'completed', null),
          round('rd-running', 'running', NOW + 30),
          round('rd-other-item', 'completed', NOW + 40, 'implement'),
        ])
      expect(await rounds.frozenPlan('rd-early')).toEqual({
        caseId: 'case-b5b',
        planJson: JSON.stringify({ roundRef: 'rd-early' }),
      })
      // 最近结算的排最前；settled_at 为 NULL 的行两个引擎都排最后。
      expect(await rounds.lastSettledRound({ caseId: 'case-b5b', workItemRef: 'analyze' })).toEqual(
        {
          roundRef: 'rd-late',
        },
      )
      expect(
        await rounds.lastSettledRound({ caseId: 'case-b5b', workItemRef: 'implement' }),
      ).toEqual({
        roundRef: 'rd-other-item',
      })
      expect(
        await rounds.lastSettledRound({ caseId: 'case-b5b', workItemRef: 'review' }),
      ).toBeNull()
    })

    test('投递链读取 / 工作项投影分页', async () => {
      const db = harness.db
      const deliveries = createDeliveryChainRead(db)
      const delivery = (
        id: string,
        over: Partial<typeof codeTriggerDeliveries.$inferInsert> & { readonly createdAt: number },
      ) => ({
        id,
        correlationId: `corr-${id}`,
        stableProjectId: 'proj-b5b',
        capability: 'mr-review',
        step: 'queued',
        outcome: 'ok',
        updatedAt: over.createdAt,
        ...over,
      })
      await db
        .insert(codeTriggerDeliveries)
        .values([
          delivery('d1', { createdAt: NOW, outcome: 'failed', reason: 'boom', queuePosition: 3 }),
          delivery('d2', { createdAt: NOW + 1, step: 'published' }),
          delivery('d3', { createdAt: NOW + 2, outcome: 'failed', correlationId: 'corr-d1' }),
          delivery('d4', { createdAt: NOW + 3, outcome: 'failed', stableProjectId: 'proj-other' }),
          delivery('d5', { createdAt: NOW + 4, outcome: 'dropped', stableProjectId: 'proj-other' }),
        ])
      expect(
        (await deliveries.recent({ stableProjectId: 'proj-b5b' })).map((row) => row.id),
      ).toEqual(['d3', 'd2', 'd1'])
      expect(
        (await deliveries.recent({ stableProjectId: 'proj-b5b', limit: 2 })).map((row) => row.id),
      ).toEqual(['d3', 'd2'])
      expect((await deliveries.byCorrelation('corr-d1')).map((row) => row.id)).toEqual(['d3', 'd1'])
      expect(
        (await deliveries.failures({ stableProjectId: 'proj-b5b' })).map((row) => row.id),
      ).toEqual(['d3', 'd1'])
      expect((await deliveries.failures({})).map((row) => row.id)).toEqual(['d4', 'd3', 'd1'])
      expect((await deliveries.byCorrelation('corr-d1'))[1]).toEqual({
        id: 'd1',
        correlationId: 'corr-d1',
        capability: 'mr-review',
        step: 'queued',
        outcome: 'failed',
        reason: 'boom',
        queuedAt: null,
        queuePosition: 3,
        waitingOn: null,
        roundId: null,
        isProbe: false,
        createdAt: NOW,
        updatedAt: NOW,
      })

      const projection = createWorkItemProjectionRead(db)
      expect(await projection.readPage({})).toEqual({ items: [], nextCursor: null })
      await seedWorkItem(db, 'wi-old', NOW, 3)
      await seedWorkItem(db, 'wi-new', NOW + 100, 0)
      await db.insert(codeRoundStages).values([
        {
          id: 's-b',
          roundId: 'wi-old-r3',
          stageSeq: 1,
          stageName: 'review',
          stageKind: 'ai',
          status: 'done',
        },
        {
          id: 's-a',
          roundId: 'wi-old-r3',
          stageSeq: 0,
          stageName: 'prepare-worktree',
          stageKind: 'program',
          status: 'done',
        },
      ])
      const first = await projection.readPage({ limit: 1, roundLimit: 2 })
      expect(first.items.map((item) => item.workItemId)).toEqual(['wi-new'])
      expect(first.items[0]).toMatchObject({ rounds: [], roundsHidden: 0, epoch: 1 })
      expect(first.nextCursor).not.toBeNull()
      const second = await projection.readPage({
        limit: 1,
        roundLimit: 2,
        cursor: first.nextCursor,
      })
      expect(second.nextCursor).toBeNull()
      const old = second.items[0]
      expect(old?.workItemId).toBe('wi-old')
      // 轮次窗口：3 轮取最近 2 轮，隐藏 1（count() 必须回 number，否则这里算不出 1）。
      expect(old?.roundsHidden).toBe(1)
      expect(old?.rounds.map((round) => round.roundSeq)).toEqual([3, 2])
      expect(old?.rounds[0]?.stages.map((stage) => stage.stageName)).toEqual([
        'prepare-worktree',
        'review',
      ])
      expect(old?.rounds[0]).toMatchObject({
        outcome: 'published',
        startedAt: NOW + 2,
        endedAt: NOW + 3,
      })
      expect((await projection.readPage({ capability: 'requirement' })).items).toEqual([])
      expect((await projection.readPage({ stableProjectId: 'proj-b5b' })).items.length).toBe(2)
    })

    test('模板上游持久化：锁定读 + 决策 + 落补丁在一个事务里', async () => {
      const db = harness.db
      const persistence = createTemplateUpstreamPersistence(db)
      expect(await persistence.load('missing')).toBeNull()
      expect(
        await persistence.decideAndPersist('missing', () => ({
          result: { ok: false, code: 'no-upstream' },
          patch: null,
        })),
      ).toBeNull()

      await db.insert(capabilityTemplates).values([
        template('tpl-upstream', { description: 'upstream v2', paramsJson: '{"x":2}' }),
        template('tpl-local', {
          upstreamId: 'tpl-upstream',
          upstreamVersion: 1,
          baseDigest: 'base-1',
        }),
        template('tpl-orphan'),
      ])
      expect(await persistence.load('tpl-local')).toMatchObject({
        id: 'tpl-local',
        upstreamId: 'tpl-upstream',
        upstreamVersion: 1,
        stageContractVer: 1,
        updatedAt: NOW,
      })

      const seen: Array<{ local: string; upstream: string | null }> = []
      const result = await persistence.decideAndPersist('tpl-local', ({ local, upstream }) => {
        seen.push({ local: local.id, upstream: upstream?.id ?? null })
        const patch: TemplateUpstreamMergePatch = {
          description: upstream?.description ?? null,
          scriptsJson: local.scriptsJson,
          hooksJson: local.hooksJson,
          paramSchemaJson: local.paramSchemaJson,
          paramDefaultsJson: local.paramDefaultsJson,
          agentBySlotJson: local.agentBySlotJson,
          promptBySlotJson: local.promptBySlotJson,
          paramsJson: upstream?.paramsJson ?? local.paramsJson,
          stageContractVer: local.stageContractVer,
          upstreamVersion: 2,
          baseDigest: 'base-2',
          baseSnapshotJson: '{}',
          updatedAt: NOW + 5,
        }
        return {
          result: {
            ok: true,
            applied: ['description', 'paramsJson'],
            keptLocal: [],
            stillConflicted: [],
          },
          patch,
        }
      })
      expect(seen).toEqual([{ local: 'tpl-local', upstream: 'tpl-upstream' }])
      expect(result).toEqual({
        ok: true,
        applied: ['description', 'paramsJson'],
        keptLocal: [],
        stillConflicted: [],
      })
      expect(await persistence.load('tpl-local')).toMatchObject({
        description: 'upstream v2',
        paramsJson: '{"x":2}',
        upstreamVersion: 2,
        baseDigest: 'base-2',
        updatedAt: NOW + 5,
      })

      // 没有上游：决策看到 upstream null；patch 为 null 时什么都不写。
      const orphan = await persistence.decideAndPersist('tpl-orphan', ({ upstream }) => ({
        result: { ok: false, code: upstream === null ? 'no-upstream' : 'upstream-gone' },
        patch: null,
      }))
      expect(orphan).toEqual({ ok: false, code: 'no-upstream' })
      expect((await persistence.load('tpl-orphan'))?.updatedAt).toBe(NOW)
    })
  },
)
