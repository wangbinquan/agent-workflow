// RFC-269 — 节点参数的模板渲染与**按位置编码**。纯函数、无 IO。
//
// 这个模块承载 design D12 的那条纪律：**渲染值永不做字符串拼接**。每个变量
// 先渲染成字符串，再按它落在请求的哪个位置各自编码：
//
//   path 段        -> encodeURIComponent（含 '/'），所以变量值不可能新开一个段
//   query 值       -> 交给 URLSearchParams（调用方做），这里只出原文
//   JSON 字符串内  -> JSON 字符串转义，所以正文里的引号/换行破坏不了 body 结构
//
// 为什么这条重要：上游节点的输出常常是**模型写的**（审计结论、评论正文）。
// 一个能改变请求结构的上游值，等价于让上游 agent 替你决定调用了什么——与
// RFC-253 D5「不把上游输出拼进脚本正文」是同一条道理，只是这里的载体从代码
// 换成了 HTTP 请求。

import { triggerContextValue, type TriggerContext } from '../triggerContext'
import {
  extractTemplateRefs,
  parseTemplate,
  renderTemplateRefs,
  type TemplateRefIssue,
} from '../templateRef'

export type CodeHostVarRef =
  | { readonly kind: 'port'; readonly name: string }
  | { readonly kind: 'trigger'; readonly source: string; readonly name: string }
  | { readonly kind: 'invalid'; readonly raw: string; readonly reason: TemplateRefIssue }

export interface CodeHostTemplateContext {
  /** 上游端口值。缺失的端口渲染为空串。 */
  readonly ports: Readonly<Record<string, string>>
  /**
   * 触发事件上下文投影。**null = 该任务不是 webhook 触发的** —— 与「有上下文但
   * 该变量恰好为空」是两回事，执行器要据此给出可读的失败原因（design D24）。
   */
  readonly triggerContext?: TriggerContext | null
}

/** 变量值落在请求的哪个位置，决定编码方式。 */
export type CodeHostEncoding = 'raw' | 'path' | 'json-string'

/** 提取模板引用的全部变量（保存期校验用；按出现顺序，已去重）。 */
export function extractCodeHostVars(text: string): CodeHostVarRef[] {
  return extractTemplateRefs(text).map((ref) =>
    ref.kind === 'local'
      ? { kind: 'port', name: ref.name }
      : ref.kind === 'trigger'
        ? { kind: 'trigger', source: ref.source, name: ref.field }
        : { kind: 'invalid', raw: ref.raw, reason: ref.reason },
  )
}

/** JSON 字符串字面量内部的转义（不含外层引号）。 */
export function jsonStringEscape(value: string): string {
  const quoted = JSON.stringify(value)
  return quoted.slice(1, -1)
}

function encodeValue(value: string, encoding: CodeHostEncoding): string {
  switch (encoding) {
    case 'path':
      return encodeURIComponent(value)
    case 'json-string':
      return jsonStringEscape(value)
    case 'raw':
      return value
  }
}

export interface CodeHostRenderResult {
  readonly value: string
  /** 渲染成空串的引用 —— 调用方据此对**必填**字段报错（可选字段忽略）。 */
  readonly emptyRefs: readonly CodeHostVarRef[]
  /** 引用了 `{{trigger.webhook.*}}` 但该任务根本没有触发上下文。 */
  readonly triggerMissing: boolean
  /** Invalid/legacy refs. Runtime callers must fail before issuing HTTP. */
  readonly invalidRefs: readonly { readonly raw: string; readonly reason: TemplateRefIssue }[]
}

/**
 * 渲染一个参数模板。
 *
 * 未知变量渲染为空串而不是抛错 —— 与 RFC-257 模板「保存期严格、运行期宽松」
 * 的既有分工一致：拼写错在保存期就被校验器拦下了，运行期再抛只会把一个已经
 * 通过校验的工作流炸在半路。真正**必填**的字段为空时由调用方报
 * `code-host-param-missing`，那是一条能说清楚哪个字段空了的错误。
 */
export function renderCodeHostTemplate(
  text: string,
  ctx: CodeHostTemplateContext,
  encoding: CodeHostEncoding = 'raw',
): CodeHostRenderResult {
  const emptyRefs: Array<Exclude<CodeHostVarRef, { kind: 'invalid' }>> = []
  let triggerMissing = false
  const rendered = renderTemplateRefs(text, (templateRef) => {
    const ref: Exclude<CodeHostVarRef, { kind: 'invalid' }> =
      templateRef.kind === 'trigger'
        ? { kind: 'trigger', source: templateRef.source, name: templateRef.field }
        : { kind: 'port', name: templateRef.name }
    let resolved: string
    if (ref.kind === 'trigger') {
      if (ctx.triggerContext === null || ctx.triggerContext === undefined) {
        triggerMissing = true
        resolved = ''
      } else {
        resolved = triggerContextValue(ctx.triggerContext, ref.source, ref.name)
      }
    } else {
      resolved = ctx.ports[ref.name] ?? ''
    }
    if (resolved.length === 0) emptyRefs.push(ref)
    return encodeValue(resolved, encoding)
  })
  return {
    value: rendered.value,
    emptyRefs,
    triggerMissing,
    invalidRefs: rendered.invalid.map((ref) => ({ raw: ref.raw, reason: ref.reason })),
  }
}

