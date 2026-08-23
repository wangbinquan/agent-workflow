// integration 装配：DevelopmentCodeHostEffects 的 mr.ensure/observe 面
// （RFC-310 PR-5 T60）。
//
// 本 context 内只做实例化透传：repository → {provider, project, call} 的绑定
// 闭包由装配点（routes/cli）用 RFC-269 connections service + repo URL 解析
// 构造注入；DA 侧以结构同形端口消费（两模块互不 import 对方内部，同
// requirementSource 先例）。绑定缺失是 typed code，不是静默跳过。

import {
  ensureMergeRequest,
  observeMergeRequest,
  type EnsuredMergeRequest,
  type MrEnsureConnectionDeps,
  type MrEnsureInput,
  type MrObservation,
} from '../application/mrEnsure'
import { replyMergeRequestThread } from '../application/mrFacts'
import { parseGitUrl } from '@agent-workflow/shared'

/**
 * repo URL → 已配置 connection 的 provider/project 匹配（装配点绑定用）。
 * 顺序：①connection 的 repositoryUrlPrefixes 按 authority + path 命中（最长
 * 优先；SSH 跨传输时只比 hostname，因而 HTTP 管理前缀也能绑定 SSH clone
 * URL）；②baseUrl 同 authority；③SaaS 域关键词兜底。gitlab 的 project 段
 * URL-encode（API path 定位段），github 保留 owner/repo。SSH URI 的自定义端口
 * 不属于 HTTP authority，也不属于 project path。
 */
export function matchRepoProvider(
  repoUrl: string,
  candidates: readonly {
    readonly provider: 'gitlab' | 'github'
    readonly baseUrl: string
    readonly repositoryUrlPrefixes: readonly string[]
  }[],
): { readonly provider: 'gitlab' | 'github'; readonly project: string } | null {
  const parsed = parseRepoHostPath(repoUrl)
  if (parsed === null) return null
  const finish = (
    provider: 'gitlab' | 'github',
    path: string,
  ): { provider: 'gitlab' | 'github'; project: string } => ({
    provider,
    project: provider === 'gitlab' ? encodeURIComponent(path) : path,
  })
  // ① repositoryUrlPrefixes（最长 path 命中优先，跨 provider 比较）。不能用
  // repoUrl.startsWith(prefix)：管理员保存的是无凭据 HTTP(S) 前缀，而实际 clone
  // URL 常是 git@host:path 或 ssh://git@host:port/path。HTTP clone 仍须严格匹配
  // scheme + authority，避免同主机另一端口接收到本 Connection 的凭据。
  let best: { provider: 'gitlab' | 'github'; pathLength: number } | null = null
  for (const c of candidates) {
    for (const prefix of c.repositoryUrlPrefixes) {
      const parsedPrefix = parseHttpHostPath(prefix)
      if (parsedPrefix === null || !repositoryMatchesHttpLocation(parsed, parsedPrefix, true)) {
        continue
      }
      if (
        parsedPrefix.path.length > 0 &&
        parsed.path !== parsedPrefix.path &&
        !parsed.path.startsWith(`${parsedPrefix.path}/`)
      ) {
        continue
      }
      if (best === null || parsedPrefix.path.length > best.pathLength) {
        best = { provider: c.provider, pathLength: parsedPrefix.path.length }
      }
    }
  }
  if (best !== null) return finish(best.provider, parsed.path)
  // ② baseUrl host 相同。
  for (const c of candidates) {
    const base = parseHttpHostPath(c.baseUrl)
    if (base === null) continue
    const expectedHost =
      c.provider === 'github' && base.host === 'api.github.com' ? 'github.com' : base.host
    const expectedHosts = [
      expectedHost,
      ...(c.provider === 'github' ? [`www.${expectedHost}`] : []),
    ]
    if (
      expectedHosts.some((host) => repositoryMatchesHttpLocation(parsed, { ...base, host }, false))
    ) {
      return finish(c.provider, parsed.path)
    }
  }
  // ③ SaaS 域兜底。
  if (parsed.host === 'github.com') return finish('github', parsed.path)
  if (parsed.host === 'gitlab.com') return finish('gitlab', parsed.path)
  return null
}

