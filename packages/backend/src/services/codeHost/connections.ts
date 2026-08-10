// RFC-269 — 代码平台凭据的读写与探活。
//
// token 只在这一层短暂以明文存在：unseal → 组 header → 发请求 → 丢弃。它不进
// 任何子进程环境、不进日志、不进任何响应（读路径只回尾 4 位）。

import { existsSync, readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import type {
  CodeHostConnectionWire,
  CodeHostProvider,
  CodeHostTestCode,
  CodeHostTestResult,
} from '@agent-workflow/shared'
import { normalizeCodeHostBaseUrl } from '@agent-workflow/shared'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { codeHostConnections } from '@/db/schema'
import { ValidationError } from '@/util/errors'

/** 解封后的凭据；只在进程内流转。 */
export interface ResolvedCodeHostConnection {
  provider: CodeHostProvider
  baseUrl: string
  token: string
  /** false is an explicit, GitLab-only TLS trust downgrade. */
  rejectUnauthorized: boolean
}

export interface UpsertInput {
  baseUrl: string
  /** 省略 = 保留原 token（要求该 provider 已有行）。 */
  token?: string
  /** 省略 = 首次为 true、已有行保留；false 只允许 GitLab。 */
  rejectUnauthorized?: boolean
  actorUserId?: string | null
}

export interface CodeHostConnectionsService {
  /** 供执行器使用：解封后的完整凭据；未配置返回 null。 */
  resolve(provider: CodeHostProvider): ResolvedCodeHostConnection | null
  /** 供 API 使用：两家各一行，未配置的也出现（configured:false）。 */
  list(): CodeHostConnectionWire[]
  get(provider: CodeHostProvider): CodeHostConnectionWire
  upsert(provider: CodeHostProvider, input: UpsertInput): CodeHostConnectionWire
  remove(provider: CodeHostProvider): boolean
  recordTest(provider: CodeHostProvider, result: CodeHostTestResult): void
}

const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

/**
 * TLS 信任策略的唯一 provider 判据。GitHub 当前没有该能力；静默接受 false
 * 会制造“保存成功但实际仍校验”的假配置，因此在服务边界明确拒绝。
 */
export function normalizeCodeHostRejectUnauthorized(
  provider: CodeHostProvider,
  value: boolean | undefined,
): boolean {
  if (provider !== 'gitlab' && value === false) {
    throw new ValidationError(
      'code-host-tls-option-unsupported',
      'disabling TLS certificate verification is supported only for GitLab connections',
      { provider },
    )
  }
  return provider === 'gitlab' ? (value ?? true) : true
}

/** Bun fetch 的逐请求 TLS 片段；默认完全省略 override。 */
export function codeHostTlsRequestInit(input: {
  provider: CodeHostProvider
  rejectUnauthorized?: boolean
}): Pick<BunFetchRequestInit, 'tls'> {
  const rejectUnauthorized = normalizeCodeHostRejectUnauthorized(
    input.provider,
    input.rejectUnauthorized,
  )
  return rejectUnauthorized ? {} : { tls: { rejectUnauthorized: false } }
}

function hintOf(token: string): string {
  return token.length >= 4 ? token.slice(-4) : ''
}

function unconfigured(provider: CodeHostProvider): CodeHostConnectionWire {
  return {
    provider,
    configured: false,
    baseUrl: '',
    rejectUnauthorized: true,
    tokenHint: '',
    updatedAt: null,
    updatedBy: null,
    lastTest: null,
  }
}

/**
 * RFC-269 接线修复（2026-08-10 本机验收）——凭据服务此前**只**在
 * `mountCodeHostRoutes` 里就地构造，全仓没有任何生产路径把它注进 scheduler，
 * 于是 `code-host-call` 节点在真实运行里恒定 `code-host-not-configured`：
 * 与「管理员根本没配」完全同形，实测已配好且 `/test` 返回 ok 仍然照失败。
 *
 * 为什么收在这里而不是逐个 launch 入口补注入：`resolveLaunchRuntimeConfig`
 * 的十四处展开点各自拼 deps，同一形状的参数已经栽过两次（RFC-115 的
 * `defaultRuntime`「从没被任何 HTTP 入口穿过」、RFC-266 的 fan-out 上限
 * 「被设置页写入、被 scheduler 消费、中间没人接线」）。再补第十五处只会
 * 再漂一次，所以留**一个**懒解析点，注入仍然优先（测试照旧注 stub）。
 *
 * 只读、绝不创建：`ensureSecretKey` 在缺文件时会**生成**密钥，而这条路径每
 * 派发一个 code-host 节点就走一次，必须无副作用（同 verifiedPlan 里
 * `readConfig` 而非 `loadConfig` 的既有纪律）。密钥缺失/损坏 ⇒ 返回 null，
 * 节点仍以 `code-host-not-configured` 收场，与自跳过语义一致。
 */
export function resolveCodeHostConnectionsFromKeyFile(
  db: DbClient,
  keyPath: string,
): CodeHostConnectionsService | null {
  if (!existsSync(keyPath)) return null
  let secretBox: SecretBox
  try {
    secretBox = createSecretBoxFromKey(readFileSync(keyPath))
  } catch {
    return null
  }
  return createCodeHostConnectionsService({ db, secretBox })
}

export function createCodeHostConnectionsService(deps: {
  db: DbClient
  secretBox: SecretBox
}): CodeHostConnectionsService {
  const { db, secretBox } = deps

  function rowOf(provider: CodeHostProvider): typeof codeHostConnections.$inferSelect | undefined {
    return db
      .select()
      .from(codeHostConnections)
      .where(eq(codeHostConnections.provider, provider))
      .all()[0]
  }

  function toWire(row: typeof codeHostConnections.$inferSelect): CodeHostConnectionWire {
    let lastTest: CodeHostTestResult | null = null
    if (row.lastTestJson !== null) {
      try {
        lastTest = JSON.parse(row.lastTestJson) as CodeHostTestResult
      } catch {
        // 坏掉的展示字段不该让整个设置页 500。
        lastTest = null
      }
    }
    return {
      provider: row.provider,
      configured: true,
      baseUrl: row.baseUrl,
      rejectUnauthorized: normalizeCodeHostRejectUnauthorized(row.provider, row.rejectUnauthorized),
      tokenHint: row.tokenHint,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      lastTest,
    }
  }

  return {
    resolve(provider) {
      const row = rowOf(provider)
      if (row === undefined) return null
      let token: string
      try {
        token = secretBox.unseal(row.tokenEnc)
      } catch {
        // secret.key 换过 / 密文损坏。当作未配置，让调用方报
        // `code-host-not-configured` 并提示重录，而不是拿空 token 去打 401。
        return null
      }
      return {
        provider,
        baseUrl: row.baseUrl,
        token,
        rejectUnauthorized: normalizeCodeHostRejectUnauthorized(provider, row.rejectUnauthorized),
      }
    },

    list() {
      return PROVIDERS.map((p) => {
        const row = rowOf(p)
        return row === undefined ? unconfigured(p) : toWire(row)
      })
    },

    get(provider) {
      const row = rowOf(provider)
      return row === undefined ? unconfigured(provider) : toWire(row)
    },

    upsert(provider, input) {
      const normalized = normalizeCodeHostBaseUrl(input.baseUrl, provider)
      if (!normalized.ok) {
        throw new ValidationError(
          'code-host-base-url-invalid',
          `base URL is not a valid ${provider} API root (${normalized.issue})`,
          { issue: normalized.issue, provider },
        )
      }
      const existing = rowOf(provider)
      let tokenEnc: string
      let tokenHint: string
      if (input.token !== undefined) {
        tokenEnc = secretBox.seal(input.token)
        tokenHint = hintOf(input.token)
      } else if (existing !== undefined) {
        tokenEnc = existing.tokenEnc
        tokenHint = existing.tokenHint
      } else {
        throw new ValidationError(
          'code-host-token-required',
          'a token is required when configuring this code host for the first time',
          { provider },
        )
      }
      const rejectUnauthorized = normalizeCodeHostRejectUnauthorized(
        provider,
        input.rejectUnauthorized ?? existing?.rejectUnauthorized,
      )
      const now = Date.now()
      const values = {
        provider,
        baseUrl: normalized.value,
        rejectUnauthorized,
        tokenEnc,
        tokenHint,
        // base URL、token 或 TLS 策略变了就作废上次的探活结果 —— 留着旧的绿勾
        // 会让人以为新配置已经验证过。
        lastTestJson: null,
        updatedAt: now,
        updatedBy: input.actorUserId ?? null,
      }
      db.insert(codeHostConnections)
        .values(values)
        .onConflictDoUpdate({ target: codeHostConnections.provider, set: values })
        .run()
      const row = rowOf(provider)
      return row === undefined ? unconfigured(provider) : toWire(row)
    },

    remove(provider) {
      const existing = rowOf(provider)
      if (existing === undefined) return false
      db.delete(codeHostConnections).where(eq(codeHostConnections.provider, provider)).run()
      return true
    },

    recordTest(provider, result) {
      db.update(codeHostConnections)
        .set({ lastTestJson: JSON.stringify(result) })
        .where(eq(codeHostConnections.provider, provider))
        .run()
    },
  }
}

// ---------------------------------------------------------------------------
// 探活
// ---------------------------------------------------------------------------

/** 各家的身份端点与「成功长什么样」。 */
const IDENTITY_PROBE: Readonly<
  Record<
    CodeHostProvider,
    { path: string; loginField: string; header: (t: string) => Record<string, string> }
  >
> = {
  gitlab: {
    path: '/user',
    loginField: 'username',
    header: (token) => ({ 'PRIVATE-TOKEN': token }),
  },
  github: {
    path: '/user',
    loginField: 'login',
    header: (token) => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }),
  },
}

