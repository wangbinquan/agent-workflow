// RFC-257 T8 — 触发器保存期静态校验（design §4.2 / AC-14 前半）。
// 三层：①模板变量 ⊆ 所选事件类型交集可用集（shared templateVarIssues）；
// ②workflow 面的输入映射 kind-aware 校验（git→event-branch、text→template、
// enum/files/upload 不可映射——gate 只见字符串，不懂映射语义，这层必须在此做）；
// ③「彩排渲染 + 完整 gate」：用合成事件渲染出完全体 payload 交给
// assertScheduledTargetUsable（ACL/builtin/upload/launch-shape 全复用，等价于
// 验证「一个典型事件到来时这个触发器能启动」）——fire 期跑的是同一个 gate，
// 保存期彩排让配置错误在保存时暴露而不是 fire 后逐次失败。
import { eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { canViewResource } from '@/services/resourceAcl'
import { assertScheduledTargetUsable } from '@/services/scheduledTasks'
import { getWorkflowAclRow } from '@/services/workflow'
import { freezeCallClosure } from '@/services/execution/closure'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import { renderWebhookLaunch } from '@/services/webhook/webhookDispatch'
import { NotFoundError, ValidationError } from '@/util/errors'
import type {
  CodeHostEvent,
  CodeHostEventType,
  WebhookInputMapping,
  WebhookLaunchKind,
  WebhookLaunchPayloadTemplate,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  WebhookWorkflowPayloadTemplateSchema,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  webhookPayloadTemplateSchemaFor,
  templateVarIssues,
} from '@agent-workflow/shared'

export type TriggerValidationIssue = {
  code:
    | 'unknown-template-var'
    | 'template-var-unavailable'
    | 'unknown-input'
    | 'required-input-unmapped'
    | 'input-kind-unmappable'
    | 'input-mapping-kind-mismatch'
    | 'scratch-auto-register-conflict'
  detail: string
}

type DefInput = WorkflowDefinition['inputs'][number]

/** workflow 面：输入映射与 workflow 定义的 kind-aware 对账。 */
export function validateWorkflowInputMappings(
  defInputs: ReadonlyArray<DefInput>,
  mappings: Record<string, WebhookInputMapping>,
): TriggerValidationIssue[] {
  const issues: TriggerValidationIssue[] = []
  const byKey = new Map(defInputs.map((i) => [i.key, i]))
  for (const [key, mapping] of Object.entries(mappings)) {
    const def = byKey.get(key)
    if (def === undefined) {
      issues.push({ code: 'unknown-input', detail: key })
      continue
    }
    if (def.kind === 'git') {
      if (mapping.kind !== 'event-branch') {
        issues.push({
          code: 'input-mapping-kind-mismatch',
          detail: `${key}: git-kind input requires the event-branch mapping`,
        })
      }
    } else if (def.kind === 'text') {
      if (mapping.kind !== 'template') {
        issues.push({
          code: 'input-mapping-kind-mismatch',
          detail: `${key}: text-kind input requires a template mapping`,
        })
      }
    } else {
      // enum/files/upload：packed 语义无法从事件构造（design §4.2）。
      issues.push({
        code: 'input-kind-unmappable',
        detail: `${key}: ${def.kind}-kind inputs cannot be event-mapped`,
      })
    }
  }
  for (const def of defInputs) {
    if (def.required === true && !(def.key in mappings)) {
      issues.push({ code: 'required-input-unmapped', detail: def.key })
    }
  }
  return issues
}

/** 全量保存期静态校验（模板变量层 + workflow 映射层；gate 彩排由调用方跑）。 */
export function staticTriggerIssues(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
  eventTypes: ReadonlyArray<CodeHostEventType>,
  workflowInputs: ReadonlyArray<DefInput> | null,
): TriggerValidationIssue[] {
  const issues: TriggerValidationIssue[] = templateVarIssues(kind, payload, eventTypes).map(
    (i) => ({ code: i.code, detail: i.varName }),
  )
  if (kind === 'workflow' && workflowInputs !== null) {
    const parsed = WebhookWorkflowPayloadTemplateSchema.parse(payload)
    issues.push(...validateWorkflowInputMappings(workflowInputs, parsed.inputs))
  }
  return issues
}

/**
 * 保存期全量校验（路由从 create/update 两处调用）：wire 封套 → 静态三层
 * （模板变量 / workflow 映射 kind-aware）→「彩排渲染 + assertScheduledTargetUsable」。
 * 彩排以**保存者身份**跑——launch 目标对保存者不可见即 404（resourceRefs 惯例）。
 */
export async function assertTriggerSaveable(
  db: DbClient,
  actor: Actor,
  candidate: {
    launchKind: WebhookLaunchKind
    launchRefId: string
    launchPayload: unknown
    eventTypes: ReadonlyArray<CodeHostEventType>
    autoRegisterRepos: boolean
  },
  defaultRuntime: string | null | undefined,
): Promise<void> {
  const parsedPayload = webhookPayloadTemplateSchemaFor(candidate.launchKind).safeParse(
    candidate.launchPayload,
  )
  if (!parsedPayload.success) {
    throw new ValidationError('webhook-trigger-invalid', 'invalid launch payload', {
      issues: parsedPayload.error.issues,
    })
  }
  const payload = parsedPayload.data
  let workflowInputs: ReadonlyArray<DefInput> | null = null
  let workflowDefinition: WorkflowDefinition | null = null
  let workflowClosureJson: string | null = null
  if (candidate.launchKind === 'workflow') {
    // D1 顺序不变量：可见性门必须先于 definition 内容的任何读取与回显。
    // 下面的静态校验层逐字回显 input key 与 kind（unknown-input /
    // required-input-unmapped / input-kind-unmappable），若排在 ACL 之后，
    // 一个不可见 workflow 的存在性与输入结构就会经 422 的 issue 泄漏出去
    // ——彩排 gate 的 canViewResource 那时才跑，已经晚了。
    // 用 ACL 专用行读：它不解析 definition，坏定义也能正确判 404（与
    // getWorkflowAclRow 的既有用途一致）。完整 gate（builtin / upload /
    // launch-shape）仍留在本函数末尾，这里只前置最小可见性门。
    const aclRow = await getWorkflowAclRow(db, candidate.launchRefId)
    if (aclRow === null || !(await canViewResource(db, actor, 'workflow', aclRow))) {
      throw new NotFoundError('workflow-not-found', 'workflow not found')
    }
    const wf = (
      await db
        .select({ definition: workflows.definition })
        .from(workflows)
        .where(eq(workflows.id, candidate.launchRefId))
        .limit(1)
    )[0]
    if (wf !== undefined) {
      const def = WorkflowDefinitionSchema.safeParse(JSON.parse(wf.definition))
      if (def.success) {
        workflowDefinition = migrateWorkflowDefinitionToLatest(def.data)
        workflowInputs = workflowDefinition.inputs
        workflowClosureJson = await freezeCallClosure(
          db,
          { id: candidate.launchRefId, definition: workflowDefinition },
          actor,
        )
      } else {
        workflowInputs = []
      }
    }
  }
  const issues = staticTriggerIssues(
    candidate.launchKind,
    payload,
    candidate.eventTypes,
    workflowInputs,
  )
  // `scratch` is a human-authored launch option; a code-round template has no
  // such field (its space is decided by the capability contract, not here).
  // Reading it off the union would be a lie about what the payload contains.
  const payloadScratch = 'scratch' in payload && payload.scratch === true
  if (payloadScratch && candidate.autoRegisterRepos !== false) {
    issues.push({
      code: 'scratch-auto-register-conflict',
      detail: 'autoRegisterRepos must be false when launchPayload.scratch is true',
    })
  }
  if (issues.length > 0) {
    throw new ValidationError('webhook-trigger-invalid', 'trigger static validation failed', {
      issues,
    })
  }
  if (workflowDefinition !== null) {
    assertTriggerPreflight({
      root: workflowDefinition,
      closureJson: workflowClosureJson,
      source: { kind: 'event-types', eventTypes: candidate.eventTypes },
    })
  }
  const rendered = renderWebhookLaunch(
    {
      launchKind: candidate.launchKind,
      launchRefId: candidate.launchRefId,
      payloadTemplate: payload,
    },
    'rehearsal',
    rehearsalEvent(candidate.eventTypes[0] ?? 'push'),
    payloadScratch
      ? { kind: 'scratch' }
      : { kind: 'url', repoUrl: 'https://rehearsal.invalid/repo.git' },
  )
  await assertScheduledTargetUsable(
    db,
    actor,
    rendered.kind,
    // 结构化 payload → gate 的宽记录形参（服务层内的唯一桥点）。
    rendered.payload as unknown as Record<string, unknown>,
    defaultRuntime,
    { kind: 'event-types', eventTypes: candidate.eventTypes },
  )
}

/**
 * 彩排事件：每个可选字段都给占位值，让渲染出的 payload 是「最完整形态」，
 * gate 的 launch-shape 校验（required 端口 / unknown key / upload 拒绝）在
 * 保存期就能全量执行。字段值本身无语义（gate 不检查内容）。
 */
export function rehearsalEvent(eventType: CodeHostEventType): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: null,
    eventType,
    repoPath: 'rehearsal/repo',
    repoHttpUrl: 'https://rehearsal.invalid/repo.git',
    repoSshUrl: 'git@rehearsal.invalid:repo.git',
    branch: 'rehearsal-branch',
    targetBranch: 'main',
    mrIid: '1',
    mrTitle: 'rehearsal',
    commitSha: '0000000000000000000000000000000000000000',
    commentText: '/rehearsal',
    author: { username: 'rehearsal-user' },
    pipelineStatus: 'failed',
    raw: {},
  }
}
