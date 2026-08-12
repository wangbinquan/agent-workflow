// flag-audit W0（§5.6 布尔 query 解析四种口径）——HTTP 布尔 query 参数的统一
// 解析口。收口前同一语义四种写法：oidc `?force` 仅认 'true'（`?force=1` 静默变
// false）、memories 认 'true'|'1'、cached-repos/runtime 认 '1'|'true'、tasks
// `?cascade` 用 `!== 'false'` 的默认真双重否定。统一为：1/true/0/false（大小写
// 不敏感），缺省走调用方声明的 default，其余值 422 fail-loud（而非各站点随机
// 静默取默认）。

import type { Context } from 'hono'
import { ValidationError } from '@/util/errors'

const TRUE_VALUES = new Set(['1', 'true'])
const FALSE_VALUES = new Set(['0', 'false'])

export function parseBoolQuery(c: Context, name: string, opts: { default: boolean }): boolean {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return opts.default
  const v = raw.toLowerCase()
  if (TRUE_VALUES.has(v)) return true
  if (FALSE_VALUES.has(v)) return false
  throw new ValidationError(
    'invalid-bool-query',
    `query parameter '${name}' must be one of 1/true/0/false (got '${raw}')`,
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RFC-284 T5（2026-08-12 审计 N20）——safeJson 按语义族收口。
//
// 此前 20 份本地 `safeJson(req)` 拷贝分三个语义族（{}×13 / throw×4 / 同码异
// 文案×1），强并为一份会改 wire 行为（坏 JSON 的错误码在 `invalid-json` 与
// zod `validation-error` 之间漂移）——设计门路 2 P1。因此收口为**两个** util，
// 各族按现语义对号入座；调用方一律 import 这里，routes 内不得再有本地定义
// （rfc284-safejson-convergence.test.ts 计数锁；webhook 两路由 T28 前豁免）。
//
// string 入参的两个变体（oidcProviders.ts / mcpProbeStore.ts 的 parse-string）
// 语义不同（入参不是 Request），刻意保留本地并在原地注释区分。

/** parse 失败返回 `{}`——下游 zod 以字段级 `validation-error` 报错（{} 族现语义）。 */
export async function safeJsonOrEmpty(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/** parse 失败直接 `invalid-json`（throw 族现语义）；`message` 供 intentSessions
 *  保持其历史文案 "request body must be JSON"（字节级 wire 兼容）。 */
export async function safeJsonOrThrowInvalid(
  req: Request,
  message = 'request body is not valid JSON',
): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', message)
  }
}
