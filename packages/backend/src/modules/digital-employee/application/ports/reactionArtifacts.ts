// RFC-368 —— 数字员工持有的 Reaction 文本产物（重试反馈 / 失败诊断）的持久化端口。
//
// 应用层只认这个端口；实现在 `infrastructure/reactionArtifactStore.ts`，由组合根注入
// （`rfc294-review-module-layer-rules`：application 不直接依赖 infrastructure）。
// 裁剪在调用方做完（`domain/reactionArtifacts.ts` 的 `sanitizeReactionText`），这里只按内容地址存取。

import type { ReactionArtifactKind, SanitizedReactionText } from '../../domain/reactionArtifacts'

export interface ReactionArtifactPersistence {
  /** 按内容地址落一份；同一 digest 已存在时不新增行（AC-9）。返回 `<kind>:<digest>` 形态的 ref。 */
  put(kind: ReactionArtifactKind, text: SanitizedReactionText, now: number): Promise<string>
  /** ref 不可解析、kind 对不上或行不存在 ⇒ null。 */
  read(ref: string): Promise<string | null>
}
