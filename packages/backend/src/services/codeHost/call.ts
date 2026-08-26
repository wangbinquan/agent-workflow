// RFC-269 — 代码平台调用的执行器。
//
// 一次节点 = 一次出站 HTTP 请求，由 daemon 自己发出。**不 spawn 任何子进程**
// （所以不进入 model runtime 子进程），token 只在本文件里短暂以明文存在：unseal →
// 组 header → 发请求 → 丢弃。
//
// 三条纪律写在这里而不是散在调用方：
//   D12 按位置编码（path / query / JSON 各自的规则），永不字符串拼接；
//   D18 重试按幂等分档 —— POST 的 5xx **不重试**，因为「评论到底发出去没有」
//       无法判定，而重发一次就是一条重复评论；
//   D19 默认不跟随重定向，唯一例外跟随时**剥掉 Authorization**。

import type {
  CodeHostAction,
  CodeHostCustomRequest,
  CodeHostParamMap,
  CodeHostProvider,
  CodeHostRequestBinding,
  CodeHostTemplateContext,
  CodeHostTransform,
  TriggerContext,
} from '@agent-workflow/shared'
import {
  CODE_HOST_BODY_MAX,
  CODE_HOST_PARAM_MAX,
  CODE_HOST_PATH_MAX,
  CODE_HOST_MR_STATE_MAP,
  CODE_HOST_STATUS_STATE_MAP,
  codeHostActionDef,
  codeHostBindingCandidates,
  codeHostPathIssue,
  codeHostRequiredFields,
  INTENT_REDACTED,
  isCodeHostAction,
  isUnsupportedBinding,
  extractCodeHostVars,
  evaluateTriggerDependencies,
  TriggerContextSchema,
  renderCodeHostJsonBody,
  renderCodeHostTemplate,
  projectCodeHostTemplates,
} from '@agent-workflow/shared'
import type { CodeHostFailureCode } from '@agent-workflow/shared'
import {
  codeHostTlsRequestInit,
  type FetchLike,
  type ResolvedCodeHostConnection,
} from '@/services/codeHost/connections'
import { buildCodeHostUrl, redirectTargetIssue } from '@/services/codeHost/url'
import {
  buildCodeHostRecoveryDescriptor,
  type CodeHostSendAttemptInfo,
  type CodeHostSendAttemptObserver,
} from '@/services/taskExecutionParticipants'

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
  /** RFC-328: record every real mutation send before the transport sees it. */
  attemptObserver?: CodeHostSendAttemptObserver
}

export type CodeHostCallOutcome =
  | { ok: true; status: number; body: string; truncated: boolean; method: string; pathname: string }
  | { ok: false; code: CodeHostFailureCode; summary: string; message: string }

export const DEFAULT_CODE_HOST_TIMEOUT_MS = 30_000
export const DEFAULT_CODE_HOST_MAX_RESPONSE_BYTES = 256 * 1024
const MAX_ATTEMPTS = 3

/** 只有“这条路由不存在”才允许换兼容写法；业务错误必须原样暴露。 */
const COMPATIBILITY_FALLBACK_STATUSES: ReadonlySet<number> = new Set([404, 405])

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

