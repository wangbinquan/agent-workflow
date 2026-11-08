// integration 装配：DevelopmentCodeHostEffects 的 mr.ensure/observe 面
// （RFC-310 PR-5 T60）。
//
// 本 context 内只做实例化透传：repository → {provider, project, call} 的绑定
// 闭包由装配点（routes/cli）用 RFC-269 connections service + repo URL 解析
// 构造注入；DA 侧以结构同形端口消费（两模块互不 import 对方内部，同
// requirementSource 先例）。绑定缺失是 typed code，不是静默跳过。
//
// RFC-471（RFC-294 W9-D）：开发交付的代码托管桥归这里——绑定本身
// （`composeDevelopmentCodeHostBinding`：按仓库远端 URL 选代码托管连接）、MR effects
// （唯一一份实现，绑定可异步）、MR 原始事实与仓库认领键。DA 只交出仓库远端，按结构
// 消费这些组装结果；`services/developmentDeliveryDeps.ts` 删除。

import {
  ensureMergeRequest,
  observeMergeRequest,
  type EnsuredMergeRequest,
  type MrEnsureConnectionDeps,
  type MrEnsureInput,
  type MrObservation,
} from '../application/mrEnsure'
import {
  collectMergeRequestFacts,
  replyMergeRequestThread,
  type MrFactsResult,
} from '../application/mrFacts'
import { matchRepoProvider } from '../domain/repositoryProviderMatch'

export interface RepoCodeHostBindingResolver {
  (repositoryId: string): MrEnsureConnectionDeps | null | Promise<MrEnsureConnectionDeps | null>
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
      const bound = await deps.binding(repositoryId)
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
      const bound = await deps.binding(repositoryId)
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
      const bound = await deps.binding(repositoryId)
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

/** The only thing the binding needs from code-host connections. */
export interface DevelopmentCodeHostConnections {
  resolve(
    provider: 'gitlab' | 'github',
  ): Promise<MrEnsureConnectionDeps['call']['connection'] | null>
}

/**
 * RFC-471: repository → code-host binding. Moved from the development delivery provider's
 * `resolveBinding`; the remote URL now comes from the repository port (DA's `RepoRemotePort`, same
 * shape), the candidate matching and the binding assembly are unchanged.
 */
export function composeDevelopmentCodeHostBinding(input: {
  readonly repositories: {
    resolve(
      repositoryId: string,
    ): Promise<{ readonly remoteUrl: string } | null> | { readonly remoteUrl: string } | null
  }
  readonly connections: DevelopmentCodeHostConnections
  /** RFC-450: the code-host requests every resolved binding sends through (injected by assembly). */
  readonly requests: MrEnsureConnectionDeps['requests']
}): (repositoryId: string) => Promise<MrEnsureConnectionDeps | null> {
  return async (repositoryId) => {
    const repository = await input.repositories.resolve(repositoryId)
    if (repository === null) return null
    const candidates = (
      await Promise.all(
        (['gitlab', 'github'] as const).map((provider) => input.connections.resolve(provider)),
      )
    ).filter((connection) => connection !== null)
    const matched = matchRepoProvider(repository.remoteUrl, candidates)
    if (matched === null) return null
    const connection = candidates.find((candidate) => candidate.provider === matched.provider)
    if (connection === undefined) return null
    return {
      provider: matched.provider,
      project: matched.project,
      call: { connection, ctx: { ports: {} } },
      requests: input.requests,
    }
  }
}

/**
 * RFC-471: the raw MR facts the development side projects. A missing binding is the same typed code
 * the effects return; otherwise the collector's result (and its snapshot object) is passed through.
 */
export function composeDevelopmentMrFactsSource(deps: {
  readonly binding: RepoCodeHostBindingResolver
}): {
  collect(
    repositoryId: string,
    mrRef: string,
    options: { readonly selfMarker: string },
  ): Promise<
    | MrFactsResult
    | { readonly ok: false; readonly code: 'code-host-connection-missing'; readonly detail: string }
  >
} {
  return {
    async collect(repositoryId, mrRef, options) {
      const bound = await deps.binding(repositoryId)
      if (bound === null) {
        return {
          ok: false,
          code: 'code-host-connection-missing',
          detail: `no code-host binding for repository ${repositoryId}`,
        }
      }
      return await collectMergeRequestFacts(bound, mrRef, { selfMarker: options.selfMarker })
    },
  }
}

/**
 * RFC-471: the development delivery's code-host side in one assembly — the binding and the three
 * capabilities built on it (the assembly root injects them into development-automation's ports).
 */
export function composeDevelopmentCodeHostDelivery(
  input: Parameters<typeof composeDevelopmentCodeHostBinding>[0],
) {
  const binding = composeDevelopmentCodeHostBinding(input)
  return Object.freeze({
    binding,
    mrEffects: composeDevelopmentMrEffects({ binding }),
    mrFacts: composeDevelopmentMrFactsSource({ binding }),
    claimKeys: composeRepositoryCodeHostClaimKeys({ binding }),
  })
}

/** RFC-471: the code-host claim key of a repository (moved from `resolveRepoClaimKey`). */
export function composeRepositoryCodeHostClaimKeys(deps: {
  readonly binding: RepoCodeHostBindingResolver
}): {
  resolve(
    repositoryId: string,
  ): Promise<{ readonly codeHostEndpointRef: string; readonly stableProjectRef: string } | null>
} {
  return {
    async resolve(repositoryId) {
      const binding = await deps.binding(repositoryId)
      if (binding === null) return null
      return {
        codeHostEndpointRef: binding.provider,
        stableProjectRef: decodeURIComponent(binding.project),
      }
    },
  }
}
