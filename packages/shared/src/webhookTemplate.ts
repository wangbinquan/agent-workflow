// RFC-257 — 模板变量的纯函数面（保存期静态校验 + 运行期渲染，前后端共用）。
// 语义（design §4.2）：保存期严格 —— 模板引用变量必须 ⊆ 所选事件类型的交集
// 可用集；运行期宽松 —— 已声明变量缺值渲染为空串。
// {{trigger.webhook.event_json}} 在 source adapter 处固定截断为 32 KiB；每个
// 最终 launch surface 仍由自己的 schema/branch gate 校验，不能用 source 上限
// 代替 sink 上限。
import type {
  CodeHostEvent,
  CodeHostEventType,
  WebhookLaunchKind,
  WebhookLaunchPayloadTemplate,
  WebhookTemplateVar,
} from './schemas/webhook'
import {
  WEBHOOK_EVENT_VAR_MATRIX,
  WebhookAgentPayloadTemplateSchema,
  WebhookWorkflowPayloadTemplateSchema,
  WebhookWorkgroupPayloadTemplateSchema,
} from './schemas/webhook'
import { extractTemplateRefs, renderTemplateRefs, webhookTriggerToken } from './templateRef'
import { isWebhookTriggerField, type TriggerContext } from './triggerContext'
import { webhookTemplateAuthorityKey, type WebhookTemplateAuthorityKey } from './templateAuthority'

/** {{trigger.webhook.event_json}} 的截断上限（字符）。< 65536 的注入面上限，留出模板其余文字余量。 */
export const EVENT_JSON_VAR_MAX_CHARS = 32 * 1024

/** RFC-263/292：{{trigger.webhook.comment_position_json}} 的上限。position 对象只有十来个键，8 KiB 是宽裕的防御值。 */
export const COMMENT_POSITION_JSON_MAX_CHARS = 8 * 1024

/**
 * RFC-263（design §5.2）：行内评论位置对象 → 可原样回传给建评论 API 的 JSON。
 *
 * 与 `event_json` 不同，**超限不截断**：截断后的 JSON 是非法 JSON，agent 要么
 * 解析失败，要么（更糟）在部分解析后把评论打到错位置。空串是可判定的失败。
 * 序列化抛错（循环引用等）同样落空串。
 */
function positionJsonOf(position: unknown): string {
  if (position === undefined || position === null) return ''
  let json: string
  try {
    json = JSON.stringify(position) ?? ''
  } catch {
    return ''
  }
  return json.length > COMMENT_POSITION_JSON_MAX_CHARS ? '' : json
}

/** 提取模板里引用的变量名，known/unknown 分开（unknown → 保存期拒绝）。 */
export function extractTemplateVars(text: string): {
  known: WebhookTemplateVar[]
  unknown: string[]
} {
  const known = new Set<WebhookTemplateVar>()
  const unknown = new Set<string>()
  for (const ref of extractTemplateRefs(text)) {
    if (ref.kind === 'trigger') known.add(ref.field)
    else if (ref.kind === 'local') unknown.add(ref.name)
    else unknown.add(ref.raw)
  }
  return { known: [...known], unknown: [...unknown] }
}

/** 所选事件类型的交集可用集（保存期静态校验依据）。空选择 → 空集。 */
export function availableVarsFor(
  eventTypes: ReadonlyArray<CodeHostEventType>,
): Set<WebhookTemplateVar> {
  if (eventTypes.length === 0) return new Set()
  let acc = new Set<WebhookTemplateVar>(WEBHOOK_EVENT_VAR_MATRIX[eventTypes[0]!])
  for (const t of eventTypes.slice(1)) {
    const cur = new Set(WEBHOOK_EVENT_VAR_MATRIX[t])
    acc = new Set([...acc].filter((v) => cur.has(v)))
  }
  return acc
}

/** 事件 → 变量值表。可选字段缺值 = 空串（运行期宽松）；event_json 截断。 */
export function eventVarsOf(event: CodeHostEvent): Record<WebhookTemplateVar, string> {
  let eventJson: string
  try {
    eventJson = JSON.stringify(event.raw) ?? ''
  } catch {
    eventJson = ''
  }
  if (eventJson.length > EVENT_JSON_VAR_MAX_CHARS) {
    eventJson = eventJson.slice(0, EVENT_JSON_VAR_MAX_CHARS)
  }
  return {
    event_type: event.eventType,
    provider: event.provider,
    repo_path: event.repoPath,
    repo_http_url: event.repoHttpUrl,
    repo_ssh_url: event.repoSshUrl,
    branch: event.branch ?? '',
    target_branch: event.targetBranch ?? '',
    default_branch: event.defaultBranch ?? '',
    mr_iid: event.mrIid ?? '',
    mr_id: event.mrId ?? '',
    mr_title: event.mrTitle ?? '',
    mr_url: event.mrUrl ?? '',
    commit_sha: event.commitSha ?? '',
    commit_before: event.commitBefore ?? '',
    comment_text: event.commentText ?? '',
    comment_author: event.author.username ?? '',
    comment_id: event.commentId ?? '',
    comment_thread_id: event.commentThreadId ?? '',
    comment_url: event.commentUrl ?? '',
    comment_position_json: positionJsonOf(event.commentPosition),
    pipeline_status: event.pipelineStatus ?? '',
    pipeline_id: event.pipelineId ?? '',
    pipeline_url: event.pipelineUrl ?? '',
    api_base_url: event.apiBaseUrl ?? '',
    project_id: event.projectId ?? '',
    project_web_url: event.projectWebUrl ?? '',
    repo_owner: event.repoOwner ?? '',
    repo_name: event.repoName ?? '',
    author_id: event.authorId ?? '',
    event_json: eventJson,
  }
}

