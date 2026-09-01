// RFC-269 — 代码平台凭据的读写与探活。
//
// token 只在这一层短暂以明文存在：unseal → 组 header → 发请求 → 丢弃。它不进
// 任何子进程环境、不进日志、不进任何响应（读路径只回尾 4 位）。

import { existsSync, readFileSync } from 'node:fs'
import { ulid } from 'ulid'
import type {
  CodeHostConnectionWire,
  CodeHostProvider,
  CodeHostTestCode,
  CodeHostTestResult,
  RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import {
  normalizeCodeHostBaseUrl,
  normalizeGitLabRepositoryUrlPrefix,
  normalizeRepositoryTransportMappings,
  RepositoryTransportMappingV1Schema,
} from '@agent-workflow/shared'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import { ConflictError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

/** 解封后的凭据；只在进程内流转。 */
export interface ResolvedCodeHostConnection {
  provider: CodeHostProvider
  baseUrl: string
  repositoryUrlPrefixes: string[]
  /** Present on persisted connections; optional keeps legacy test/adaptor stubs source-compatible. */
  transportMappings?: RepositoryTransportMappingV1[]
  /** Present on persisted connections; optional keeps legacy test/adaptor stubs source-compatible. */
  connectionGeneration?: string
  token: string
  /** false is an explicit, GitLab-only TLS trust downgrade. */
  rejectUnauthorized: boolean
}

export interface UpsertInput {
  baseUrl: string
  /** GitLab-only; omission preserves the stored collection. */
  repositoryUrlPrefixes?: readonly string[]
  /** Both providers; omission preserves the stored collection. */
  transportMappings?: readonly RepositoryTransportMappingV1[]
  /** 省略 = 保留原 token（要求该 provider 已有行）。 */
  token?: string
  /** 省略 = 首次为 true、已有行保留；false 只允许 GitLab。 */
  rejectUnauthorized?: boolean
  expectedConnectionGeneration?: string
  confirmCredentialRevocationDigest?: string
  actorUserId?: string | null
}

export interface CodeHostConnectionMutationConfirmation {
  readonly expectedConnectionGeneration?: string
  readonly confirmCredentialRevocationDigest?: string
}

interface RepositoryTransportAdminConnection {
  readonly provider: CodeHostProvider
  readonly baseUrl: string
  readonly repositoryUrlPrefixesJson: string
  readonly transportMappingsJson: string
  readonly connectionGeneration: string
  readonly rejectUnauthorized: boolean
  readonly tokenEnc: string
  readonly tokenHint: string
  readonly lastTestJson: string | null
  readonly updatedAt: number
  readonly updatedBy: string | null
}

interface RepositoryTransportConnectionAdministrationParticipant {
  listAdminConnections(): Promise<readonly RepositoryTransportAdminConnection[]>
  findAdminConnection(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportAdminConnection | null>
  inspectAdminConnection(provider: CodeHostProvider): Promise<{
    readonly personalCredentialCount: number
    readonly currentConnectionGeneration: string | null
    readonly currentEndpointBindingDigest: string | null
  }>
  projectAdminConnection(input: RepositoryTransportAdminConnection): {
    readonly endpointBindingDigest: string
  }
  synchronizeAdminConnection(
    input: RepositoryTransportAdminConnection,
    expected: {
      readonly personalCredentialCount: number
      readonly currentConnectionGeneration: string | null
      readonly currentEndpointBindingDigest: string | null
    },
  ): Promise<boolean>
  removeAdminConnection(
    provider: CodeHostProvider,
    expected: {
      readonly personalCredentialCount: number
      readonly currentConnectionGeneration: string | null
      readonly currentEndpointBindingDigest: string | null
    },
  ): Promise<'removed' | 'missing' | 'stale'>
  recordAdminConnectionTest(provider: CodeHostProvider, result: CodeHostTestResult): Promise<void>
}

export interface CodeHostConnectionsService {
  /** 供执行器使用：解封后的完整凭据；未配置返回 null。 */
  resolve(provider: CodeHostProvider): Promise<ResolvedCodeHostConnection | null>
  /** 供 API 使用：两家各一行，未配置的也出现（configured:false）。 */
  list(): Promise<CodeHostConnectionWire[]>
  get(provider: CodeHostProvider): Promise<CodeHostConnectionWire>
  upsert(provider: CodeHostProvider, input: UpsertInput): Promise<CodeHostConnectionWire>
  remove(
    provider: CodeHostProvider,
    confirmation?: CodeHostConnectionMutationConfirmation,
  ): Promise<boolean>
  recordTest(provider: CodeHostProvider, result: CodeHostTestResult): Promise<void>
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

function repositoryUrlPrefixesOf(row: RepositoryTransportAdminConnection): string[] {
  if (row.provider !== 'gitlab') return []
  let raw: unknown
  try {
    raw = JSON.parse(row.repositoryUrlPrefixesJson)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const normalized: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') return []
    const result = normalizeGitLabRepositoryUrlPrefix(value)
    // 坏行 fail closed：不能因为一项损坏就把其余项当作执行准入依据。
    if (!result.ok) return []
    if (!normalized.includes(result.value)) normalized.push(result.value)
  }
  return normalized
}

function transportMappingsOf(
  row: RepositoryTransportAdminConnection,
): RepositoryTransportMappingV1[] {
  let raw: unknown
  try {
    raw = JSON.parse(row.transportMappingsJson)
  } catch {
    return []
  }
  const parsed = RepositoryTransportMappingV1Schema.array().max(32).safeParse(raw)
  if (!parsed.success) return []
  const normalized = normalizeRepositoryTransportMappings(parsed.data)
  if (!normalized.ok) return []
  return normalized.value.map((mapping) => ({
    sshHost: mapping.sshHost,
    sshPort: mapping.sshPort,
    ...(mapping.sshPathPrefix === '' ? {} : { sshPathPrefix: mapping.sshPathPrefix }),
    httpBaseUrl: mapping.httpBaseUrl,
  }))
}

function normalizeRepositoryUrlPrefixes(
  provider: CodeHostProvider,
  raw: readonly string[],
): string[] {
  if (provider !== 'gitlab') {
    if (raw.length === 0) return []
    throw new ValidationError(
      'code-host-repository-url-prefixes-unsupported',
      'repository URL prefixes are supported only for GitLab connections',
      { provider },
    )
  }
  const normalized: string[] = []
  for (const [index, value] of raw.entries()) {
    const result = normalizeGitLabRepositoryUrlPrefix(value)
    if (!result.ok) {
      throw new ValidationError(
        'code-host-repository-url-prefix-invalid',
        `repository URL prefix at index ${index} is invalid (${result.issue})`,
        { index, issue: result.issue },
      )
    }
    if (!normalized.includes(result.value)) normalized.push(result.value)
  }
  return normalized
}

function normalizeTransportMappings(
  raw: readonly RepositoryTransportMappingV1[],
): RepositoryTransportMappingV1[] {
  const parsed = RepositoryTransportMappingV1Schema.array().max(32).safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(
      'code-host-transport-mapping-invalid',
      'repository transport mapping does not satisfy the input contract',
    )
  }
  const normalized = normalizeRepositoryTransportMappings(parsed.data)
  if (!normalized.ok) {
    throw new ValidationError(
      'code-host-transport-mapping-invalid',
      `repository transport mapping is invalid (${normalized.issue})`,
      { issue: normalized.issue },
    )
  }
  return normalized.value.map((mapping) => ({
    sshHost: mapping.sshHost,
    sshPort: mapping.sshPort,
    ...(mapping.sshPathPrefix === '' ? {} : { sshPathPrefix: mapping.sshPathPrefix }),
    httpBaseUrl: mapping.httpBaseUrl,
  }))
}

function revocationDigest(input: {
  readonly operation: 'update' | 'delete'
  readonly provider: CodeHostProvider
  readonly connectionGeneration: string
  readonly currentEndpointBindingDigest: string
  readonly nextEndpointBindingDigest: string | null
  readonly personalCredentialCount: number
}): string {
  return sha256Hex(JSON.stringify(input))
}

function unconfigured(provider: CodeHostProvider): CodeHostConnectionWire {
  return {
    provider,
    configured: false,
    baseUrl: '',
    repositoryUrlPrefixes: [],
    transportMappings: [],
    connectionGeneration: null,
    endpointBindingDigest: null,
    personalPushCredentialCount: 0,
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
 * 派发一个 code-host 节点就走一次，必须无副作用，因此使用 `readConfig`
 * 而非 `loadConfig`。密钥缺失/损坏 ⇒ 返回 null，
 * 节点仍以 `code-host-not-configured` 收场，与自跳过语义一致。
 */
export function resolveCodeHostConnectionsFromKeyFile(
  repositoryTransport: RepositoryTransportConnectionAdministrationParticipant,
  keyPath: string,
): CodeHostConnectionsService | null {
  if (!existsSync(keyPath)) return null
  let secretBox: SecretBox
  try {
    secretBox = createSecretBoxFromKey(readFileSync(keyPath))
  } catch {
    return null
  }
  return createCodeHostConnectionsService({ secretBox, repositoryTransport })
}

export function createCodeHostConnectionsService(deps: {
  secretBox: SecretBox
  repositoryTransport: RepositoryTransportConnectionAdministrationParticipant
}): CodeHostConnectionsService {
  const { secretBox, repositoryTransport } = deps

  async function rowOf(
    provider: CodeHostProvider,
  ): Promise<RepositoryTransportAdminConnection | null> {
    return await repositoryTransport.findAdminConnection(provider)
  }

  async function toWire(row: RepositoryTransportAdminConnection): Promise<CodeHostConnectionWire> {
    let lastTest: CodeHostTestResult | null = null
    if (row.lastTestJson !== null) {
      try {
        lastTest = JSON.parse(row.lastTestJson) as CodeHostTestResult
      } catch {
        // 坏掉的展示字段不该让整个设置页 500。
        lastTest = null
      }
    }
    const impact = await repositoryTransport.inspectAdminConnection(row.provider)
    return {
      provider: row.provider,
      configured: true,
      baseUrl: row.baseUrl,
      repositoryUrlPrefixes: repositoryUrlPrefixesOf(row),
      transportMappings: transportMappingsOf(row),
      connectionGeneration: row.connectionGeneration,
      endpointBindingDigest: impact.currentEndpointBindingDigest,
      personalPushCredentialCount: impact.personalCredentialCount,
      rejectUnauthorized: normalizeCodeHostRejectUnauthorized(row.provider, row.rejectUnauthorized),
      tokenHint: row.tokenHint,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      lastTest,
    }
  }

  return {
    async resolve(provider) {
      const row = await rowOf(provider)
      if (row === null) return null
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
        repositoryUrlPrefixes: repositoryUrlPrefixesOf(row),
        transportMappings: transportMappingsOf(row),
        connectionGeneration: row.connectionGeneration,
        token,
        rejectUnauthorized: normalizeCodeHostRejectUnauthorized(provider, row.rejectUnauthorized),
      }
    },

    async list() {
      const rows = new Map(
        (await repositoryTransport.listAdminConnections()).map(
          (row) => [row.provider, row] as const,
        ),
      )
      return await Promise.all(
        PROVIDERS.map((provider) => {
          const row = rows.get(provider)
          return row === undefined ? unconfigured(provider) : toWire(row)
        }),
      )
    },

    async get(provider) {
      const row = await rowOf(provider)
      return row === null ? unconfigured(provider) : await toWire(row)
    },

    async upsert(provider, input) {
      const normalized = normalizeCodeHostBaseUrl(input.baseUrl, provider)
      if (!normalized.ok) {
        throw new ValidationError(
          'code-host-base-url-invalid',
          `base URL is not a valid ${provider} API root (${normalized.issue})`,
          { issue: normalized.issue, provider },
        )
      }
      const existing = await rowOf(provider)
      const repositoryUrlPrefixes =
        input.repositoryUrlPrefixes === undefined
          ? existing === null
            ? []
            : repositoryUrlPrefixesOf(existing)
          : normalizeRepositoryUrlPrefixes(provider, input.repositoryUrlPrefixes)
      const transportMappings =
        input.transportMappings === undefined
          ? existing === null
            ? []
            : transportMappingsOf(existing)
          : normalizeTransportMappings(input.transportMappings)
      let tokenEnc: string
      let tokenHint: string
      if (input.token !== undefined) {
        tokenEnc = secretBox.seal(input.token)
        tokenHint = hintOf(input.token)
      } else if (existing !== null) {
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
      const connectionGeneration = existing?.connectionGeneration ?? ulid()
      const values = {
        provider,
        baseUrl: normalized.value,
        repositoryUrlPrefixesJson: JSON.stringify(repositoryUrlPrefixes),
        transportMappingsJson: JSON.stringify(transportMappings),
        connectionGeneration,
        rejectUnauthorized,
        tokenEnc,
        tokenHint,
        // base URL、token 或 TLS 策略变了就作废上次的探活结果 —— 留着旧的绿勾
        // 会让人以为新配置已经验证过。
        lastTestJson: null,
        updatedAt: now,
        updatedBy: input.actorUserId ?? null,
      }
      const nextProjection = repositoryTransport.projectAdminConnection(values)
      const impact = await repositoryTransport.inspectAdminConnection(provider)
      if (
        input.expectedConnectionGeneration !== undefined &&
        impact.currentConnectionGeneration !== input.expectedConnectionGeneration
      ) {
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection changed; refresh before saving',
        )
      }
      const endpointBindingChanged =
        impact.currentEndpointBindingDigest !== null &&
        impact.currentEndpointBindingDigest !== nextProjection.endpointBindingDigest
      if (endpointBindingChanged && impact.personalCredentialCount > 0) {
        const required = revocationDigest({
          operation: 'update',
          provider,
          connectionGeneration,
          currentEndpointBindingDigest: impact.currentEndpointBindingDigest,
          nextEndpointBindingDigest: nextProjection.endpointBindingDigest,
          personalCredentialCount: impact.personalCredentialCount,
        })
        if (input.confirmCredentialRevocationDigest === undefined) {
          throw new ConflictError(
            'code-host-transport-rebind-confirmation-required',
            'changing this connection revokes personal code-host push credentials',
            {
              personalPushCredentialCount: impact.personalCredentialCount,
              expectedConnectionGeneration: connectionGeneration,
              confirmCredentialRevocationDigest: required,
            },
          )
        }
        if (input.confirmCredentialRevocationDigest !== required) {
          throw new ConflictError(
            'code-host-push-credential-stale',
            'the code-host connection impact changed; refresh before saving',
          )
        }
      } else if (input.confirmCredentialRevocationDigest !== undefined) {
        // A confirmation is a one-shot CAS proof, not a reusable consent bit.
        // If another writer already rebound the endpoint or removed the impacted
        // personal rows, the old digest must not turn into an unconditional
        // last-writer-wins update.
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection impact changed; refresh before saving',
        )
      }
      if (!(await repositoryTransport.synchronizeAdminConnection(values, impact))) {
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection impact changed; refresh before saving',
        )
      }
      const row = await rowOf(provider)
      return row === null ? unconfigured(provider) : await toWire(row)
    },

    async remove(provider, confirmation = {}) {
      const existing = await rowOf(provider)
      if (existing === null) return false
      const impact = await repositoryTransport.inspectAdminConnection(provider)
      if (
        confirmation.expectedConnectionGeneration !== undefined &&
        confirmation.expectedConnectionGeneration !== existing.connectionGeneration
      ) {
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection changed; refresh before deleting',
        )
      }
      if (impact.currentEndpointBindingDigest !== null && impact.personalCredentialCount > 0) {
        const required = revocationDigest({
          operation: 'delete',
          provider,
          connectionGeneration: existing.connectionGeneration,
          currentEndpointBindingDigest: impact.currentEndpointBindingDigest,
          nextEndpointBindingDigest: null,
          personalCredentialCount: impact.personalCredentialCount,
        })
        if (confirmation.confirmCredentialRevocationDigest === undefined) {
          throw new ConflictError(
            'code-host-transport-rebind-confirmation-required',
            'deleting this connection revokes personal code-host push credentials',
            {
              personalPushCredentialCount: impact.personalCredentialCount,
              expectedConnectionGeneration: existing.connectionGeneration,
              confirmCredentialRevocationDigest: required,
            },
          )
        }
        if (confirmation.confirmCredentialRevocationDigest !== required) {
          throw new ConflictError(
            'code-host-push-credential-stale',
            'the code-host connection impact changed; refresh before deleting',
          )
        }
      } else if (confirmation.confirmCredentialRevocationDigest !== undefined) {
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection impact changed; refresh before deleting',
        )
      }
      const removed = await repositoryTransport.removeAdminConnection(provider, impact)
      if (removed === 'stale') {
        throw new ConflictError(
          'code-host-push-credential-stale',
          'the code-host connection impact changed; refresh before deleting',
        )
      }
      return removed === 'removed'
    },

    async recordTest(provider, result) {
      await repositoryTransport.recordAdminConnectionTest(provider, result)
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