// ---------------------------------------------------------------------------
// D13 —— 自定义 JSON body 的变量落点判定
// ---------------------------------------------------------------------------

export type CodeHostJsonBodyIssue =
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'var-outside-string'; readonly ref: string }
  | { readonly kind: 'var-in-key'; readonly ref: string }
  | {
      readonly kind: 'invalid-template-ref'
      readonly ref: string
      readonly reason: TemplateRefIssue
    }

// 纯文本 sentinel：裸着放进 JSON 时**不是**合法 token，所以「替换后还能 parse」
// 本身就证明了每个 sentinel 都落在某个字符串里。用户 body 里恰好含这个字面量
// 只会让诊断指错变量，不影响判定的安全性。
const SENTINEL_PREFIX = '__AW_CODEHOST_VAR_'
const sentinel = (i: number): string => `${SENTINEL_PREFIX}${i}__`

function replaceVars(
  body: string,
  wrap: (index: number) => string,
): { probe: string; raws: string[] } {
  const raws: string[] = []
  let probe = ''
  for (const segment of parseTemplate(body)) {
    if (segment.kind === 'text' || segment.kind === 'literal-ref') {
      probe += segment.value
      continue
    }
    if (segment.kind === 'invalid') {
      probe += body.slice(segment.span.start, segment.span.end)
      continue
    }
    const index = raws.length
    raws.push(segment.ref.raw)
    probe += wrap(index)
  }
  return { probe, raws }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 键名里是否出现了 sentinel（变量当键名用 —— 同样拒绝）。 */
function sentinelInKey(node: unknown): number | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = sentinelInKey(item)
      if (hit !== null) return hit
    }
    return null
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const m = key.match(new RegExp(`${SENTINEL_PREFIX}(\\d+)__`))
      if (m !== null) return Number(m[1])
      const hit = sentinelInKey(value)
      if (hit !== null) return hit
    }
  }
  return null
}

/**
 * 保存期：自定义请求的 JSON body 是否可接受。
 *
 * 两段式探测把「body 本身写坏了」与「变量放错了位置」区分开 —— 两者的修法
 * 完全不同，混成一条 `invalid-json` 只会让人对着合法的 JSON 发呆：
 *
 *   1. 变量替换成**裸** sentinel 后能 parse ⇒ 每个变量都落在某个字符串里，
 *      只需再排除「落在键名上」。
 *   2. parse 不了，就把变量换成**带引号**的完整字符串再试：这次能 parse ⇒
 *      骨架是好的、问题出在变量落点（`{"n": {{x}}}` 这种）；还是不行 ⇒
 *      body 骨架本身非法。
 */
export function codeHostJsonBodyIssue(body: string): CodeHostJsonBodyIssue | null {
  const trimmed = body.trim()
  if (trimmed.length === 0) return null // 空 body 合法（GET / 无 body 的 POST）
  const invalidRef = extractTemplateRefs(trimmed).find((ref) => ref.kind === 'invalid')
  if (invalidRef?.kind === 'invalid') {
    return { kind: 'invalid-template-ref', ref: invalidRef.raw, reason: invalidRef.reason }
  }
  const bare = replaceVars(trimmed, sentinel)
  if (parses(bare.probe)) {
    const keyHit = sentinelInKey(JSON.parse(bare.probe))
    if (keyHit !== null) return { kind: 'var-in-key', ref: bare.raws[keyHit] ?? '' }
    return null
  }
  const quoted = replaceVars(trimmed, (i) => `"${sentinel(i)}"`)
  if (!parses(quoted.probe)) return { kind: 'invalid-json' }
  // 骨架合法 ⇒ 逐个定位第一个不在字符串里的变量：只把第 i 个裸放，其余带引号。
  for (let i = 0; i < quoted.raws.length; i += 1) {
    const probe = replaceVars(trimmed, (j) => (j === i ? sentinel(j) : `"${sentinel(j)}"`)).probe
    if (!parses(probe)) return { kind: 'var-outside-string', ref: quoted.raws[i] ?? '' }
  }
  return { kind: 'invalid-json' }
}

/**
 * 运行期：渲染自定义 body。变量按 JSON 字符串规则转义后代入，再整体 parse ——
 * parse 是**必须**的，它保证送出去的一定是结构合法的 JSON，而不是把一段可能
 * 被上游值改坏的文本直接甩给对方 API。
 */
export function renderCodeHostJsonBody(
  body: string,
  ctx: CodeHostTemplateContext,
):
  | { ok: true; value: unknown; render: CodeHostRenderResult }
  | { ok: false; render: CodeHostRenderResult } {
  const render = renderCodeHostTemplate(body, ctx, 'json-string')
  if (render.invalidRefs.length > 0) return { ok: false, render }
  try {
    return { ok: true, value: JSON.parse(render.value), render }
  } catch {
    return { ok: false, render }
  }
}