function parseRepoHostPath(repoUrl: string): {
  readonly transport: 'http' | 'ssh'
  readonly protocol: 'http:' | 'https:' | null
  readonly host: string
  readonly port: number | null
  readonly path: string
} | null {
  const parsed = parseGitUrl(repoUrl)
  if (parsed === null || parsed.kind === 'file') return null
  const path = stripGitSuffix(parsed.path)
  if (path.length === 0) return null
  if (parsed.kind === 'http' || parsed.kind === 'https') {
    return {
      transport: 'http',
      protocol: `${parsed.kind}:`,
      host: parsed.host.toLowerCase(),
      port: normalizedHttpPort(parsed.kind, parsed.port),
      path,
    }
  }
  return {
    transport: 'ssh',
    protocol: null,
    host: parsed.host.toLowerCase(),
    port: parsed.kind === 'ssh-uri' ? parsed.port : null,
    path,
  }
}

interface ParsedHttpLocation {
  readonly protocol: 'http:' | 'https:'
  readonly host: string
  readonly port: number | null
  readonly path: string
}

function normalizedHttpPort(kind: 'http' | 'https', port: number | null): number | null {
  if (port === null) return null
  if ((kind === 'http' && port === 80) || (kind === 'https' && port === 443)) return null
  return port
}

function parseHttpHostPath(url: string): ParsedHttpLocation | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return {
      protocol: u.protocol,
      host: u.hostname.toLowerCase(),
      port: u.port === '' ? null : Number(u.port),
      path: u.pathname.replace(/^\/+|\/+$/g, ''),
    }
  } catch {
    return null
  }
}

/**
 * HTTP clone URLs stay on the exact configured HTTP authority. SSH clone URLs
 * intentionally cross transports by hostname because their port is the SSH
 * service port, not the code-host API port.
 */
function repositoryMatchesHttpLocation(
  repository: NonNullable<ReturnType<typeof parseRepoHostPath>>,
  location: ParsedHttpLocation,
  requireProtocol: boolean,
): boolean {
  if (repository.host !== location.host) return false
  if (repository.transport === 'ssh') return true
  return (
    repository.port === location.port &&
    (!requireProtocol || repository.protocol === location.protocol)
  )
}

function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/, '').replace(/\/+$/, '')
}

export interface RepoCodeHostBindingResolver {
  (repositoryId: string): MrEnsureConnectionDeps | null
}

export interface DevelopmentMrEffects {
  reply(
    repositoryId: string,
    input: {
      readonly mrRef: string
      readonly threadRef: string
      readonly body: string
      readonly selfMarker: string
    },
  ): Promise<
    | { readonly ok: true; readonly noteRef: string }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  ensure(
    repositoryId: string,
    input: MrEnsureInput,
  ): Promise<
    | { readonly ok: true; readonly mr: EnsuredMergeRequest }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
  observe(
    repositoryId: string,
    mrRef: string,
  ): Promise<
    | { readonly ok: true; readonly observation: MrObservation }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >
}

export function composeDevelopmentMrEffects(deps: {
  readonly binding: RepoCodeHostBindingResolver
}): DevelopmentMrEffects {
  return {
    async ensure(repositoryId, input) {
      const bound = deps.binding(repositoryId)
      if (bound === null) {
        return {
          ok: false,
          code: 'code-host-connection-missing',
          detail: `no code-host binding for repository ${repositoryId}`,
        }
      }
      const out = await ensureMergeRequest(bound, input)
      if (!out.ok) return { ok: false, code: out.code, detail: out.detail }
      return { ok: true, mr: out.mr }
    },
    async reply(repositoryId, input) {
      const bound = deps.binding(repositoryId)
      if (bound === null) {
        return {
          ok: false,
          code: 'code-host-connection-missing',
          detail: `no code-host binding for repository ${repositoryId}`,
        }
      }
      const out = await replyMergeRequestThread(bound, {
        mrRef: input.mrRef,
        threadRef: input.threadRef,
        body: input.body,
        selfMarker: input.selfMarker,
      })
      if (!out.ok) return { ok: false, code: out.code, detail: out.detail }
      return { ok: true, noteRef: out.noteRef }
    },
    async observe(repositoryId, mrRef) {
      const bound = deps.binding(repositoryId)
      if (bound === null) {
        return {
          ok: false,
          code: 'code-host-connection-missing',
          detail: `no code-host binding for repository ${repositoryId}`,
        }
      }
      const out = await observeMergeRequest(bound, mrRef)
      if (!out.ok) return { ok: false, code: out.code, detail: out.detail }
      return { ok: true, observation: out.mr }
    },
  }
}
