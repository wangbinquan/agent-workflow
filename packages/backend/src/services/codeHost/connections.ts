// RFC-269 — 代码平台凭据的读写与探活。
//
// token 只在这一层短暂以明文存在：unseal → 组 header → 发请求 → 丢弃。它不进
// 任何子进程环境、不进日志、不进任何响应（读路径只回尾 4 位）。

import { eq } from 'drizzle-orm'
import type {
  CodeHostConnectionWire,
  CodeHostProvider,
  CodeHostTestCode,
  CodeHostTestResult,
} from '@agent-workflow/shared'
import { normalizeCodeHostBaseUrl } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { codeHostConnections } from '@/db/schema'
import { ValidationError } from '@/util/errors'

/** 解封后的凭据；只在进程内流转。 */
export interface ResolvedCodeHostConnection {
  provider: CodeHostProvider
  baseUrl: string
  token: string
}

export interface UpsertInput {
  baseUrl: string
  /** 省略 = 保留原 token（要求该 provider 已有行）。 */
  token?: string
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

function hintOf(token: string): string {
  return token.length >= 4 ? token.slice(-4) : ''
}

function unconfigured(provider: CodeHostProvider): CodeHostConnectionWire {
  return {
    provider,
    configured: false,
    baseUrl: '',
    tokenHint: '',
    updatedAt: null,
    updatedBy: null,
    lastTest: null,
  }
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
      return { provider, baseUrl: row.baseUrl, token }
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
      const now = Date.now()
      const values = {
        provider,
        baseUrl: normalized.value,
        tokenEnc,
        tokenHint,
        // base URL 或 token 变了就作废上次的探活结果 —— 留着旧的绿勾会让人以为
        // 新配置已经验证过。
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

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 「测试连接」。四类结果必须**可区分** —— 否则这个按钮只是个安慰剂：管理员
 * 看到红叉却不知道该改 token 还是改 base URL 还是找网络。
 */
export async function probeCodeHostConnection(input: {
  provider: CodeHostProvider
  baseUrl: string
  token: string
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
  let res: Response
  try {
    res = await doFetch(`${normalized.value}${probe.path}`, {
      method: 'GET',
      headers: probe.header(input.token),
      redirect: 'manual',
      signal: controller.signal,
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
