// RFC-358 —— 锁的是「意图链路看得见工作流图校验」这一整条。
//
// 为什么存在：此前意图链路只跑第一层（`validateDraftChangeset`，查引用与形状），而真正的
// 工作流图校验 `validateWorkflowDef`（端口存在性、wrapper 边界、review 源的 kind、call 闭环）
// **从生成到落库一次都不跑**。于是意图侧全绿落库、坏在编辑器 / 启动，而构建器 agent 从头到尾
// 没见过这些错误、无法自愈。生产库快照实证：意图产的 7 个工作流里有 1 个带
// `review-input-source-not-markdown`——正是第一层看不见、第二层才知道的那类规则。
//
// 这些用例同时钉死设计门两路评审报出的四条 P0：覆盖层必须带 `outputKinds`（否则误报本 RFC
// 自己的旗舰用例）、合成的 agent 新行必须字段齐全（否则 validator 在无保护解引用上抛）、
// loose 定义必须先过 canonical schema（否则整轮崩）、同批新建的资源必须注入（否则假阳性）。

import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseIntentChangeset, type IntentChangeset } from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { canonicalIntentJson } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, workflows as workflowsTable } from '../src/db/schema'
import { applyIntentChangeset } from '../src/modules/intent/composition/apply'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'
import { createIntentSession } from '@/modules/intent/application/session'
import { withAgentSidecarsFrom } from '@/modules/resource-catalog/domain/agentSidecarBackfill'
import { users } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import {
  buildIntentGraphCandidates,
  draftGraphResolution,
  IntentGraphRefUnresolved,
  pendingGraphIdOf,
  rewriteIntentWorkflowRefs,
} from '@/modules/intent/domain/workflowGraphCandidate'
import { validateChangesetWorkflowGraphs } from '@/modules/intent/application/graphValidation'
import { buildIntentDoc } from '@/modules/intent/domain/intentDoc'
import {
  intentGraphValidationForTest,
  intentResourceCatalogBinding,
} from './helpers/intentResourceCatalogBinding'
import { intentResourceVisibility } from '@/modules/intent/application/resourceCatalog'
import { composeSqliteIntentPersistence } from '../src/modules/intent/composition/persistence'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '../src/modules/resource-catalog/composition/intentContextAuthorization'
import { createIntentSessionAndReserveTurn } from '@/modules/intent/application/session'
import type {
  IntentContextResourceAuthorization,
  IntentPersistence,
} from '../src/modules/intent/application/ports/intentPersistence'
import { ulid } from 'ulid'
import type { Actor } from '../src/auth/actor'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc358_00000000'

let db: DbClient

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    status: 'active',
    passwordHash: 'x',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
})

function changesetOf(ops: unknown[]): IntentChangeset {
  const parsed = parseIntentChangeset(JSON.stringify({ $schema_version: 1, ops }))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.changeset
}

function agentOp(
  tempRef: string,
  name: string,
  payload: Record<string, unknown> = {},
  opId = 'op-1',
) {
  return {
    opId,
    action: 'create',
    resourceType: 'agent',
    tempRef,
    payload: {
      name,
      description: 'd',
      outputs: ['report'],
      outputKinds: { report: 'markdown' },
      permission: {},
      bodyMd: 'body',
      ...payload,
    },
  }
}

function workflowOp(opId: string, tempRef: string, name: string, definition: unknown) {
  return {
    opId,
    action: 'create',
    resourceType: 'workflow',
    tempRef,
    payload: { name, description: 'd', definition },
  }
}

async function runGraph(changeset: IntentChangeset) {
  return await validateChangesetWorkflowGraphs(
    { graphValidation: intentGraphValidationForTest(db) },
    {
      actor,
      changeset,
      resolution: draftGraphResolution([], changeset),
      mode: 'draft',
    },
  )
}

