// RFC-355 T8（实现门 r2 findings）—— 会话详情里三处**用户可见**的纯判据。
//
// 它们此前是 `sessionDetail.ts` 里的内联表达式。实现门第二路对它们做变异实验，
// 结果全部**零预言力**——1122 条 intent + contract 测试无一变红：
//
//   - `retrySource` 三个方向（永远 null / 去掉「生成还在飞」守卫 / 去掉「上一轮是 error」
//     守卫）全绿。这决定用户看不看得到「重试上一轮」入口，以及**生成还在跑时**会不会
//     被误给一个重试入口；
//   - `composerSource` 的 `conversation` 档全绿（另两档有既有集成测试兜着）；
//   - `latestAgentTurn` 取**最新**还是**最早**全绿——而这一个值同时喂 mountSuggestions /
//     journey.latestAgentTurnKind / retrySource / hasLaterApproval 四处。
//
// 判据不抽出来就只能靠「起一整个 HTTP harness 并恰好断言到那个字段」来覆盖，
// 而实测那种覆盖并不存在。抽成纯函数之后，每一档都能单独钉死。

/** 判据只要轮次的这几个字段；DTO 的其余部分与它无关。 */
export interface IntentTurnRef {
  readonly id: string
  readonly seq: number
  readonly role: string
  readonly kind: string
}

/**
 * 「最新的一条 agent 轮次」。
 *
 * **取最新不是取最早**：重试入口、挂载建议、journey 的轮次类型都按它算，取反会让界面
 * 显示上一个世纪的状态。轮次按 seq 递增追加，所以从尾部倒着找第一条。
 */
export function latestIntentAgentTurnOf<T extends IntentTurnRef>(
  turns: readonly T[],
): T | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn !== undefined && turn.role === 'agent') return turn
  }
  return undefined
}

/** 最新 agent 轮次之后是否已经有过一次挂载审批。 */
export function hasApprovalAfterLatestAgentTurn(
  turns: readonly IntentTurnRef[],
  latestAgentTurn: IntentTurnRef | undefined,
): boolean {
  if (latestAgentTurn === undefined) return false
  return turns.some((turn) => turn.kind === 'mount-approval' && turn.seq > latestAgentTurn.seq)
}

export type IntentComposerSource =
  | { readonly kind: 'current-draft'; readonly draftId: string; readonly revision: number }
  | { readonly kind: 'latest-checkpoint'; readonly commitSeq: number }
  | { readonly kind: 'conversation' }

/**
 * 编辑器该以什么为底：当前草稿 → 最近一次提交 → 纯对话。
 *
 * `conversation` 是**没提交过也没草稿**的新会话；`commitSeq > 0` 时给 `latest-checkpoint`，
 * 前端据此显示「基于上次提交继续」。三档判反了用户会在错误的底上编辑。
 */
export function intentComposerSourceOf(input: {
  readonly currentDraft: { readonly id: string; readonly revision: number } | null
  readonly commitSeq: number
}): IntentComposerSource {
  if (input.currentDraft !== null) {
    return {
      kind: 'current-draft',
      draftId: input.currentDraft.id,
      revision: input.currentDraft.revision,
    }
  }
  if (input.commitSeq > 0) return { kind: 'latest-checkpoint', commitSeq: input.commitSeq }
  return { kind: 'conversation' }
}

export type IntentRetrySource = { readonly turnId: string; readonly turnSeq: number } | null

/**
 * 「重试上一轮」入口。
 *
 * 两个守卫都是用户可见的：**上一轮必须是 error**（成功的轮次没什么可重试），
 * **且当前没有轮次在飞**（生成还在跑时给重试入口，用户点下去会撞上 in-flight 冲突）。
 */
export function intentRetrySourceOf(input: {
  readonly latestAgentTurn: IntentTurnRef | undefined
  readonly inFlightTurnId: string | null
}): IntentRetrySource {
  const turn = input.latestAgentTurn
  if (turn === undefined || turn.kind !== 'error') return null
  if (input.inFlightTurnId !== null) return null
  return { turnId: turn.id, turnSeq: turn.seq }
}
