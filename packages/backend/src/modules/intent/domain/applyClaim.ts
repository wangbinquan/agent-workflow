// RFC-355 T4（RFC-294 W4-E4a）—— apply 的 claim 段判据，**两个 provider 共用这一份**。
//
// 在它之前，这一串 8 条判据在 `sqliteIntentApplyOperations.ts` 与
// `postgresqlIntentApplyOperations.ts` 里**逐条对应地各写了一遍**：同样的顺序、同样的错误码、
// 同样的措辞。判据属于 domain，事务与取数才属于 provider。
//
// ⚠️ **刻意拆成三个断言而不是一个大函数**：claim 的读取是与判断交错的
// （先读 session 判归属 → 再读 journal 判重放 → 再读 draft 判其余），
// 合成一个「把所有行都读进来再判」的函数会在重放路径上多读一次 draft，
// 也会改变错误优先级。拆成三段可以让两个 provider 保持**逐字不变的读取顺序与抛出顺序**。

import { ConflictError, NotFoundError } from '@/util/errors'

/** claim 只关心 session 行的这几列——刻意不吃 drizzle 的行类型。 */
export interface IntentApplyClaimSession {
  readonly ownerUserId: string
  readonly status: string
  readonly inFlightTurnId: string | null
  readonly contextRevision: number
  readonly currentDraftId: string | null
}

export interface IntentApplyClaimDraft {
  readonly id: string
  readonly revision: number
  readonly draftHash: string
  readonly contextRevision: number
}

/** ① session 必须存在且属于本人；两者同形（存在性隔离，RFC-099 口径）。 */
export function assertIntentSessionClaimable(
  session: IntentApplyClaimSession | undefined,
  actorUserId: string,
): asserts session is IntentApplyClaimSession {
  if (session === undefined || session.ownerUserId !== actorUserId) {
    throw new NotFoundError('intent-session-not-found', 'intent session not found')
  }
}

/** ② 判过重放之后才检查会话状态——重放要能在归档 / 有 turn 在跑时照样返回既有结果。 */
export function assertIntentSessionReady(session: IntentApplyClaimSession): void {
  if (session.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived')
  }
  if (session.inFlightTurnId !== null) {
    throw new ConflictError('intent-turn-in-flight', 'a generation turn is running')
  }
}

/**
 * ③ draft 的前四条判据（通过则返回窄化后的 draft），顺序即错误优先级：
 * 存在 → hash 对得上 → 基线没动 → 不是被更新版本取代的旧 tab。
 *
 * ⚠️ **第五条（是否已被 resolve）刻意不在这里**：它要多发一次查询，而原实现是在前四条
 * 都通过之后才去读的。合成一个函数会让不存在 / hash 不符的失败路径也多打一次库——
 * 语义不变但读取形态变了，属于「迁位时悄悄改了行为」，正是本 RFC 要防的事。
 */
export function requireCommittableDraft<T extends IntentApplyClaimDraft>(input: {
  readonly draft: T | undefined
  readonly session: IntentApplyClaimSession
  readonly confirmedDraftHash: string
}): T {
  const { draft, session } = input
  if (draft === undefined) {
    throw new NotFoundError('intent-draft-not-found', 'draft revision not found')
  }
  if (draft.draftHash !== input.confirmedDraftHash) {
    throw new ConflictError('intent-draft-hash-mismatch', 'confirmed draft hash does not match', {
      expected: draft.draftHash,
    })
  }
  if (draft.contextRevision !== session.contextRevision) {
    throw new ConflictError(
      'intent-baseline-stale',
      'the session context moved since this draft was generated; rebase and regenerate',
    )
  }
  // Codex impl-gate P1-3: the hash proves WHICH revision was confirmed, not
  // that it is still the CURRENT one — a later turn in the same epoch mints
  // a higher revision without bumping contextRevision. Refuse stale tabs.
  if (session.currentDraftId !== draft.id) {
    throw new ConflictError(
      'intent-draft-superseded',
      'a newer draft revision exists in this session; review and commit the latest draft',
      { confirmedRevision: draft.revision },
    )
  }
  return draft
}

/** ④ 第五条：草稿是否已被解决（拒绝 / 被替换）。读取由 provider 在前四条之后才发。 */
export function assertIntentDraftUnresolved(resolutionReason: string | undefined): void {
  if (resolutionReason !== undefined) {
    throw new ConflictError(
      'intent-draft-superseded',
      `this draft is ${resolutionReason} and can no longer be committed`,
    )
  }
}