function fail(
  code: CodeHostFailureCode,
  summary: string,
  message = summary,
): Extract<CodeHostCallOutcome, { ok: false }> {
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
    case 'integer': {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new ParamError(
          'code-host-param-invalid',
          `'${apiName}' expects a positive integer on ${provider}; got '${value}'`,
        )
      }
      const out = Number(value)
      if (!Number.isSafeInteger(out)) {
        throw new ParamError(
          'code-host-param-invalid',
          `'${apiName}' is outside the safe integer range on ${provider}`,
        )
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

function templateTextsOf(spec: CodeHostCallSpec): string[] {
  return projectCodeHostTemplates(spec).active.map((entry) => entry.text)
}

/** Defense in depth for direct executor callers; launch preflight runs earlier. */
function codeHostTriggerPreflight(
  spec: CodeHostCallSpec,
  context: TriggerContext | null,
): Extract<CodeHostCallOutcome, { ok: false }> | null {
  const refs = new Map<string, { source: string; field: string }>()
  for (const text of templateTextsOf(spec)) {
    for (const ref of extractCodeHostVars(text)) {
      if (ref.kind === 'invalid') {
        return fail('code-host-param-invalid', 'code-host template contains an invalid reference')
      }
      if (ref.kind === 'trigger') {
        refs.set(`${ref.source}\u0000${ref.name}`, { source: ref.source, field: ref.name })
      }
    }
  }
  if (refs.size === 0) return null
  if (context === null) {
    return fail('trigger-context-missing', 'code-host call requires webhook trigger context')
  }
  const parsed = TriggerContextSchema.safeParse(context)
  if (!parsed.success) {
    return fail('trigger-context-invalid', 'the frozen task trigger context is invalid')
  }
  const dependencies = [...refs.values()].map((ref) => ({
    source: ref.source,
    field: ref.field,
    nodeId: 'code-host-call',
    pointer: '/runtime/code-host-call',
  }))
  const issue = evaluateTriggerDependencies(dependencies, {
    kind: 'context',
    value: parsed.data,
  })[0]
  if (issue?.code === 'trigger-field-unavailable') {
    return fail(issue.code, 'a code-host trigger field is unavailable for this event')
  }
  return null
}

function assembledLimitFailure(
  assembled: AssembledRequest,
): Extract<CodeHostCallOutcome, { ok: false }> | null {
  let encodedPathLength = assembled.path.length
  try {
    encodedPathLength = new URL(`https://code-host-limit.invalid${assembled.path}`).pathname.length
  } catch {
    // URL construction below owns the structural error. Retain the raw length
    // here so this guard never turns an invalid URL into a size-only verdict.
  }
  if (encodedPathLength > CODE_HOST_PATH_MAX) {
    return fail('code-host-path-invalid', 'the rendered request path exceeds the allowed size')
  }
  for (const value of Object.values(assembled.query)) {
    const encoded = new URLSearchParams([['v', value]]).toString().slice(2)
    if (encoded.length > CODE_HOST_PARAM_MAX) {
      return fail(
        'code-host-param-invalid',
        'a rendered request parameter exceeds the allowed size',
      )
    }
  }
  if (assembled.body !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(assembled.body)
    } catch {
      return fail('code-host-body-invalid', 'the rendered request body cannot be serialized')
    }
    if (new TextEncoder().encode(serialized).byteLength > CODE_HOST_BODY_MAX) {
      return fail('code-host-body-invalid', 'the rendered request body exceeds the allowed size')
    }
  }
  return null
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
  if (rendered.invalidRefs.length > 0) {
    throw new ParamError('code-host-param-invalid', `'${field}' contains an invalid template ref`)
  }
  return { value: rendered.value, triggerMissing: rendered.triggerMissing }
}

function assembleFromBinding(
  spec: CodeHostCallSpec,
  action: CodeHostAction,
  binding: CodeHostRequestBinding,
  deps: CodeHostCallDeps,
): AssembledRequest {
  const provider = spec.provider
  // 必填校验先行：渲染为空的必填字段要给出「哪个字段空了」，而不是让对方 API
  // 回一个 404 让人猜。
  for (const field of codeHostRequiredFields(action, provider)) {
    const { value, triggerMissing } = renderField(spec, deps, field, 'raw')
    if (value.length > 0) continue
    if (triggerMissing) {
      throw new ParamError('trigger-context-missing', `'${field}' requires webhook trigger context`)
    }
    throw new ParamError('code-host-param-missing', `required field '${field}' is empty`)
  }

  // project：显式值优先；留空则用任务仓库推导出的定位段。
  const explicitProject = renderCodeHostTemplate(spec.params.project ?? '', deps.ctx, 'raw')
  if (explicitProject.invalidRefs.length > 0) {
    throw new ParamError('code-host-param-invalid', "'project' contains an invalid template ref")
  }
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
  const pathRender = renderCodeHostTemplate(request.path, deps.ctx, 'path')
  if (pathRender.invalidRefs.length > 0) {
    throw new ParamError('code-host-param-invalid', 'request path contains an invalid template ref')
  }
  const path = pathRender.value
  const query: Record<string, string> = {}
  for (const [key, template] of Object.entries(request.query ?? {})) {
    const rendered = renderCodeHostTemplate(template, deps.ctx, 'raw')
    if (rendered.invalidRefs.length > 0) {
      throw new ParamError(
        'code-host-param-invalid',
        `query field '${key}' contains an invalid template ref`,
      )
    }
    query[key] = rendered.value
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

  if (isUnsupportedBinding(binding)) {
    return fail(
      'code-host-param-invalid',
      `action '${action}' is not supported on ${spec.provider} (${binding.reasonKey})`,
    )
  }

  const triggerPreflight = codeHostTriggerPreflight(spec, deps.ctx.triggerContext ?? null)
  if (triggerPreflight !== null) return triggerPreflight

  if (action === 'custom') {
    try {
      return (
        await executeAssembledRequest(spec, deps, assembleCustom(spec, deps), {
          candidateId: 'custom:c0',
          compatibilityFallbackAvailable: false,
        })
      ).outcome
    } catch (err) {
      if (err instanceof ParamError) return fail(err.code, err.message)
      throw err
    }
  }

  const candidates = codeHostBindingCandidates(binding)
  let firstMissingOutcome: Extract<CodeHostCallOutcome, { ok: false }> | undefined
  const missingAttempts: string[] = []

  for (let index = 0; index < candidates.length; index += 1) {
    let assembled: AssembledRequest
    try {
      assembled = assembleFromBinding(spec, action, candidates[index]!, deps)
    } catch (err) {
      if (err instanceof ParamError) return fail(err.code, err.message)
      throw err
    }

    const executed = await executeAssembledRequest(spec, deps, assembled, {
      candidateId: `${action}:c${index}`,
      compatibilityFallbackAvailable: index + 1 < candidates.length,
    })
    const routeMissing =
      executed.responseStatus !== undefined &&
      COMPATIBILITY_FALLBACK_STATUSES.has(executed.responseStatus)
    if (!routeMissing) return executed.outcome

    missingAttempts.push(
      `${assembled.method} ${executed.pathname ?? assembled.path} → HTTP ${executed.responseStatus}`,
    )
    if (!executed.outcome.ok && firstMissingOutcome === undefined) {
      firstMissingOutcome = executed.outcome
    }
    if (index + 1 < candidates.length) continue

    if (firstMissingOutcome !== undefined) {
      return {
        ...firstMissingOutcome,
        message: `${firstMissingOutcome.message}\nCompatibility candidates tried: ${missingAttempts.join(', ')}`,
      }
    }
    return executed.outcome
  }

  return fail('code-host-param-invalid', `action '${action}' has no request binding`)
}

interface ExecutedRequest {
  readonly outcome: CodeHostCallOutcome
  /** 仅记录首跳的最终 HTTP 状态；重定向目标失败不能触发 API 路径回退。 */
  readonly responseStatus?: number
  readonly pathname?: string
}

function recoveryPreMutationRequest(
  provider: CodeHostProvider,
  action: CodeHostAction,
  mutationPathname: string,
): Readonly<{ path: string; query: Readonly<Record<string, string>> }> | null {
  if (action === 'mr.merge') {
    return {
      path: mutationPathname.endsWith('/merge')
        ? mutationPathname.slice(0, -'/merge'.length)
        : mutationPathname,
      query: {},
    }
  }
  if (action !== 'pipeline.retry') return null
  if (provider === 'github') {
    return {
      path: mutationPathname.endsWith('/rerun-failed-jobs')
        ? mutationPathname.slice(0, -'/rerun-failed-jobs'.length)
        : mutationPathname,
      query: {},
    }
  }
  const pipelinePath = mutationPathname.endsWith('/retry')
    ? mutationPathname.slice(0, -'/retry'.length)
    : mutationPathname
  return { path: `${pipelinePath}/jobs`, query: { include_retried: 'true' } }
}

async function captureRecoveryPreMutationResponse(input: {
  spec: CodeHostCallSpec
  deps: CodeHostCallDeps
  mutationPathname: string
  doFetch: FetchLike
  headers: Readonly<Record<string, string>>
  timeoutMs: number
}): Promise<Readonly<{ status: number; body: string }> | undefined> {
  if (input.deps.attemptObserver === undefined) return undefined
  const request = recoveryPreMutationRequest(
    input.spec.provider,
    input.spec.action as CodeHostAction,
    input.mutationPathname,
  )
  if (request === null) return undefined
  const built = buildCodeHostUrl(input.deps.connection.baseUrl, request.path, request.query)
  if (!built.ok) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const response = await input.doFetch(built.value.url, {
      method: 'GET',
      headers: input.headers,
      redirect: 'manual',
      ...codeHostTlsRequestInit(input.deps.connection),
      signal: controller.signal,
    })
    // The snapshot is an in-memory input to the digest-only descriptor. Keep a
    // hard bound anyway so a provider cannot inflate the mutation path.
    const body = (await response.text()).slice(0, DEFAULT_CODE_HOST_MAX_RESPONSE_BYTES)
    return { status: response.status, body }
  } catch {
    // Probe availability must never remove the normal mutation capability.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 执行单个候选 binding；每条候选都完整遵守原有 TLS、重试与重定向纪律。 */
async function executeAssembledRequest(
  spec: CodeHostCallSpec,
  deps: CodeHostCallDeps,
  assembled: AssembledRequest,
  candidate: { candidateId: string; compatibilityFallbackAvailable: boolean },
): Promise<ExecutedRequest> {
  const limitFailure = assembledLimitFailure(assembled)
  if (limitFailure !== null) return { outcome: limitFailure }
  const built = buildCodeHostUrl(deps.connection.baseUrl, assembled.path, assembled.query)
  if (!built.ok) {
    return {
      outcome: fail(
        'code-host-path-invalid',
        `the request URL escapes the configured API root (${built.issue})`,
      ),
    }
  }

  const token = deps.connection.token
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = spec.timeoutMs ?? DEFAULT_CODE_HOST_TIMEOUT_MS
  const maxBytes = deps.maxResponseBytes ?? DEFAULT_CODE_HOST_MAX_RESPONSE_BYTES
  const idempotent = IDEMPOTENT_METHODS.has(assembled.method)
  const headers = headersFor(spec.provider, token, assembled.accept)
  const preMutationResponse = await captureRecoveryPreMutationResponse({
    spec,
    deps,
    mutationPathname: assembled.path,
    doFetch,
    headers,
    timeoutMs,
  })
  const recoveryDescriptor = buildCodeHostRecoveryDescriptor({
    provider: spec.provider,
    action: spec.action as CodeHostAction,
    candidateId: candidate.candidateId,
    method: assembled.method,
    pathname: assembled.path,
    query: assembled.query,
    ...(assembled.body !== undefined ? { body: assembled.body } : {}),
    baseUrl: deps.connection.baseUrl,
    ...(deps.connection.connectionGeneration !== undefined
      ? { connectionGeneration: deps.connection.connectionGeneration }
      : {}),
    ...(preMutationResponse !== undefined ? { preMutationResponse } : {}),
  })
  const init: BunFetchRequestInit = {
    method: assembled.method,
    headers:
      assembled.body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    redirect: 'manual',
    ...codeHostTlsRequestInit(deps.connection),
    ...(assembled.body !== undefined ? { body: JSON.stringify(assembled.body) } : {}),
  }

  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptInfo: CodeHostSendAttemptInfo = {
      candidateId: candidate.candidateId,
      transportAttempt: attempt,
      method: assembled.method,
      pathname: built.value.pathname,
      recoveryDescriptor,
    }
    const attemptHandle = (await deps.attemptObserver?.beforeSend(attemptInfo)) ?? null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(built.value.url, { ...init, signal: controller.signal })
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'network error'
      clearTimeout(timer)
      // 网络层失败对 POST 不重试：请求可能已经到达并生效，重发就是第二条评论。
      const willRetry = idempotent && attempt < MAX_ATTEMPTS
      await deps.attemptObserver?.afterSend(attemptHandle, {
        ...attemptInfo,
        result: 'network-error',
        willRetry,
        retryKind: willRetry ? 'transport-policy' : 'none',
        errorMessage: redactToken(lastError, token),
      })
      if (willRetry) {
        await sleep(200 * attempt)
        continue
      }
      return {
        outcome: fail(
          'code-host-network-error',
          `${assembled.method} ${built.value.pathname} failed: ${redactToken(lastError, token)}`,
        ),
      }
    } finally {
      clearTimeout(timer)
    }

    const transportRetry =
      (res.status === 429 || (res.status >= 500 && idempotent)) && attempt < MAX_ATTEMPTS
    const compatibilityRetry =
      !transportRetry &&
      candidate.compatibilityFallbackAvailable &&
      COMPATIBILITY_FALLBACK_STATUSES.has(res.status)
    await deps.attemptObserver?.afterSend(attemptHandle, {
      ...attemptInfo,
      result: 'response',
      status: res.status,
      willRetry: transportRetry || compatibilityRetry,
      retryKind: transportRetry
        ? 'transport-policy'
        : compatibilityRetry
          ? 'compatibility-fallback'
          : 'none',
    })

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
        return {
          outcome: fail(
            'code-host-redirect-refused',
            `${assembled.method} ${built.value.pathname} answered ${res.status}; the platform does not follow cross-host redirects`,
          ),
        }
      }
      const issue = redirectTargetIssue(location)
      if (issue !== null) {
        return {
          outcome: fail('code-host-redirect-refused', `redirect target rejected (${issue})`),
        }
      }
      // 唯一允许跟随的一跳，且**剥掉认证头** —— 目标是第三方签名主机
      // （GitHub 的 job 日志），把我们的 token 送过去就是凭据外泄。
      let followed: Response
      try {
        followed = await doFetch(location, { method: 'GET', redirect: 'manual' })
      } catch (err) {
        return {
          outcome: fail(
            'code-host-network-error',
            `redirect target unreachable: ${redactToken(err instanceof Error ? err.message : 'network error', token)}`,
          ),
        }
      }
      return {
        outcome: await finalize(followed, assembled, built.value.pathname, token, maxBytes),
        pathname: built.value.pathname,
      }
    }

    return {
      outcome: await finalize(res, assembled, built.value.pathname, token, maxBytes),
      responseStatus: res.status,
      pathname: built.value.pathname,
    }
  }

  return {
    outcome: fail(
      'code-host-network-error',
      `${assembled.method} ${built.value.pathname} exhausted ${MAX_ATTEMPTS} attempts: ${redactToken(lastError, token)}`,
    ),
  }
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
