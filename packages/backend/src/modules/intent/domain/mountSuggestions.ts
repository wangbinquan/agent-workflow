// RFC-355 T8（RFC-294 W4-E4a）—— 「这一轮该不该给用户看挂载建议、能挂哪些候选」的纯判据。
//
// 此前整段住在 `routes/intentSessions.ts` 的详情 handler 里（约 45 行内联逻辑）。它决定的是
// **用户可见行为**：建议只在最新一条 agent 轮次还没被批过、且上下文没换代时才出现；候选只列
// 该 actor 看得见、且还没挂上的资源；同类型同名的重复请求只出一条。这些都是判据，不是投递
// 细节——留在路由里等于把它锁死在一个出口上，且没有任何可直接断言的面。
//
// 纯函数：入参是已经解析好的轮次 / 已挂载项 / 可见资源，出参是 DTO 片段。不碰 IO。

import type { IntentMountRequest, IntentSessionDetail } from '@agent-workflow/shared'

export interface IntentMountSuggestionTurn {
  readonly id: string
  readonly seq: number
  readonly kind: string
  readonly contextRevision: number
  /** 该轮 agent 给出的挂载请求；调用方负责先按 schema 解析，解析失败传 `null`。 */
  readonly mountRequests: readonly IntentMountRequest[] | null
}

export interface IntentMountedEntry {
  readonly resourceType: string
  readonly resourceId: string
}

export interface IntentVisibleResource {
  readonly resourceType: string
  readonly resourceId: string
  readonly name: string
  readonly description: string | null
}

/**
 * 只有「最新 agent 轮次提出、尚未被更晚的 mount-approval 覆盖、且仍在当前上下文代次」的请求
 * 才会变成建议；一条建议都凑不出时返回 `null`（前端据此完全不渲染该区块）。
 */
export function intentMountSuggestionsOf(input: {
  readonly latestAgentTurn: IntentMountSuggestionTurn | undefined
  /** 最新 agent 轮次之后是否已经有过一次 mount-approval。 */
  readonly hasLaterApproval: boolean
  readonly sessionContextRevision: number
  readonly mounted: readonly IntentMountedEntry[]
  readonly visibleResources: readonly IntentVisibleResource[]
}): IntentSessionDetail['mountSuggestions'] {
  const turn = input.latestAgentTurn
  if (turn === undefined) return null
  if (turn.kind !== 'questions' && turn.kind !== 'changeset') return null
  if (turn.contextRevision !== input.sessionContextRevision) return null
  if (input.hasLaterApproval) return null
  if (turn.mountRequests === null) return null

  const mountedKeys = new Set(
    input.mounted.map((entry) => `${entry.resourceType}:${entry.resourceId}`),
  )
  const seen = new Set<string>()
  const items = turn.mountRequests.flatMap((request) => {
    // NUL 分隔：类型与名字都可能含冒号，用它才不会把 (a:b, c) 和 (a, b:c) 撞成同一条。
    const key = `${request.resourceType}\u0000${request.name}`
    if (seen.has(key)) return []
    seen.add(key)
    return [
      {
        resourceType: request.resourceType,
        name: request.name,
        reason: request.reason ?? null,
        candidates: input.visibleResources
          .filter(
            (resource) =>
              resource.resourceType === request.resourceType &&
              resource.name === request.name &&
              !mountedKeys.has(`${resource.resourceType}:${resource.resourceId}`),
          )
          .map((resource) => ({
            resourceId: resource.resourceId,
            name: resource.name,
            description: resource.description,
          })),
      },
    ]
  })
  if (items.length === 0) return null
  return {
    sourceTurnId: turn.id,
    sourceTurnSeq: turn.seq,
    contextRevision: input.sessionContextRevision,
    items,
  }
}
