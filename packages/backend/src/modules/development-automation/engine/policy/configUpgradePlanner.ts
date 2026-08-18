// RFC-310 T19 —— configuration upgrade 的 pure diff planner（design.md §12.1）。
//
// 在途 Mission 的 employee/policy 闭包升级必须显式、先预览失效面、再原子
// repin（AC-4/AC-30）。本文件是纯函数半边：比较两份 pinned closure，产出
// 「哪些 pin 变了 + 哪些在途产物会失效」的 typed 清单。apply 半边（settle
// action、bump epoch、写 receipts）在 PR-2 T31a 接 Mission 聚合。

export interface PinnedClosure {
  readonly employee: { readonly id: string; readonly revision: number } | null
  readonly policy: { readonly id: string; readonly revision: number } | null
  /** capabilityId → pinned template revision（route 解析后的实际引用面）。 */
  readonly templates: Readonly<Record<string, { readonly id: string; readonly revision: number }>>
  readonly verificationProfiles: Readonly<Record<string, number>>
  readonly adapters: Readonly<Record<string, number>>
}

export type ClosurePinChange =
  | { readonly kind: 'employee'; readonly from: string | null; readonly to: string | null }
  | { readonly kind: 'policy'; readonly from: string | null; readonly to: string | null }
  | {
      readonly kind: 'template'
      readonly capabilityId: string
      readonly from: string | null
      readonly to: string | null
    }
  | {
      readonly kind: 'verification-profile'
      readonly profileId: string
      readonly from: number | null
      readonly to: number | null
    }
  | {
      readonly kind: 'adapter'
      readonly adapterId: string
      readonly from: number | null
      readonly to: number | null
    }

export interface InFlightWork {
  readonly unpublishedActionRunRefs: readonly string[]
  readonly unpublishedCandidateRefs: readonly string[]
  readonly pendingDecisionRefs: readonly string[]
  readonly analysisReceiptRefs: readonly string[]
}

export interface ConfigUpgradePlan {
  readonly changes: readonly ClosurePinChange[]
  /** 会被本次升级作废的在途产物（已发布 commit/MR 历史永不回滚）。 */
  readonly invalidates: InFlightWork
  readonly noop: boolean
}

function refLabel(ref: { id: string; revision: number } | null): string | null {
  return ref === null ? null : `${ref.id}@${ref.revision}`
}

/** 纯函数：同输入同输出；不查 DB、不看时钟。 */
export function planConfigurationUpgrade(input: {
  readonly current: PinnedClosure
  readonly next: PinnedClosure
  readonly inFlight: InFlightWork
}): ConfigUpgradePlan {
  const changes: ClosurePinChange[] = []
  const { current, next } = input

  if (refLabel(current.employee) !== refLabel(next.employee)) {
    changes.push({
      kind: 'employee',
      from: refLabel(current.employee),
      to: refLabel(next.employee),
    })
  }
  if (refLabel(current.policy) !== refLabel(next.policy)) {
    changes.push({ kind: 'policy', from: refLabel(current.policy), to: refLabel(next.policy) })
  }

  const capabilityIds = [
    ...new Set([...Object.keys(current.templates), ...Object.keys(next.templates)]),
  ].sort()
  for (const capabilityId of capabilityIds) {
    const from = refLabel(current.templates[capabilityId] ?? null)
    const to = refLabel(next.templates[capabilityId] ?? null)
    if (from !== to) changes.push({ kind: 'template', capabilityId, from, to })
  }

  const profileIds = [
    ...new Set([
      ...Object.keys(current.verificationProfiles),
      ...Object.keys(next.verificationProfiles),
    ]),
  ].sort()
  for (const profileId of profileIds) {
    const from = current.verificationProfiles[profileId] ?? null
    const to = next.verificationProfiles[profileId] ?? null
    if (from !== to) changes.push({ kind: 'verification-profile', profileId, from, to })
  }

  const adapterIds = [
    ...new Set([...Object.keys(current.adapters), ...Object.keys(next.adapters)]),
  ].sort()
  for (const adapterId of adapterIds) {
    const from = current.adapters[adapterId] ?? null
    const to = next.adapters[adapterId] ?? null
    if (from !== to) changes.push({ kind: 'adapter', adapterId, from, to })
  }

  const noop = changes.length === 0
  return {
    changes,
    // 任一 pin 变化都使全部未发布在途产物失效（design §12.1：不能单独偷换一个
    // transitive ref；apply 层整体 repin + bump epoch）。noop 则零失效。
    invalidates: noop
      ? {
          unpublishedActionRunRefs: [],
          unpublishedCandidateRefs: [],
          pendingDecisionRefs: [],
          analysisReceiptRefs: [],
        }
      : input.inFlight,
    noop,
  }
}