/** 一条最小的「input → agent → output」定义，图校验下是绿的。 */
function linearDefinition(agentRef: string) {
  return {
    $schema_version: 6,
    inputs: [{ key: 'task', kind: 'text', label: 'Task', required: true }],
    nodes: [
      { id: 'n_in', kind: 'input', inputKey: 'task' },
      { id: 'n_agent', kind: 'agent-single', agentRef, promptTemplate: 'do {{task}}' },
      { id: 'n_out', kind: 'output', outputName: 'result' },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'n_in', portName: 'task' },
        target: { nodeId: 'n_agent', portName: 'task' },
      },
      {
        id: 'e2',
        source: { nodeId: 'n_agent', portName: 'report' },
        target: { nodeId: 'n_out', portName: 'result' },
      },
    ],
  }
}

describe('RFC-358 — draft-time workflow graph validation', () => {
  test('本 RFC 的旗舰用例：同批新建 agent + 用它的工作流，图校验能给出结论且不误报', async () => {
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'pipeline', linearDefinition('$new:auditor')),
    ])
    const outcome = await runGraph(changeset)
    expect(outcome.unavailable).toBe(false)
    // 同批新建的 agent 以变更后的形态参与判据：既不报 agent-not-found，
    // 也不因为端口来自变更集而报 edge-source-port-missing。
    expect(outcome.errors.join('\n')).not.toContain('agent-not-found')
    expect(outcome.errors.join('\n')).not.toContain('edge-source-port-missing')
    expect(outcome.errors).toEqual([])
  })

  test('P0-1：覆盖层带 outputKinds 才不会误报 review-input-source-not-markdown', async () => {
    const reviewDefinition = (agentRef: string) => ({
      $schema_version: 6,
      inputs: [{ key: 'task', kind: 'text', label: 'Task', required: true }],
      nodes: [
        { id: 'n_in', kind: 'input', inputKey: 'task' },
        { id: 'n_agent', kind: 'agent-single', agentRef, promptTemplate: 'do {{task}}' },
        { id: 'n_review', kind: 'review' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n_in', portName: 'task' },
          target: { nodeId: 'n_agent', portName: 'task' },
        },
        // schema v6：被审源是一条入边，不再是 `inputSource` 字段（RFC-354）。
        {
          id: 'e2',
          source: { nodeId: 'n_agent', portName: 'report' },
          target: { nodeId: 'n_review', portName: '__review_input__' },
        },
      ],
    })

    // 带 outputKinds:{report:'markdown'} —— review 的被审源是 markdown，规则满足。
    const good = await runGraph(
      changesetOf([
        agentOp('$new:auditor', 'auditor'),
        workflowOp('op-2', '$new:wf', 'p1', reviewDefinition('$new:auditor')),
      ]),
    )
    expect(good.errors.join('\n')).not.toContain('review-input-source-not-markdown')

    // 同一份定义，agent 声明的 outputKinds 换成非 markdown —— 必须报出来。
    // 这一条同时证明 outputKinds 真的被喂进了校验上下文：如果覆盖层丢掉它，
    // 上面那条也会红（P0-1 的实测形态）。
    const bad = await runGraph(
      changesetOf([
        agentOp('$new:auditor', 'auditor', { outputKinds: { report: 'string' } }),
        workflowOp('op-2', '$new:wf', 'p2', reviewDefinition('$new:auditor')),
      ]),
    )
    expect(bad.errors.join('\n')).toContain('review-input-source-not-markdown')
    expect(bad.errors[0]?.startsWith('op-2:')).toBe(true)
  })

  test('AC-9：同批新建的 skill 不产生 skill-not-found 假阳性', async () => {
    const changeset = changesetOf([
      {
        opId: 'op-9',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:sk',
        payload: { name: 'lint-rules', description: 'd', bodyMd: 'body', files: [] },
      },
      agentOp('$new:auditor', 'auditor', { skills: ['$new:sk'] }),
      workflowOp('op-2', '$new:wf', 'pipeline', linearDefinition('$new:auditor')),
    ])
    const outcome = await runGraph(changeset)
    expect(outcome.errors.join('\n')).not.toContain('skill-not-found')
    expect(outcome.errors).toEqual([])
  })

  test('AC-9：同批新建的被调工作流不产生 call-workflow-ref-missing 假阳性', async () => {
    const caller = {
      $schema_version: 6,
      inputs: [{ key: 'task', kind: 'text', label: 'Task', required: true }],
      nodes: [
        { id: 'n_in', kind: 'input', inputKey: 'task' },
        {
          id: 'n_call',
          kind: 'call-workflow',
          workflowName: 'callee',
          workflowRef: '$new:wf_callee',
        },
      ],
      edges: [],
    }
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf_callee', 'callee', linearDefinition('$new:auditor')),
      workflowOp('op-3', '$new:wf_caller', 'caller', caller),
    ])
    const outcome = await runGraph(changeset)
    expect(outcome.errors.join('\n')).not.toContain('call-workflow-ref-missing')
  })

  test('AC-10：畸形定义给一条可读的 op 级 error，而不是让整轮崩', async () => {
    const malformed = {
      $schema_version: 6,
      inputs: [],
      nodes: [{ id: 'n_agent', kind: 'agent-single', agentRef: '$new:auditor' }],
      // 校验器第一件事就解引用 edge.target.nodeId —— 这种边会让它抛。
      edges: [{ from: 'a', to: 'b' }],
    }
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'broken', malformed),
    ])
    const outcome = await runGraph(changeset)
    expect(outcome.unavailable).toBe(false)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toContain('op-2:')
    expect(outcome.errors[0]).toContain('malformed')
  })

  test('P0-2：合成的 agent 新行经校验器全判据不抛（skills / dependsOn 无 ?? [] 保护）', async () => {
    // 变更集里 skills/dependsOn/mcp/plugins 都是 `.default([])`，覆盖层必须把它们带上；
    // 少一个，validator 的 `for (const ref of agent.skills)` 与 `[...agent.dependsOn]`
    // 就会在 undefined 上抛，被 turnEngine 兜成 intent-turn-crashed（产出全丢）。
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'pipeline', linearDefinition('$new:auditor')),
    ])
    const built = buildIntentGraphCandidates({
      changeset,
      resolution: draftGraphResolution([], changeset),
      mode: 'draft',
    })
    const overlay = built.overlays.agents?.[0]
    expect(overlay?.isNew).toBe(true)
    expect(overlay?.fields.skills).toEqual([])
    expect(overlay?.fields.dependsOn).toEqual([])
    expect(overlay?.fields.mcp).toEqual([])
    expect(overlay?.fields.plugins).toEqual([])
    expect(overlay?.fields.outputKinds).toEqual({ report: 'markdown' })
    // 真的跑一遍，证明不抛。
    await expect(runGraph(changeset)).resolves.toBeDefined()
  })

  test('AC-8：update op 省略的 sidecar 沿用存值，`.default([])` 的字段无条件覆盖', async () => {
    const stored = await createAgent(
      db,
      {
        name: 'stored-agent',
        description: 'd',
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        role: 'normal',
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'b',
        syncOutputsOnIterate: true,
      },
      { ownerUserId: OWNER, actor },
    )
    const changeset = changesetOf([
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'agent',
        target: 'res#agent#1',
        // 只改 outputs，省略 outputKinds —— 后者按 user ruling ① 保留存值。
        payload: {
          name: 'stored-agent',
          description: 'd',
          outputs: ['report', 'extra'],
          permission: {},
          bodyMd: 'b',
        },
      },
    ])
    const built = buildIntentGraphCandidates({
      changeset,
      resolution: {
        byHandle: new Map([['res#agent#1', stored.id]]),
        byTempRef: new Map(),
      },
      mode: 'draft',
    })
    const overlay = built.overlays.agents?.[0]
    expect(overlay?.isNew).toBe(false)
    expect(overlay?.agentId).toBe(stored.id)
    expect(overlay?.fields.outputs).toEqual(['report', 'extra'])
    // 省略即保留 —— 覆盖层不带这个键，合并时才会落到存值上。
    expect(overlay?.fields.outputKinds).toBeUndefined()
    // `.default([])` 的字段则显式出现（apply 侧同样无条件写）。
    expect(overlay?.fields.skills).toEqual([])
  })

  test('引用解析不出时：draft 跳过该 op，apply 抛（既有错误形状不变）', async () => {
    const definition = linearDefinition('$new:missing')
    const empty = { byHandle: new Map<string, string>(), byTempRef: new Map<string, string>() }
    expect(rewriteIntentWorkflowRefs(definition, empty, 'draft')).toBeUndefined()
    expect(() => rewriteIntentWorkflowRefs(definition, empty, 'apply')).toThrow(
      IntentGraphRefUnresolved,
    )
  })

  test('占位 id 与 opId 绑定，且被写进候选身份（自调用 / 环走查要用）', () => {
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'pipeline', linearDefinition('$new:auditor')),
    ])
    const built = buildIntentGraphCandidates({
      changeset,
      resolution: draftGraphResolution([], changeset),
      mode: 'draft',
    })
    expect(built.candidates).toHaveLength(1)
    expect(built.candidates[0]?.currentWorkflow).toEqual({
      id: pendingGraphIdOf('op-2'),
      name: 'pipeline',
    })
  })

  test('变更集不含工作流 op 时整段跳过', async () => {
    const outcome = await runGraph(changesetOf([agentOp('$new:auditor', 'auditor')]))
    expect(outcome).toEqual({ unavailable: false, errors: [], warnings: [] })
  })

  test('D7：图校验端口抛异常 → 标记不可用，不产出错误也不给绿', async () => {
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'pipeline', linearDefinition('$new:auditor')),
    ])
    const outcome = await validateChangesetWorkflowGraphs(
      {
        graphValidation: {
          async validate() {
            throw new Error('db down')
          },
          async workflowsUsingAgents() {
            return new Map()
          },
        },
      },
      { actor, changeset, resolution: draftGraphResolution([], changeset), mode: 'draft' },
    )
    expect(outcome.unavailable).toBe(true)
    expect(outcome.errors).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RFC-358 T6（决策 D2）—— 图修复轮。
