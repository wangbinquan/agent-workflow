// RFC-269 — 代码平台调用的执行器。
//
// 一次节点 = 一次出站 HTTP 请求，由 daemon 自己发出。**不 spawn 任何子进程**
// （所以不进 containment 准入面），token 只在本文件里短暂以明文存在：unseal →
// 组 header → 发请求 → 丢弃。
//
// 三条纪律写在这里而不是散在调用方：
//   D12 按位置编码（path / query / JSON 各自的规则），永不字符串拼接；
//   D18 重试按幂等分档 —— POST 的 5xx **不重试**，因为「评论到底发出去没有」
//       无法判定，而重发一次就是一条重复评论；
//   D19 默认不跟随重定向，唯一例外跟随时**剥掉 Authorization**。

import type {
  CodeHostAction,
  CodeHostBinding,
  CodeHostCustomRequest,
  CodeHostParamMap,
  CodeHostProvider,
  CodeHostTemplateContext,
  CodeHostTransform,
} from '@agent-workflow/shared'
import {
  CODE_HOST_MR_STATE_MAP,
  CODE_HOST_STATUS_STATE_MAP,
  codeHostActionDef,
  codeHostPathIssue,
  codeHostRequiredFields,
  INTENT_REDACTED,
  isCodeHostAction,
  isUnsupportedBinding,
  renderCodeHostJsonBody,
  renderCodeHostTemplate,
} from '@agent-workflow/shared'
import type { CodeHostFailureCode } from '@agent-workflow/shared'
import type { ResolvedCodeHostConnection } from '@/services/codeHost/connections'
import { buildCodeHostUrl, redirectTargetIssue } from '@/services/codeHost/url'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** 节点定义里与执行相关的那一份（scheduler 从 WorkflowNode 读出后传进来）。 */
export interface CodeHostCallSpec {
  provider: CodeHostProvider
  action: string
  params: Readonly<Record<string, string>>
  request?: CodeHostCustomRequest
  allowDestructive?: boolean
  timeoutMs?: number
}

/** project 定位段的推导结果（`params.project` 留空时用）。 */
export type ProjectFallback =
  | { ok: true; value: string }
  | { ok: false; code: CodeHostFailureCode; message: string }

export interface CodeHostCallDeps {
  connection: ResolvedCodeHostConnection
  ctx: CodeHostTemplateContext
  projectFallback: ProjectFallback
  fetchImpl?: FetchLike
  maxResponseBytes?: number
  /** 测试用：让退避不真的睡。 */
  sleep?: (ms: number) => Promise<void>
}

export type CodeHostCallOutcome =
  | { ok: true; status: number; body: string; truncated: boolean; method: string; pathname: string }
  | { ok: false; code: CodeHostFailureCode; summary: string; message: string }

export const DEFAULT_CODE_HOST_TIMEOUT_MS = 30_000
export const DEFAULT_CODE_HOST_MAX_RESPONSE_BYTES = 256 * 1024
const MAX_ATTEMPTS = 3

