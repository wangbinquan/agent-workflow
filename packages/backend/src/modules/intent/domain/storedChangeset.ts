// RFC-355 T4（RFC-294 W4-E4a）—— 「已落库的 draft changeset」在 apply 时的**唯一**解码判据。
//
// 本函数存在的理由是一条**实测出来的、用户可见的行为漂移**（RFC-355 proposal §2.2）：
//
//   PostgreSQL 的 apply 走 `parseIntentChangeset(...)`，不合法就抛
//   `ValidationError('intent-changeset-invalid', …)` 并带上具体的 parse 错误；
//   SQLite 的 apply 是**裸 `JSON.parse`**，于是同一份坏 draft：
//     · 不可解析 → 抛未分类的 `SyntaxError`，对客户端是 500 而不是带码的 4xx；
//     · 可解析但不是合法 IntentChangeset → **完全不校验**，直接喂进 preflight / resolveIntentBundle。
//
// 既有覆盖只在 turn-engine 层（agent 产出非法 changeset 时报 `intent-changeset-invalid`），
// apply 层这条路径从来没测过——draft 落库之后才损坏、或由更早版本写入的非法内容走的正是这里。
// `rfc355-intent-apply-changeset-validation.test.ts` 是它的先红→转绿用例。
//
// `parseIntentChangeset` 本来就在 `@agent-workflow/shared`，两侧都能用；SQLite 只是没用。

import { parseIntentChangeset, type IntentChangeset } from '@agent-workflow/shared'

import { ValidationError } from '@/util/errors'

/**
 * 解码 draft 里存着的 changeset。**两个 provider 共用这一处**。
 *
 * 失败一律是 `intent-changeset-invalid`——包括「JSON 都不合法」这一种：
 * 一个连 JSON 都不是的 draft 与一个 schema 不合法的 draft，对调用方是同一件事
 * （这份草稿没法应用），不该一个 500 一个 4xx。
 */
export function decodeStoredChangeset(changesetJson: string): IntentChangeset {
  const parsed = parseIntentChangeset(changesetJson)
  if (!parsed.ok) {
    throw new ValidationError(
      'intent-changeset-invalid',
      `stored draft changeset is invalid: ${parsed.errors.join('; ')}`,
    )
  }
  return parsed.changeset
}
