// RFC-269 — `{{trigger.*}}` 的变量集与投影。
//
// 单一事实源纪律：变量集**派生自** RFC-263 的 `WEBHOOK_TEMPLATE_VARS`，不是
// 另抄一份。RFC-263 将来加变量，这里自动跟随；漏跟随会被 shared 的派生关系
// 测试打红。
//
// 唯一被剔除的是 `event_json`（design D15）：它是 32 KiB 截断的完整 payload，
// 塞进一次外部 API 调用没有实际用例，却会把外部原始数据的保留期从「投递表
// 90 天 GC」拉长到「与任务同寿」。需要原始 payload 的场景继续走触发器模板 →
// agent 那条既有路径。

import { z } from 'zod'
import type { CodeHostEvent } from '../schemas/webhook'
import { WEBHOOK_TEMPLATE_VARS, type WebhookTemplateVar } from '../schemas/webhook'
import { eventVarsOf } from '../webhookTemplate'

/** 不进触发上下文快照的变量。 */
export const TRIGGER_CONTEXT_EXCLUDED_VARS = [
  'event_json',
] as const satisfies readonly WebhookTemplateVar[]

export type TriggerContextVar = Exclude<WebhookTemplateVar, 'event_json'>

/** `{{trigger.<var>}}` 的合法 var 集合（29 项）。 */
export const TRIGGER_CONTEXT_VARS: readonly TriggerContextVar[] = WEBHOOK_TEMPLATE_VARS.filter(
  (v): v is TriggerContextVar => !(TRIGGER_CONTEXT_EXCLUDED_VARS as readonly string[]).includes(v),
)

const TRIGGER_CONTEXT_VAR_SET: ReadonlySet<string> = new Set(TRIGGER_CONTEXT_VARS)

export function isTriggerContextVar(name: string): name is TriggerContextVar {
  return TRIGGER_CONTEXT_VAR_SET.has(name)
}

export type TriggerContext = Readonly<Record<string, string>>

/**
 * 落库形态：字符串→字符串的字典。用 record 而不是逐键 object 是有意的 ——
 * 存量行读回来时不该因为 RFC-263 又加了一个变量而 parse 失败（那会让一个
 * **已经跑完**的任务详情页打不开）。未知键在渲染时自然落空串。
 */
export const TriggerContextSchema = z.record(z.string(), z.string())

/** 从归一化事件信封投影出快照（剔除 event_json）。 */
export function triggerContextOf(event: CodeHostEvent): TriggerContext {
  const all = eventVarsOf(event)
  const out: Record<string, string> = {}
  for (const name of TRIGGER_CONTEXT_VARS) {
    const value = all[name]
    // 空值不落库：一个 29 键但大半是空串的 JSON 在任务行里翻倍占地，而
    // 渲染器对「键不存在」与「键存在但为空」的处理本来就一样。
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}
