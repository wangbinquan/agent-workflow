// RFC-310 PR-7 T73/T74 —— feedback 台账的纯判定（design §10.2）。
//
// 台账行由 MR facts 采集入账（store.upsertFeedbackObservation，唯一键含
// thread revision 与 head——webhook 重放/重复采集不重复起 action）；这里只做
// 三类纯判定：指纹（同内容跨采集稳定去重）、作者分类（self-marker 防自循环）、
// 可选集（policy 的 allowed/batch/latest-revision 语义）。bot/self 是否处理由
// policy 决定，判定本身不做业务选择。

import { sha256Hex } from '@/util/hash'

/** feedback 台账行（表结构的 domain 视图；store port re-export 本类型）。 */
export interface FeedbackLedgerRow {
  readonly id: string
  readonly missionId: string
  readonly threadRef: string
  readonly revision: string
  readonly headSha: string
  readonly fingerprint: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly state: 'observed' | 'selected' | 'addressed' | 'needs-human' | 'obsolete'
  readonly actionRunId: string | null
  readonly replyEffectId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** 平台自身评论的隐形标记前缀（reply effect 写入，分类器识别防循环）。 */
export const FEEDBACK_SELF_MARKER_PREFIX = '<!-- aw-self:'

/**
 * 观察指纹：thread/revision/head + 正文 digest 的稳定组合。同一 (thread,
 * revision, head) 的重复采集恒同指纹；正文被平台外编辑产生新 revision，
 * 自然换指纹。
 */
export function feedbackFingerprint(input: {
  readonly threadRef: string
  readonly revision: string
  readonly headSha: string
  readonly bodyDigest: string
}): string {
  return sha256Hex(
    `${input.threadRef}\u0000${input.revision}\u0000${input.headSha}\u0000${input.bodyDigest}`,
  )
}

/**
 * 作者三分类（closed）：正文带本平台 self-marker（`<!-- aw-self:<marker> -->`）
 * ⇒ self（防自循环，§10.2「默认忽略自身 marker」）；用户名以 `[bot]` 结尾或
 * 含 `-bot` 后缀段 ⇒ bot；其余 human。marker 命中要求逐字（不同 mission 的
 * marker 不互认——平台多实例共库时不误吞别家评论）。
 */
export function classifyFeedbackAuthor(input: {
  readonly body: string
  readonly authorUsername: string
  readonly selfMarker: string
}): 'human' | 'bot' | 'self' {
  if (
    input.selfMarker.length > 0 &&
    input.body.includes(`${FEEDBACK_SELF_MARKER_PREFIX}${input.selfMarker}`)
  ) {
    return 'self'
  }
  const name = input.authorUsername.toLowerCase()
  if (name.endsWith('[bot]') || name.endsWith('-bot') || name.includes('-bot-')) return 'bot'
  return 'human'
}

/**
 * policy 语义的可选集：
 * 1. requireLatestRevision 时**先**按 threadRef 折叠到 revision 最大行（字符串
 *    字典序比较——provider revision 单调；旧修订永不入选，即便最新行已终结）；
 * 2. 再过滤 state='observed' 且 authorClass ∈ allowedAuthorClasses；
 * 3. 按 createdAt 升序（tie-break id）截断 batchLimit——先来先处理，稳定可回放。
 */
export function selectableFeedback(
  rows: readonly FeedbackLedgerRow[],
  policy: {
    readonly allowedAuthorClasses: readonly string[]
    readonly batchLimit: number
    readonly requireLatestRevision: boolean
  },
): FeedbackLedgerRow[] {
  let pool: readonly FeedbackLedgerRow[] = rows
  if (policy.requireLatestRevision) {
    const latest = new Map<string, FeedbackLedgerRow>()
    for (const row of rows) {
      const prior = latest.get(row.threadRef)
      if (prior === undefined || row.revision > prior.revision) latest.set(row.threadRef, row)
    }
    pool = [...latest.values()]
  }
  return pool
    .filter(
      (row) => row.state === 'observed' && policy.allowedAuthorClasses.includes(row.authorClass),
    )
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, policy.batchLimit)
}

/**
 * `mr.feedback.apply` 的输入闭集素材：validator 经 manifest.feedbackSnapshot
 * 的 (threadRef, revision) 双射对拍（PR-4 已实现），launch 编排把选中行投影成
 * snapshot items（snapshotRef 由编排侧给内容寻址 ref）。
 */
export function feedbackClosedRefs(
  selected: readonly FeedbackLedgerRow[],
): readonly { readonly threadRef: string; readonly revision: string }[] {
  return selected.map((row) => ({ threadRef: row.threadRef, revision: row.revision }))
}
