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
import { createInMemoryDb, type DbClient } from '../src/db/client'
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
import { intentGraphValidationForTest } from './helpers/intentResourceCatalogBinding'
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
        },
      },
      { actor, changeset, resolution: draftGraphResolution([], changeset), mode: 'draft' },
    )
    expect(outcome.unavailable).toBe(true)
    expect(outcome.errors).toEqual([])
  })
})