/** 幂等 method：网络抖动/5xx 可以安全重发。POST 不在其中（D18）。 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'PUT', 'PATCH', 'DELETE'])

/** 能当文本读的响应类型；其余（zip/二进制）报 unreadable 而不是塞一堆替换字符给下游。 */
function isTextualContentType(raw: string | null): boolean {
  if (raw === null || raw.trim().length === 0) return true
  const type = raw.split(';')[0]!.trim().toLowerCase()
  if (type.startsWith('text/')) return true
  return (
    type === 'application/json' ||
    type === 'application/xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  )
}

function fail(code: CodeHostFailureCode, summary: string, message = summary): CodeHostCallOutcome {
  return { ok: false, code, summary, message }
}

/** token 脱敏的最后一道网。结构上 token 不进任何被记录的字符串，这是兜底。 */
export function redactToken(text: string, token: string): string {
  // 太短的 token 全局替换会误伤正常文本；那种 token 也不该存在于生产。
  if (token.length < 8) return text
  return text.split(token).join(INTENT_REDACTED)
}

function headersFor(
  provider: CodeHostProvider,
  token: string,
  accept?: string,
): Record<string, string> {
  if (provider === 'gitlab') {
    return { 'PRIVATE-TOKEN': token, Accept: accept ?? 'application/json' }
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

// ---------------------------------------------------------------------------
// 值变换
// ---------------------------------------------------------------------------

class ParamError extends Error {
  constructor(
    readonly code: CodeHostFailureCode,
    message: string,
  ) {
    super(message)
  }
}

function csvParts(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function applyTransform(
  value: string,
  transform: CodeHostTransform | undefined,
  provider: CodeHostProvider,
  apiName: string,
): unknown {
  switch (transform) {
    case undefined:
      return value
    case 'csv-array':
      return csvParts(value)
    case 'csv-number-array': {
      const out: number[] = []
      for (const part of csvParts(value)) {
        const n = Number(part)
        if (!Number.isFinite(n)) {
          throw new ParamError(
            'code-host-param-invalid',
            `'${apiName}' expects numeric ids on ${provider}; got '${part}'`,
          )
        }
        out.push(n)
      }
      return out
    }
    case 'json-object':
      try {
        return JSON.parse(value)
      } catch {
        throw new ParamError('code-host-param-invalid', `'${apiName}' is not valid JSON`)
      }
    case 'status-state': {
      const mapped = CODE_HOST_STATUS_STATE_MAP[provider][value]
      if (mapped === undefined) {
        throw new ParamError(
          'code-host-param-invalid',
          `state must be one of pending / success / failed; got '${value}'`,
        )
      }
      return mapped
    }
    case 'mr-state': {
      const mapped = CODE_HOST_MR_STATE_MAP[provider][value]
      if (mapped === undefined) {
        throw new ParamError(
          'code-host-param-invalid',
          `state must be one of open / closed / all; got '${value}'`,
        )
      }
      return mapped
    }
    case 'boolean': {
      if (value === 'true') return true
      if (value === 'false') return false
      throw new ParamError('code-host-param-invalid', `'${apiName}' must be true or false`)
    }
  }
}

// ---------------------------------------------------------------------------
// 请求组装
// ---------------------------------------------------------------------------

interface AssembledRequest {
  method: string
  path: string
  query: Record<string, string>
  body?: unknown
  accept?: string
  followRedirectStripAuth: boolean
}

/**
 * 显式填写的 project 定位段的编码。
 *
 * 只把 `/` 换成 `%2F`（GitLab），不做完整 `encodeURIComponent` —— 那会把用户
 * **已经**写成 `grp%2Frepo` 的值二次编码成 `grp%252Frepo`。这条规则让三种自然
 * 写法都对：`grp/repo`、`grp%2Frepo`、数字 id。
 *
 * GitHub 侧原样保留：那里的 `owner/repo` 本来就是**两个**路径段。
 */
function encodeProjectLocator(value: string, provider: CodeHostProvider): string {
  return provider === 'gitlab' ? value.replace(/\//g, '%2F') : value
}

function renderField(
  spec: CodeHostCallSpec,
  deps: CodeHostCallDeps,
  field: string,
  encoding: 'raw' | 'path',
): { value: string; triggerMissing: boolean } {
  const template = spec.params[field] ?? ''
  const rendered = renderCodeHostTemplate(template, deps.ctx, encoding)
  return { value: rendered.value, triggerMissing: rendered.triggerMissing }
}

function assembleFromBinding(
  spec: CodeHostCallSpec,
  action: CodeHostAction,
  binding: CodeHostBinding,
  deps: CodeHostCallDeps,
): AssembledRequest {
  const provider = spec.provider
  // 必填校验先行：渲染为空的必填字段要给出「哪个字段空了」，而不是让对方 API
  // 回一个 404 让人猜。
  for (const field of codeHostRequiredFields(action, provider)) {
    const { value, triggerMissing } = renderField(spec, deps, field, 'raw')
    if (value.length > 0) continue
    if (triggerMissing) {
      throw new ParamError(
        'code-host-trigger-context-missing',
        `'${field}' resolves from {{trigger.*}}, but this task was not started by a webhook`,
      )
    }
    throw new ParamError('code-host-param-missing', `required field '${field}' is empty`)
  }

  // project：显式值优先；留空则用任务仓库推导出的定位段。
  const explicitProject = renderCodeHostTemplate(spec.params.project ?? '', deps.ctx, 'raw')
  let project: string
  if (explicitProject.value.length > 0) {
    project = encodeProjectLocator(explicitProject.value, provider)
  } else if (deps.projectFallback.ok) {
    project = deps.projectFallback.value
  } else {
    throw new ParamError(deps.projectFallback.code, deps.projectFallback.message)
  }

  const path = binding.path.replace(/\{([A-Za-z_][\w]*)\}/g, (_m, name: string) => {
    // `__project__` 已经是定位段（推导值自带编码、显式值走 encodeProjectLocator），
    // 不能再编码一次。
    if (name === '__project__') return project
    // **整段编码**而不是只编码模板变量：字段值是一个路径段，字面量同样要编码。
    // GitLab 的文件端点就靠这个 —— `src/a b.ts` 必须变成 `src%2Fa%20b.ts`，
    // 否则那些斜杠会被当成新的路径段（然后 404）。
    return encodeURIComponent(renderField(spec, deps, name, 'raw').value)
  })

  const query: Record<string, string> = {}
  for (const map of binding.query ?? []) {
    const raw = valueOfMap(map, spec, deps)
    if (raw === null) continue
    const transformed = applyTransform(raw, map.transform, provider, map.api)
    query[map.api] = typeof transformed === 'string' ? transformed : JSON.stringify(transformed)
  }

  let body: unknown
  const bodyMaps = binding.body ?? []
  if (bodyMaps.length > 0) {
    const obj: Record<string, unknown> = {}
    for (const map of bodyMaps) {
      if ('literal' in map.from) {
        obj[map.api] = map.from.literal
        continue
      }
      const raw = valueOfMap(map, spec, deps)
      if (raw === null) continue
      const transformed = applyTransform(raw, map.transform, provider, map.api)
      if (map.api === '*') {
        if (
          transformed !== null &&
          typeof transformed === 'object' &&
          !Array.isArray(transformed)
        ) {
          Object.assign(obj, transformed)
        } else {
          throw new ParamError(
            'code-host-param-invalid',
            'the position payload must be a JSON object',
          )
        }
      } else {
        obj[map.api] = transformed
      }
    }
    if (Object.keys(obj).length > 0) body = obj
  }

  return {
    method: binding.method,
    path,
    query,
    ...(body !== undefined ? { body } : {}),
    ...(binding.accept !== undefined ? { accept: binding.accept } : {}),
    followRedirectStripAuth: binding.quirks?.includes('followRedirectStripAuth') === true,
  }
}

/** 取一个 param map 的原始字符串值；`omitIfEmpty` 命中时返回 null 表示省略。 */
function valueOfMap(
  map: CodeHostParamMap,
  spec: CodeHostCallSpec,
  deps: CodeHostCallDeps,
): string | null {
  if ('literal' in map.from) return String(map.from.literal)
  const rendered = renderField(spec, deps, map.from.field, 'raw')
  if (rendered.value.length === 0 && map.omitIfEmpty === true) return null
  if (rendered.value.length === 0) return null
  return rendered.value
}

function assembleCustom(spec: CodeHostCallSpec, deps: CodeHostCallDeps): AssembledRequest {
  const request = spec.request
  if (request === undefined) {
    throw new ParamError('code-host-param-missing', "action 'custom' requires a request definition")
  }
  if (request.method === 'DELETE' && spec.allowDestructive !== true) {
    throw new ParamError(
      'code-host-param-invalid',
      'DELETE requires the node to explicitly allow destructive methods',
    )
  }
  const pathIssue = codeHostPathIssue(request.path)
  if (pathIssue !== null) {
    throw new ParamError('code-host-path-invalid', `request path rejected (${pathIssue})`)
  }
  const path = renderCodeHostTemplate(request.path, deps.ctx, 'path').value
  const query: Record<string, string> = {}
  for (const [key, template] of Object.entries(request.query ?? {})) {
    query[key] = renderCodeHostTemplate(template, deps.ctx, 'raw').value
  }
  let body: unknown
  if (request.body !== undefined && request.body.trim().length > 0) {
    const rendered = renderCodeHostJsonBody(request.body, deps.ctx)
    if (!rendered.ok) {
      throw new ParamError(
        'code-host-body-invalid',
        'the rendered request body is not valid JSON (a template value may have broken its structure)',
      )
    }
    body = rendered.value
  }
  return {
    method: request.method,
    path,
    query,
    ...(body !== undefined ? { body } : {}),
    followRedirectStripAuth: false,
  }
}

// ---------------------------------------------------------------------------
// 响应读取（有界）
// ---------------------------------------------------------------------------

async function readBounded(
  res: Response,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (reader === undefined) return { text: '', truncated: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    if (total + value.byteLength > max) {
      chunks.push(value.subarray(0, max - total))
      total = max
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text = new TextDecoder().decode(merged)
  if (truncated) {
    // 静默截断最坏：下游 agent 会在半截 JSON 上下结论。标记必须留在正文里。
    text += `\n[truncated: response exceeded ${max} bytes]`
  }
  return { text, truncated }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function executeCodeHostCall(
  spec: CodeHostCallSpec,
  deps: CodeHostCallDeps,
): Promise<CodeHostCallOutcome> {
  if (!isCodeHostAction(spec.action)) {
    return fail('code-host-param-invalid', `unknown action '${spec.action}'`)
  }
  const action = spec.action
  const def = codeHostActionDef(action)
  const binding = def.bindings[spec.provider]

  let assembled: AssembledRequest
  try {
    assembled =
      action === 'custom'
        ? assembleCustom(spec, deps)
        : isUnsupportedBinding(binding)
          ? (() => {
              throw new ParamError(
                'code-host-param-invalid',
                `action '${action}' is not supported on ${spec.provider} (${binding.reasonKey})`,
              )
            })()
          : assembleFromBinding(spec, action, binding, deps)
  } catch (err) {
    if (err instanceof ParamError) return fail(err.code, err.message)
    throw err
  }

  const built = buildCodeHostUrl(deps.connection.baseUrl, assembled.path, assembled.query)
  if (!built.ok) {
    return fail(
      'code-host-path-invalid',
      `the request URL escapes the configured API root (${built.issue})`,
    )
  }

  const token = deps.connection.token
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = spec.timeoutMs ?? DEFAULT_CODE_HOST_TIMEOUT_MS
  const maxBytes = deps.maxResponseBytes ?? DEFAULT_CODE_HOST_MAX_RESPONSE_BYTES
  const idempotent = IDEMPOTENT_METHODS.has(assembled.method)
  const headers = headersFor(spec.provider, token, assembled.accept)
  const init: RequestInit = {
    method: assembled.method,
    headers:
      assembled.body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    redirect: 'manual',
    ...(assembled.body !== undefined ? { body: JSON.stringify(assembled.body) } : {}),
  }

  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(built.value.url, { ...init, signal: controller.signal })
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'network error'
      clearTimeout(timer)
      // 网络层失败对 POST 不重试：请求可能已经到达并生效，重发就是第二条评论。
      if (idempotent && attempt < MAX_ATTEMPTS) {
        await sleep(200 * attempt)
        continue
      }
      return fail(
        'code-host-network-error',
        `${assembled.method} ${built.value.pathname} failed: ${redactToken(lastError, token)}`,
      )
    } finally {
      clearTimeout(timer)
    }

    // 429：请求**没有**被执行，所以对任何 method 重试都是安全的。
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '')
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt)
      continue
    }
    if (res.status >= 500 && idempotent && attempt < MAX_ATTEMPTS) {
      await sleep(200 * attempt)
      continue
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!assembled.followRedirectStripAuth || location === null) {
        return fail(
          'code-host-redirect-refused',
          `${assembled.method} ${built.value.pathname} answered ${res.status}; the platform does not follow cross-host redirects`,
        )
      }
      const issue = redirectTargetIssue(location)
      if (issue !== null) {
        return fail('code-host-redirect-refused', `redirect target rejected (${issue})`)
      }
      // 唯一允许跟随的一跳，且**剥掉认证头** —— 目标是第三方签名主机
      // （GitHub 的 job 日志），把我们的 token 送过去就是凭据外泄。
      let followed: Response
      try {
        followed = await doFetch(location, { method: 'GET', redirect: 'manual' })
      } catch (err) {
        return fail(
          'code-host-network-error',
          `redirect target unreachable: ${redactToken(err instanceof Error ? err.message : 'network error', token)}`,
        )
      }
      return await finalize(followed, assembled, built.value.pathname, token, maxBytes)
    }

    return await finalize(res, assembled, built.value.pathname, token, maxBytes)
  }

  return fail(
    'code-host-network-error',
    `${assembled.method} ${built.value.pathname} exhausted ${MAX_ATTEMPTS} attempts: ${redactToken(lastError, token)}`,
  )
}

async function finalize(
  res: Response,
  assembled: AssembledRequest,
  pathname: string,
  token: string,
  maxBytes: number,
): Promise<CodeHostCallOutcome> {
  if (!isTextualContentType(res.headers.get('content-type'))) {
    return fail(
      'code-host-response-unreadable',
      `${assembled.method} ${pathname} returned ${res.headers.get('content-type')}; only text responses can become a port value`,
    )
  }
  const { text, truncated } = await readBounded(res, maxBytes)
  const safe = redactToken(text, token)
  if (res.status < 200 || res.status >= 300) {
    return fail(
      'code-host-http-error',
      `${assembled.method} ${pathname} → HTTP ${res.status}`,
      `${assembled.method} ${pathname} → HTTP ${res.status}\n${safe.slice(0, 2048)}`,
    )
  }
  return {
    ok: true,
    status: res.status,
    body: safe,
    truncated,
    method: assembled.method,
    pathname,
  }
}
