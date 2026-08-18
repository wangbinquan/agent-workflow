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

/**
 * repo URL → 已配置 connection 的 provider/project 匹配（装配点绑定用）。
 * 顺序：①connection 的 repositoryUrlPrefixes 前缀命中（最长优先）；②baseUrl
 * 同 host；③SaaS 域关键词兜底。gitlab 的 project 段 URL-encode（API path
 * 定位段），github 保留 owner/repo。ssh 形态（git@host:path）折算 host/path。
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
  const finish = (
    provider: 'gitlab' | 'github',
    path: string,
  ): { provider: 'gitlab' | 'github'; project: string } => ({
    provider,
    project: provider === 'gitlab' ? encodeURIComponent(path) : path,
  })
  // ① repositoryUrlPrefixes（最长命中优先，跨 provider 比较）。
  let best: { provider: 'gitlab' | 'github'; prefix: string } | null = null
  for (const c of candidates) {
    for (const prefix of c.repositoryUrlPrefixes) {
      if (prefix.length > 0 && repoUrl.startsWith(prefix)) {
        if (best === null || prefix.length > best.prefix.length) {
          best = { provider: c.provider, prefix }
        }
      }
    }
  }
  if (best !== null && parsed !== null) return finish(best.provider, parsed.path)
  if (parsed === null) return null
  // ② baseUrl host 相同。
  for (const c of candidates) {
    try {
      if (new URL(c.baseUrl).host === parsed.host) return finish(c.provider, parsed.path)
    } catch {
      // 非法 baseUrl 行不参与匹配
    }
  }
  // ③ SaaS 域兜底。
  if (parsed.host === 'github.com') return finish('github', parsed.path)
  if (parsed.host === 'gitlab.com') return finish('gitlab', parsed.path)
  return null
}

function parseRepoHostPath(
  repoUrl: string,
): { readonly host: string; readonly path: string } | null {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(repoUrl)
  if (ssh !== null) {
    return { host: ssh[1]!, path: stripGitSuffix(ssh[2]!) }
  }
  try {
    const u = new URL(repoUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { host: u.host, path: stripGitSuffix(u.pathname.replace(/^\/+/, '')) }
  } catch {
    return null
  }
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