/**
 * 渲染一段 v2 模板。只从完整嵌套 TriggerContext 读取 canonical trigger ref；
 * 事件适用但值缺失时为空串，unknown/legacy/malformed ref fail-closed。普通未闭合
 * 的非 trigger 文本仍按 scanner 的字面规则保留。
 */
export function renderTemplate(text: string, context: TriggerContext): string {
  const rendered = renderTemplateRefs(text, (ref) => {
    if (ref.kind !== 'trigger') return ''
    return context.trigger.webhook[ref.field] ?? ''
  })
  if (rendered.invalid.length > 0) {
    throw new Error(`invalid webhook template ref: ${rendered.invalid[0]!.reason}`)
  }
  return rendered.value
}

export interface WebhookTemplateSurface {
  readonly launchKind: WebhookLaunchKind
  readonly sink: WebhookTemplateSink
  readonly authorityKey: WebhookTemplateAuthorityKey
  readonly pointer: string
  readonly text: string
}

export type WebhookTemplateSink =
  | 'workflow-input-text'
  | 'working-branch'
  | 'agent-description'
  | 'agent-input'
  | 'workgroup-goal'

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

/** Authoritative inventory of every webhook launch-payload template string. */
export function collectWebhookTemplateSurfaces(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
): WebhookTemplateSurface[] {
  const out: WebhookTemplateSurface[] = []
  const add = (sink: WebhookTemplateSink, pointer: string, text: string | undefined): void => {
    if (text !== undefined) {
      out.push({
        launchKind: kind,
        sink,
        authorityKey: webhookTemplateAuthorityKey(kind, sink),
        pointer,
        text,
      })
    }
  }

  if (kind === 'workflow') {
    const parsed = WebhookWorkflowPayloadTemplateSchema.parse(payload)
    for (const [key, mapping] of Object.entries(parsed.inputs)) {
      if (mapping.kind === 'template') {
        add('workflow-input-text', `/inputs/${pointerPart(key)}/template`, mapping.template)
      }
    }
    add('working-branch', '/workingBranch', parsed.workingBranch)
    return out
  }
  if (kind === 'agent') {
    const parsed = WebhookAgentPayloadTemplateSchema.parse(payload)
    add('agent-description', '/description', parsed.description)
    for (const [key, text] of Object.entries(parsed.inputs ?? {})) {
      add('agent-input', `/inputs/${pointerPart(key)}`, text)
    }
    add('working-branch', '/workingBranch', parsed.workingBranch)
    return out
  }

  const parsed = WebhookWorkgroupPayloadTemplateSchema.parse(payload)
  add('workgroup-goal', '/goal', parsed.goal)
  add('working-branch', '/workingBranch', parsed.workingBranch)
  return out
}

/** Clone and rewrite only the inventoried webhook launch template strings. */
export function mapWebhookTemplateSurfaces(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
  mapper: (surface: WebhookTemplateSurface) => string,
): WebhookLaunchPayloadTemplate {
  const rewrite = (sink: WebhookTemplateSink, pointer: string, text: string): string =>
    mapper({
      launchKind: kind,
      sink,
      authorityKey: webhookTemplateAuthorityKey(kind, sink),
      pointer,
      text,
    })

  if (kind === 'workflow') {
    const parsed = WebhookWorkflowPayloadTemplateSchema.parse(payload)
    return {
      ...parsed,
      inputs: Object.fromEntries(
        Object.entries(parsed.inputs).map(([key, mapping]) => [
          key,
          mapping.kind === 'template'
            ? {
                ...mapping,
                template: rewrite(
                  'workflow-input-text',
                  `/inputs/${pointerPart(key)}/template`,
                  mapping.template,
                ),
              }
            : mapping,
        ]),
      ),
      ...(parsed.workingBranch === undefined
        ? {}
        : { workingBranch: rewrite('working-branch', '/workingBranch', parsed.workingBranch) }),
    }
  }
  if (kind === 'agent') {
    const parsed = WebhookAgentPayloadTemplateSchema.parse(payload)
    return {
      ...parsed,
      ...(parsed.description === undefined
        ? {}
        : { description: rewrite('agent-description', '/description', parsed.description) }),
      ...(parsed.inputs === undefined
        ? {}
        : {
            inputs: Object.fromEntries(
              Object.entries(parsed.inputs).map(([key, text]) => [
                key,
                rewrite('agent-input', `/inputs/${pointerPart(key)}`, text),
              ]),
            ),
          }),
      ...(parsed.workingBranch === undefined
        ? {}
        : { workingBranch: rewrite('working-branch', '/workingBranch', parsed.workingBranch) }),
    }
  }

  const parsed = WebhookWorkgroupPayloadTemplateSchema.parse(payload)
  return {
    ...parsed,
    goal: rewrite('workgroup-goal', '/goal', parsed.goal),
    ...(parsed.workingBranch === undefined
      ? {}
      : { workingBranch: rewrite('working-branch', '/workingBranch', parsed.workingBranch) }),
  }
}

