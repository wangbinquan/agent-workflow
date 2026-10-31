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
