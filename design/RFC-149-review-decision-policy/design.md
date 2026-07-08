# RFC-149 · review 决策策略表 + 前端历史视图收敛（design）

> 行号为 2026-07-08 调研实测（review.ts 2851 行基准）。

## 1. 策略表（backend services/review.ts 局部）

```ts
interface ReviewDecisionPolicy {
  /** 维2+维10：reviewIteration 是否 +1（approved 不 bump；广播实参同源化）。 */
  bumpsIteration: boolean
  /** 维8：node_run 生命周期事件。 */
  lifecycleEvent: 'approve-review' | 'reject-review' | 'iterate-review'
  /** 维9：decisionReason 归档派生。 */
  decisionReason: 'reject-reason' | 'render-comments' | 'none'
  /** 维3/4：reject/iterate 才有的重跑配置（approved 稀疏 ⇒ undefined）。 */
  rerun?: {
    rerunnableKey: 'rerunnableOnReject' | 'rerunnableOnIterate'
    rollbackKey: 'rollbackFilesOnReject' | 'rollbackFilesOnIterate'
    rollbackDefault: boolean            // reject→true / iterate→false（不对称显式化）
    supersededByReview: 'rejected' | 'iterated'   // 维5（列值；marker 由此派生）
    mintCause: 'review-reject' | 'review-iterate' // 维6
    cascade: 'always' | 'sibling-sync-conditional' // 维7
  }
}
const REVIEW_DECISION_POLICY = { approved: {...}, rejected: {...}, iterated: {...} }
  as const satisfies Record<ReviewDecisionKind, ReviewDecisionPolicy>
```

- 消费点改造：submitReviewDecision 的 :1853-1861（decisionReason）/:1876（广播）/
  :2004-2014（键名对）/:2082-2104（marker+列值）/:2108-2112（mintCause）/
  :2136-2157（cascade 语义查表，conditional 的 `iterateSiblingCascadeApplies` 调用保留在
  分支体）/:1963-1968 与 :2162-2167（lifecycleEvent）。
- **骨架保留**：approve 早返回（:1881/:1978）与 multi-doc approve gate（:1831-1836，
  仅 approved 校验 allDocumentsDecided）是路径结构不是策略维——保留 if，内部查表。
- buildReviewPromptContext（:2481-2525）：per-decision ctx 构造器不进主表
  （它吃 dv 行与 DB、闭包依赖重）——改为同文件 `REVIEW_PROMPT_CTX_BUILDERS:
Record<ReviewDecisionKind|'pending'|'superseded', builder|null>` 姊妹表，
  multi-inline iterate 聚合分支为 iterated builder 内部逻辑。
- approval_meta.decision 字面量（:1925/:1740）与端口名（:1945 'approved_doc'/
  :1751 'accepted'）改引 shared 常量（§3）。

## 2. 轮模式单一真源

```ts
// services/review.ts（decision 侧唯一判据；dispatch 侧 kind 推导是生产者，不动）
export function resolveReviewRoundMode(
  dvs: ReadonlyArray<{ itemIndex: number | null; itemPath: string | null }>,
): 'single' | 'multi-inline' | 'multi-path'
```

- 收敛点：:1827（isMultiDoc some-itemIndex）/ :1720（itemsInline every-itemPath-null）
  与 approveMultiDocReview 内的重推——4 处 NULL-sentinel 判定 → 一个 helper。
- 单测锁三态判定格（空数组/混合 NULL 的边界显式落格）。

## 3. shared 常量补齐（reviewMultiDoc.ts）

```ts
export const REVIEW_APPROVED_PORT_SINGLE = 'approved_doc' as const
export const REVIEW_APPROVED_PORT_MULTI = 'accepted' as const
// reviewApprovedPortName 内部改引这两常量（返回类型收窄不变）
export const REVIEW_APPROVAL_META_PORT = 'approval_meta' as const（若已有则复用）
```

- review.ts 发布口 + approval_meta 'approved' 字面量改引；validator/canvas 零改动
  （已走 oracle）。

## 4. decidedBy 最小治理（shared/schemas/review.ts + review.ts）

```ts
export const SYSTEM_DECIDER = 'system' as const
export const LOCAL_DECIDER = 'local' as const
export function isSystemDecision(decidedBy: string | null | undefined): boolean
```

- 写点 4（:1863 'local' 兜底 / :539-542 与 :2358-2361 'system' / :840 null 不动）、
  读点 3（:2466/:2491 ne(...,'system')、前端 ReviewDecisionInfo:40 与
  useUserLookup SENTINELS）改引常量/谓词；wire 类型不动。

## 5. 前端收敛（独立 PR）

- `lib/review/readonly.ts`：新增 `resolveRoundView(roundQuery, rounds)`（与
  resolveReviewView 同形五规则；加载态与单文档对齐=乐观 historical，消调研发现的
  loading 行为不一致）+ `ReviewPaneMode = 'awaiting' | 'decided' | 'historical'`
  - `pickViewedVersion(view, historicalDetail, current)` 一次挑齐对象
    （decidedBy/decidedByRole/decision/decisionReason/decidedAt/versionIndex/body...）。
- `routes/reviews.detail.tsx`：12 逐字段三元 → viewedVersion；11 守卫改 mode 判。
- `MultiDocReviewView.tsx`：sentinel 链（:90-103）→ resolveRoundView；
  `readonly={!awaiting}` 塌缩 → mode（补 'decided' 态——多文档当前轮已决策时
  按钮可见但禁用，与单文档对齐）；decisionSource 5 三元 → viewedVersion。
- `ReviewDocPane.tsx`：(readonly, awaiting) 布尔对 → 单 `mode` prop（非法态不可
  表示）；内部 9 守卫点改判。
- 内联枚举替换：decisionChip.ts ReviewDecisionView / reviews.detail:188 /
  MultiDocReviewView:190 三处 → 从 shared 导入。
- 测试：reviews-detail-readonly-source 源码锁改写；review-resolve-view clone 出
  resolve-round-view 单测；multidoc-historical-round 等 DOM 锁零改动全绿。

## 6. 决策记录

- **D1** promptCtx 构造器入姊妹表不入主表（依赖形状不同：主表纯数据、ctx 表闭包吃 DB）。
- **D2** approve 早返回骨架保留——表化差异不重排控制流（golden 行为锁护航）。
- **D3** 轮模式只收 decision 侧（dispatch 侧是生产者；跨侧真源统一需把 kind 落列，
  列非目标）。
- **D4** decidedBy 不上枚举列（wire 兼容 + 产品无新决策者类型需求；谓词化止血）。
- **D5** 前端 PR 与 backend PR 完全独立（调研证实零源码耦合，交叉面全在 shared 枚举）。

## 7. 测试策略

- backend：策略表值锁 + resolveReviewRoundMode 三态格 + 决策分支 grep 棘轮
  （`args.decision ===` 在策略维上的散装比较清零，白名单=骨架 if）+ 行为锁群
  （review-state-machine/approve-idempotent/iterate-sibling-cascade/multidoc 群/
  rfc142-review-rounds）零改动全绿；内部形态锁（decision-full-asserts/rfc131）随迁。
- frontend：resolve-round-view 新单测（五规则）+ readonly-source 锁改写 +
  multidoc 'decided' 态新格 + DOM 锁群零改动。

## 8. 任务分解 → plan.md（2 PR）
