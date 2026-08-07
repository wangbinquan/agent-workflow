// RFC-257 — 模板变量的纯函数面（保存期静态校验 + 运行期渲染，前后端共用）。
// 语义（design §4.2）：保存期严格 —— 模板引用变量必须 ⊆ 所选事件类型的交集
// 可用集；运行期宽松 —— 已声明变量缺值渲染为空串。{{event_json}} 按注入面
// 上限截断（agent description / workgroup goal / inputs 值均为 65536 字符上限，
// 256KiB 原文塞进任何注入面都必 422 —— 设计门 F-10）。
import type {
  CodeHostEvent,
  CodeHostEventType,
  WebhookLaunchKind,
  WebhookLaunchPayloadTemplate,
  WebhookTemplateVar,
} from './schemas/webhook'
import {
  WEBHOOK_EVENT_VAR_MATRIX,
  WEBHOOK_TEMPLATE_VARS,
  WebhookAgentPayloadTemplateSchema,
  WebhookWorkflowPayloadTemplateSchema,
  WebhookWorkgroupPayloadTemplateSchema,
} from './schemas/webhook'

/** {{event_json}} 的截断上限（字符）。< 65536 的注入面上限，留出模板其余文字余量。 */
export const EVENT_JSON_VAR_MAX_CHARS = 32 * 1024

/** RFC-263：{{comment_position_json}} 的上限。position 对象只有十来个键，8 KiB 是宽裕的防御值。 */
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

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g
const KNOWN_VARS: ReadonlySet<string> = new Set(WEBHOOK_TEMPLATE_VARS)

/** 提取模板里引用的变量名，known/unknown 分开（unknown → 保存期拒绝）。 */
export function extractTemplateVars(text: string): {
  known: WebhookTemplateVar[]
  unknown: string[]
} {
  const known = new Set<WebhookTemplateVar>()
  const unknown = new Set<string>()
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1]!
    if (KNOWN_VARS.has(name)) known.add(name as WebhookTemplateVar)
    else unknown.add(name)
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
 * 渲染一段模板。表里没有的变量名渲染为空串（防御——保存期已把 unknown 拒掉，
 * 这里兜运行期的枚举演进偏差）。字面 `{{` 不构成合法变量引用时原样保留。
 */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(VAR_RE, (whole, name: string) => {
    void whole
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : ''
  })
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
  if (kind === 'workflow') {
    const p = WebhookWorkflowPayloadTemplateSchema.parse(payload)
    const out: string[] = []
    for (const mapping of Object.values(p.inputs)) {
      if (mapping.kind === 'template') out.push(mapping.template)
    }
    return out
  }
  if (kind === 'agent') {
    const p = WebhookAgentPayloadTemplateSchema.parse(payload)
    const out: string[] = []
    if (p.description !== undefined) out.push(p.description)
    for (const v of Object.values(p.inputs ?? {})) out.push(v)
    return out
  }
  const p = WebhookWorkgroupPayloadTemplateSchema.parse(payload)
  return [p.goal]
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