/**
 * 遍历封套里所有「会被插值」的模板字符串（保存期校验的输入面）。白名单路径
 * 与运行期渲染（backend webhookDispatch）必须同源于此函数——两边各写一份
 * 清单迟早漂移。
 */
export function collectTemplateStrings(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
): string[] {
  return collectWebhookTemplateSurfaces(kind, payload).map((surface) => surface.text)
}

/**
 * 保存期静态校验：封套内全部模板字符串引用的变量必须 ⊆ 所选事件类型交集
 * 可用集，且不得引用未知变量。返回逐条 issue（空数组 = 通过）。
 */
export function templateVarIssues(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
  eventTypes: ReadonlyArray<CodeHostEventType>,
): Array<{ code: 'unknown-template-var' | 'template-var-unavailable'; varName: string }> {
  const available = availableVarsFor(eventTypes)
  const issues: Array<{
    code: 'unknown-template-var' | 'template-var-unavailable'
    varName: string
  }> = []
  const seen = new Set<string>()
  for (const text of collectTemplateStrings(kind, payload)) {
    const { known, unknown } = extractTemplateVars(text)
    for (const name of unknown) {
      if (!seen.has(`u:${name}`)) {
        seen.add(`u:${name}`)
        issues.push({ code: 'unknown-template-var', varName: name })
      }
    }
    for (const v of known) {
      if (!available.has(v) && !seen.has(`a:${v}`)) {
        seen.add(`a:${v}`)
        issues.push({ code: 'template-var-unavailable', varName: v })
      }
    }
  }
  return issues
}

function escapeLegacyToken(rawBody: string): string | null {
  const first = rawBody.search(/\S/)
  if (first < 0) return null
  return `{{${rawBody.slice(0, first)}!${rawBody.slice(first)}}}`
}

/** Upgrade one RFC-257 v1 (flat-root) webhook launch template to RFC-292 v2. */
export function migrateWebhookTemplateToV2(text: string): string {
  let out = ''
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, open)
    const close = text.indexOf('}}', open + 2)
    if (close < 0) {
      const unclosedBody = text.slice(open + 2).trim()
      if (unclosedBody === 'trigger' || unclosedBody.startsWith('trigger.')) {
        throw new Error('invalid legacy webhook trigger template reference')
      }
      out += text.slice(open)
      break
    }
    const token = text.slice(open, close + 2)
    const rawBody = text.slice(open + 2, close)
    const body = rawBody.trim()
    const parts = body.split('.')
    const field = isWebhookTriggerField(body)
      ? body
      : parts.length === 2 && parts[0] === 'trigger' && isWebhookTriggerField(parts[1]!)
        ? parts[1]!
        : parts.length === 3 &&
            parts[0] === 'trigger' &&
            parts[1] === 'webhook' &&
            isWebhookTriggerField(parts[2]!)
          ? parts[2]!
          : null
    if (field !== null) {
      out += webhookTriggerToken(field)
    } else if (body === 'trigger' || body.startsWith('trigger.')) {
      throw new Error('invalid legacy webhook trigger template reference')
    } else if (/^\w+$/.test(body)) {
      // RFC-257 v1 treated every bare word token as a variable candidate and
      // save-time validation rejected names outside WEBHOOK_TEMPLATE_VARS.
      // A hand-written/corrupt historical row must stay invalid; escaping it
      // into a literal would silently legalize data that v1 never admitted.
      throw new Error('unknown legacy webhook template variable')
    } else {
      out += escapeLegacyToken(rawBody) ?? token
    }
    cursor = close + 2
  }
  return out
}

/** Pure payload migration used by CRUD read/write and webhook fire. */
export function migrateWebhookPayloadTemplateToV2(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
): WebhookLaunchPayloadTemplate {
  return mapWebhookTemplateSurfaces(kind, payload, (surface) =>
    migrateWebhookTemplateToV2(surface.text),
  )
}