export type FetchLike = (url: string, init?: BunFetchRequestInit) => Promise<Response>

/**
 * 「测试连接」。四类结果必须**可区分** —— 否则这个按钮只是个安慰剂：管理员
 * 看到红叉却不知道该改 token 还是改 base URL 还是找网络。
 */
export async function probeCodeHostConnection(input: {
  provider: CodeHostProvider
  baseUrl: string
  token: string
  rejectUnauthorized?: boolean
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<CodeHostTestResult> {
  const probe = IDENTITY_PROBE[input.provider]
  const at = Date.now()
  const normalized = normalizeCodeHostBaseUrl(input.baseUrl, input.provider)
  if (!normalized.ok) {
    return { ok: false, at, code: 'not-found', message: `base URL invalid (${normalized.issue})` }
  }
  const doFetch = input.fetchImpl ?? ((url, init) => fetch(url, init))
  const tls = codeHostTlsRequestInit(input)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
  let res: Response
  try {
    res = await doFetch(`${normalized.value}${probe.path}`, {
      method: 'GET',
      headers: probe.header(input.token),
      redirect: 'manual',
      signal: controller.signal,
      ...tls,
    })
  } catch (err) {
    return {
      ok: false,
      at,
      code: 'unreachable',
      message: err instanceof Error ? err.message : 'network error',
    }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, at, code: 'unauthorized', message: `HTTP ${res.status}` }
  }
  if (!res.ok) {
    // 404 是"base URL 指到了非 API 根"的典型症状；其余非 2xx 同档处理，
    // 状态码本身已经把话说清楚了。
    return { ok: false, at, code: 'not-found', message: `HTTP ${res.status}` }
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return { ok: false, at, code: 'bad-response', message: 'response was not JSON' }
  }
  const login = (payload as Record<string, unknown> | null)?.[probe.loginField]
  if (typeof login !== 'string' || login.length === 0) {
    return {
      ok: false,
      at,
      code: 'bad-response',
      message: `response has no '${probe.loginField}' field`,
    }
  }
  return { ok: true, at, login }
}

/** 探活结果里的 code → 面向 UI 的 i18n key 后缀（前端渲染用）。 */
export function testCodeOf(result: CodeHostTestResult): CodeHostTestCode | 'ok' {
  return result.ok ? 'ok' : (result.code ?? 'bad-response')
}