//
// 锁两件事：①「恰好一轮」的判据持久在 turn 行里，进程重启也成立；②预约与 settle
// 在**同一个事务**里，`inFlightTurnId` 从旧轮直接过渡到新轮、中间不落地——否则用户
// 在那个空窗里点「取消」会静默失效，紧接着一轮他没发起过的模型轮照常起飞。

describe('RFC-358 — graph repair turn', () => {
  let persistence: IntentPersistence

  let authorization: IntentContextResourceAuthorization

  beforeEach(() => {
    persistence = composeSqliteIntentPersistence({
      db,
      contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
    })
    authorization = intentResourceVisibility(
      intentResourceCatalogBinding(db, actor),
    ) as IntentContextResourceAuthorization
  })

  async function seedRunningTurn() {
    const created = await createIntentSessionAndReserveTurn(persistence, authorization, actor, {
      message: 'build me a pipeline',
    })
    return created
  }

  function settleWith(
    turnId: string,
    launchRevision: number,
    content: Record<string, unknown>,
    graphRepair: { turnId: string; envelopeNonce: string; maxGenerateRounds: number } | undefined,
    sessionId: string,
  ) {
    return persistence.settleTurn({
      sessionId,
      turnId,
      launchRevision,
      kind: 'changeset',
      content,
      scratchRetained: false,
      budgetDelta: { generateRounds: 1 },
      draft: {
        changesetJson: '{"$schema_version":1,"ops":[]}',
        validationJson: '{"errors":["op-1: edge-source-port-missing"],"credentialFindings":[]}',
        draftHash: 'sha256:deadbeef',
      },
      ...(graphRepair === undefined ? {} : { graphRepair }),
      now: Date.now(),
    })
  }

  test('blocking errors mint exactly one repair turn, and in-flight never goes empty', async () => {
    const created = await seedRunningTurn()
    const repairTurnId = ulid()
    const settled = await settleWith(
      created.reservation.turnId,
      created.session.contextRevision,
      { summary: 's', opCount: 1, blockingErrors: 2 },
      { turnId: repairTurnId, envelopeNonce: 'nonce-repair', maxGenerateRounds: 50 },
      created.session.id,
    )
    expect(settled.graphRepair?.turnId).toBe(repairTurnId)
    expect(settled.blockingErrors).toBe(2)

    // 空窗锁：settle 之后会话立刻由修复轮占位，而不是先落到 null。
    const after = await persistence.findSession(created.session.id)
    expect(after?.inFlightTurnId).toBe(repairTurnId)

    // 修复轮的 launchSession 必须指向**刚落的那份草稿**，否则它的 INTENT.md 里
    // 根本没有要它修的 blocking 段。
    expect(settled.graphRepair?.launchSession.currentDraftId).toBe(after?.currentDraftId ?? null)
    expect(settled.graphRepair?.launchSession.currentDraftId).not.toBeNull()
  })

  test('a repair turn that stays red does NOT mint a third turn', async () => {
    const created = await seedRunningTurn()
    const repairTurnId = ulid()
    await settleWith(
      created.reservation.turnId,
      created.session.contextRevision,
      { summary: 's', blockingErrors: 1 },
      { turnId: repairTurnId, envelopeNonce: 'n1', maxGenerateRounds: 50 },
      created.session.id,
    )
    const mid = await persistence.findSession(created.session.id)
    // 修复轮自己再红一次 —— 判据来自它 turn 行里的标记，与内存无关。
    const settled = await settleWith(
      repairTurnId,
      mid?.contextRevision ?? 0,
      { summary: 's', blockingErrors: 1 },
      { turnId: ulid(), envelopeNonce: 'n2', maxGenerateRounds: 50 },
      created.session.id,
    )
    expect(settled.graphRepairTurn).toBe(true)
    expect(settled.graphRepair).toBeUndefined()
    const after = await persistence.findSession(created.session.id)
    expect(after?.inFlightTurnId).toBeNull()
  })

  test('a clean changeset mints nothing', async () => {
    const created = await seedRunningTurn()
    const settled = await settleWith(
      created.reservation.turnId,
      created.session.contextRevision,
      { summary: 's', blockingErrors: 0 },
      { turnId: ulid(), envelopeNonce: 'n', maxGenerateRounds: 50 },
      created.session.id,
    )
    expect(settled.graphRepair).toBeUndefined()
    const after = await persistence.findSession(created.session.id)
    expect(after?.inFlightTurnId).toBeNull()
  })

  test('an exhausted budget declines silently instead of throwing', async () => {
    const created = await seedRunningTurn()
    // maxGenerateRounds=1：这一轮扣掉之后预算就满了。预约必须**返回空**而不是抛——
    // 它跑在 dispatcher 的 finally 里，抛出会冒泡成未捕获拒绝。
    const settled = await settleWith(
      created.reservation.turnId,
      created.session.contextRevision,
      { summary: 's', blockingErrors: 3 },
      { turnId: ulid(), envelopeNonce: 'n', maxGenerateRounds: 1 },
      created.session.id,
    )
    expect(settled.graphRepair).toBeUndefined()
    const after = await persistence.findSession(created.session.id)
    expect(after?.inFlightTurnId).toBeNull()
  })

  test('no repair material (non-changeset settle) mints nothing', async () => {
    const created = await seedRunningTurn()
    const settled = await persistence.settleTurn({
      sessionId: created.session.id,
      turnId: created.reservation.turnId,
      launchRevision: created.session.contextRevision,
      kind: 'error',
      content: { code: 'intent-changeset-invalid' },
      scratchRetained: false,
      now: Date.now(),
    })
    expect(settled.graphRepair).toBeUndefined()
    expect(settled.kind).toBe('error')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RFC-358 T7/T9（决策 D3/D5）—— 提交期的二次硬拦，与 copy 的 sidecar 回填。

describe('RFC-358 — apply-time gate and copy backfill', () => {
  let persistence: IntentPersistence
  let appHome: string

  beforeEach(() => {
    persistence = composeSqliteIntentPersistence({
      db,
      contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
    })
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc358-'))
    mkdirSync(join(appHome, 'skills'), { recursive: true })
  })

  function installDraft(sessionId: string, changeset: IntentChangeset) {
    const canonical = canonicalIntentJson(changeset)
    const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
    const draftId = ulid()
    db.insert(intentDrafts)
      .values({
        id: draftId,
        sessionId,
        revision: 1,
        changesetJson: canonical,
        validationJson: '{"errors":[],"credentialFindings":[]}',
        draftHash,
        contextRevision: 0,
        createdAt: Date.now(),
      })
      .run()
    db.update(intentSessions)
      .set({ currentDraftId: draftId, contextManifestJson: '[]' })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { draftRevision: 1, draftHash }
  }

  async function seedSession() {
    const catalog = intentResourceCatalogBinding(db, actor, appHome)
    return await createIntentSession(persistence, intentResourceVisibility(catalog), actor, {
      message: 'build',
    })
  }

  test('AC-6: a workflow that fails graph validation is refused at commit with zero rows written', async () => {
    const { session } = await seedSession()
    // 一条边指向 agent 上并不存在的端口 —— 图校验才看得见的那类错误。
    const badDefinition = {
      $schema_version: 6,
      inputs: [{ key: 'task', kind: 'text', label: 'Task', required: true }],
      nodes: [
        { id: 'n_in', kind: 'input', inputKey: 'task' },
        { id: 'n_agent', kind: 'agent-single', agentRef: '$new:auditor', promptTemplate: 'go' },
        { id: 'n_out', kind: 'output', outputName: 'result' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n_in', portName: 'task' },
          target: { nodeId: 'n_agent', portName: 'task' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n_agent', portName: 'nope_not_a_port' },
          target: { nodeId: 'n_out', portName: 'result' },
        },
      ],
    }
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'bad-pipeline', badDefinition),
    ])
    const draft = installDraft(session.id, changeset)

    const before = db.select().from(workflowsTable).all().length
    await expect(
      applyIntentChangeset(
        {
          db,
          appHome,
          actor,
          ...intentApplyResourceBinding(db, actor),
          graphValidation: intentGraphValidationForTest(db),
        },
        { sessionId: session.id, clientMutationId: ulid(), ...draft, decisions: [] },
      ),
    ).rejects.toThrow(/intent-workflow-invalid|workflow validation/)
    // preflight 段还没有任何副作用，所以零落库。
    expect(db.select().from(workflowsTable).all().length).toBe(before)
  })

  test('AC-6: the same bundle commits cleanly once the edge is wired to a real port', async () => {
    const { session } = await seedSession()
    const changeset = changesetOf([
      agentOp('$new:auditor', 'auditor'),
      workflowOp('op-2', '$new:wf', 'good-pipeline', linearDefinition('$new:auditor')),
    ])
    const draft = installDraft(session.id, changeset)
    const receipt = await applyIntentChangeset(
      {
        db,
        appHome,
        actor,
        ...intentApplyResourceBinding(db, actor),
        graphValidation: intentGraphValidationForTest(db),
      },
      { sessionId: session.id, clientMutationId: ulid(), ...draft, decisions: [] },
    )
    expect(receipt.applied.some((each) => each.resourceType === 'workflow')).toBe(true)
  })

  test('B-5: a copied agent keeps the source sidecars instead of silently dropping them', async () => {
    // 现状（本改动之前）：copy 把 update 归一成 create，而 create 分支不回填 sidecar，
    // 于是 outputKinds / branchPorts / role / outputWrapperPortNames 四个字段静默消失。
    const source = await createAgent(
      db,
      {
        name: 'source-agent',
        description: 'd',
        outputs: ['report', 'needs_fix'],
        outputKinds: { report: 'markdown', needs_fix: 'signal' },
        branchPorts: ['needs_fix'],
        role: 'normal',
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'b',
        syncOutputsOnIterate: true,
      },
      { ownerUserId: OWNER, actor },
    )
    const backfilled = withAgentSidecarsFrom(
      // 变更集只带 outputs，四个 sidecar 全部省略 —— 省略即保留。
      { name: 'copy-of-source', description: 'd', outputs: ['report', 'needs_fix'] },
      source,
    )
    expect(backfilled.outputKinds).toEqual({ report: 'markdown', needs_fix: 'signal' })
    expect(backfilled.branchPorts).toEqual(['needs_fix'])
    // 显式给出的空值是「清空」，不能被存值盖回去。
    const cleared = withAgentSidecarsFrom({ branchPorts: [] }, source)
    expect(cleared.branchPorts).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RFC-358 D1 / §12 —— 「哪些东西给人、哪些东西给模型」的分界。

describe('RFC-358 — what reaches the model vs. what reaches the human', () => {
  const docBase = {
    sessionTitle: 't',
    turns: [],
    currentDraftJson: null,
    pendingQuestions: [],
    hiddenDependencyNote: null,
    unavailableMountNote: null,
    envelopeNonce: 'nonce',
    langDirective: 'mirror',
    privileges: { mayAuthorScriptNodes: false, mayAuthorCodeHostNodes: false },
  } as unknown as Parameters<typeof buildIntentDoc>[0]

  test('D1: blocking errors reach INTENT.md; graph warnings never do', () => {
    const doc = buildIntentDoc({
      ...docBase,
      validationErrors: ['op-2: edge-source-port-missing @n_agent — no such port'],
    })
    expect(doc).toContain('BLOCKING validation errors')
    expect(doc).toContain('edge-source-port-missing')
    // warning 只在确认页。`buildIntentDoc` 连这个字段都不接——决策 D1 的结构性锁点。
    expect(doc).not.toContain('clarify-no-iteration-cap')
  })

  test('AC-13: the downstream-workflow notice is human-only, never part of the prompt', async () => {
    const stored = await createAgent(
      db,
      {
        name: 'shared-agent',
        description: 'd',
        outputs: ['report'],
        outputKinds: { report: 'markdown' },
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'b',
        syncOutputsOnIterate: true,
      },
      { ownerUserId: OWNER, actor },
    )
    db.insert(workflowsTable)
      .values({
        id: ulid(),
        name: 'downstream-pipeline',
        description: '',
        definition: JSON.stringify({
          $schema_version: 6,
          inputs: [],
          nodes: [{ id: 'n', kind: 'agent-single', agentId: stored.id }],
          edges: [],
        }),
        version: 1,
        schemaVersion: 6,
        ownerUserId: OWNER,
        visibility: 'private',
        builtin: false,
        aclRevision: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()

    const downstream = await intentGraphValidationForTest(db).workflowsUsingAgents({
      actor,
      agentIds: [stored.id],
    })
    expect(downstream.get(stored.id)?.map((each) => each.name)).toEqual(['downstream-pipeline'])

    // 它不进 prompt：INTENT.md 里不该出现那个工作流的名字。
    const doc = buildIntentDoc({ ...docBase, validationErrors: [] })
    expect(doc).not.toContain('downstream-pipeline')
  })
})
