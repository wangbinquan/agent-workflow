// RFC-310 PR-5 T60 —— `mr.ensure` 幂等 effect 与 MR 状态单次读取（design §9.3）。
//
// 复用 RFC-269 的 executeCodeHostCall（D12 按位置编码 / D18 幂等分档重试 /
// D19 重定向剥 Authorization 三纪律免费拿到；连接语义 = ResolvedCodeHost-
// Connection，secret 只在 daemon 侧短暂明文）。幂等编排：先 `mr.list`（open）
// 按 source branch 找既有 MR——找到则校验 target 匹配后**绑定**（不重复创建；
// target 不一致 = typed mr-binding-mismatch，绝不改别人 MR），没有才
// `mr.create`，body 携带机器 marker（`[aw-mission:<id>]`），不含 secret/
// host path/raw policy/日志。完整 MR care（评论/标签/轮询）归 PR-7；这里只有
// ensure + 单次 observe（mergeRequestFacts collector 的素材面）。

import { executeCodeHostCall, type CodeHostCallDeps } from '@/services/codeHost/call'
import type { CodeHostProvider } from '@agent-workflow/shared'

export interface MrEnsureConnectionDeps {
  readonly provider: CodeHostProvider
  /** URL-encoded project 定位段（gitlab: `grp%2Frepo`；github: `owner/repo`）。 */
  readonly project: string
  readonly call: Omit<CodeHostCallDeps, 'projectFallback'>
}

export interface MrEnsureInput {
  readonly missionId: string
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly title: string
  /** 追加在 marker 之前的描述正文（平台生成；不含 secret/host path）。 */
  readonly description?: string
}

export interface EnsuredMergeRequest {
  readonly mrRef: string
  readonly webUrl: string | null
  readonly state: 'opened' | 'merged' | 'closed'
  readonly sourceSha: string | null
  readonly created: boolean
  readonly providerCorrelationRef: string
}

export type MrEnsureResult =
  | { readonly ok: true; readonly mr: EnsuredMergeRequest }
  | {
      readonly ok: false
      readonly code: 'mr-lookup-failed' | 'mr-create-failed' | 'mr-binding-mismatch'
      readonly detail: string
    }

interface GitlabMr {
  readonly iid: number
  readonly source_branch: string
  readonly target_branch: string
  readonly state: string
  readonly web_url?: string
  readonly sha?: string
}

interface GithubPr {
  readonly number: number
  readonly state: string
  readonly merged?: boolean
  readonly merged_at?: string | null
  readonly html_url?: string
  readonly head?: { readonly ref?: string; readonly sha?: string }
  readonly base?: { readonly ref?: string }
}

export function normalizedState(input: {
  readonly provider: CodeHostProvider
  readonly rawState: string
  readonly merged: boolean
}): 'opened' | 'merged' | 'closed' {
  if (input.provider === 'gitlab') {
    if (input.rawState === 'merged') return 'merged'
    return input.rawState === 'opened' ? 'opened' : 'closed'
  }
  if (input.rawState === 'open') return 'opened'
  return input.merged ? 'merged' : 'closed'
}

function correlationRef(deps: MrEnsureConnectionDeps, mrRef: string): string {
  return `${deps.provider}:${decodeURIComponent(deps.project)}!${mrRef}`
}

export function callDeps(deps: MrEnsureConnectionDeps): CodeHostCallDeps {
  return { ...deps.call, projectFallback: { ok: true, value: deps.project } }
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

async function findBySourceBranch(
  deps: MrEnsureConnectionDeps,
  sourceBranch: string,
): Promise<
  | {
      readonly ok: true
      readonly found: (EnsuredMergeRequest & { readonly targetBranch: string | null }) | null
    }
  | { readonly ok: false; readonly detail: string }
> {
  const listed = await executeCodeHostCall(
    {
      provider: deps.provider,
      action: 'mr.list',
      params: { project: deps.project, mr_state: 'open', per_page: '100' },
    },
    callDeps(deps),
  )
  if (!listed.ok) return { ok: false, detail: `${listed.code}: ${listed.summary}` }
  if (deps.provider === 'gitlab') {
    const rows = parseJson<GitlabMr[]>(listed.body) ?? []
    const hit = rows.find((row) => row.source_branch === sourceBranch)
    if (hit === undefined) return { ok: true, found: null }
    return {
      ok: true,
      found: {
        mrRef: String(hit.iid),
        webUrl: hit.web_url ?? null,
        state: normalizedState({ provider: 'gitlab', rawState: hit.state, merged: false }),
        sourceSha: hit.sha ?? null,
        created: false,
        providerCorrelationRef: correlationRef(deps, String(hit.iid)),
        targetBranch: hit.target_branch ?? null,
      },
    }
  }
  const rows = parseJson<GithubPr[]>(listed.body) ?? []
  const hit = rows.find((row) => row.head?.ref === sourceBranch)
  if (hit === undefined) return { ok: true, found: null }
  return {
    ok: true,
    found: {
      mrRef: String(hit.number),
      webUrl: hit.html_url ?? null,
      state: normalizedState({
        provider: 'github',
        rawState: hit.state,
        merged: hit.merged === true || (hit.merged_at ?? null) !== null,
      }),
      sourceSha: hit.head?.sha ?? null,
      created: false,
      providerCorrelationRef: correlationRef(deps, String(hit.number)),
      targetBranch: hit.base?.ref ?? null,
    },
  }
}

export async function ensureMergeRequest(
  deps: MrEnsureConnectionDeps,
  input: MrEnsureInput,
): Promise<MrEnsureResult> {
  const existing = await findBySourceBranch(deps, input.sourceBranch)
  if (!existing.ok) return { ok: false, code: 'mr-lookup-failed', detail: existing.detail }
  if (existing.found !== null) {
    const { targetBranch, ...mr } = existing.found
    if (targetBranch !== null && targetBranch !== input.targetBranch) {
      return {
        ok: false,
        code: 'mr-binding-mismatch',
        detail: `open MR for '${input.sourceBranch}' targets '${targetBranch}', expected '${input.targetBranch}'`,
      }
    }
    return { ok: true, mr }
  }

  const description = `${input.description ?? ''}\n\n[aw-mission:${input.missionId}]`.trim()
  const created = await executeCodeHostCall(
    {
      provider: deps.provider,
      action: 'mr.create',
      params: {
        project: deps.project,
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description,
      },
    },
    callDeps(deps),
  )
  if (!created.ok)
    return { ok: false, code: 'mr-create-failed', detail: `${created.code}: ${created.summary}` }
  if (deps.provider === 'gitlab') {
    const mr = parseJson<GitlabMr>(created.body)
    if (mr === null)
      return { ok: false, code: 'mr-create-failed', detail: 'unparsable create response' }
    return {
      ok: true,
      mr: {
        mrRef: String(mr.iid),
        webUrl: mr.web_url ?? null,
        state: 'opened',
        sourceSha: mr.sha ?? null,
        created: true,
        providerCorrelationRef: correlationRef(deps, String(mr.iid)),
      },
    }
  }
  const pr = parseJson<GithubPr>(created.body)
  if (pr === null)
    return { ok: false, code: 'mr-create-failed', detail: 'unparsable create response' }
  return {
    ok: true,
    mr: {
      mrRef: String(pr.number),
      webUrl: pr.html_url ?? null,
      state: 'opened',
      sourceSha: pr.head?.sha ?? null,
      created: true,
      providerCorrelationRef: correlationRef(deps, String(pr.number)),
    },
  }
}

export interface MrObservation {
  readonly mrRef: string
  readonly state: 'opened' | 'merged' | 'closed'
  readonly sourceSha: string | null
  readonly targetBranch: string | null
  readonly webUrl: string | null
}

export type MrObserveResult =
  | { readonly ok: true; readonly mr: MrObservation }
  | { readonly ok: false; readonly code: 'mr-lookup-failed'; readonly detail: string }

/** terminal observe / facts collector 素材：单次 `mr.get`。 */
export async function observeMergeRequest(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
): Promise<MrObserveResult> {
  const got = await executeCodeHostCall(
    {
      provider: deps.provider,
      action: 'mr.get',
      params: { project: deps.project, mr: mrRef },
    },
    callDeps(deps),
  )
  if (!got.ok) return { ok: false, code: 'mr-lookup-failed', detail: `${got.code}: ${got.summary}` }
  if (deps.provider === 'gitlab') {
    const mr = parseJson<GitlabMr>(got.body)
    if (mr === null)
      return { ok: false, code: 'mr-lookup-failed', detail: 'unparsable mr.get response' }
    return {
      ok: true,
      mr: {
        mrRef,
        state: normalizedState({ provider: 'gitlab', rawState: mr.state, merged: false }),
        sourceSha: mr.sha ?? null,
        targetBranch: mr.target_branch ?? null,
        webUrl: mr.web_url ?? null,
      },
    }
  }
  const pr = parseJson<GithubPr>(got.body)
  if (pr === null)
    return { ok: false, code: 'mr-lookup-failed', detail: 'unparsable mr.get response' }
  return {
    ok: true,
    mr: {
      mrRef,
      state: normalizedState({
        provider: 'github',
        rawState: pr.state,
        merged: pr.merged === true || (pr.merged_at ?? null) !== null,
      }),
      sourceSha: pr.head?.sha ?? null,
      targetBranch: pr.base?.ref ?? null,
      webUrl: pr.html_url ?? null,
    },
  }
}
