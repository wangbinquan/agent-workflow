// RFC-270 §2.1 — 把一个 actor 的权限翻译成特权节点的**观察镜头**。
//
// 判据与两个 author 门读的是**同一个 `permissions` 集合**（`scriptAuthorGate.ts`
// 的 `principal.actor.permissions.has('scripts:author')` /
// `codeHostAuthorGate.ts` 的 `code-host-calls:author`），所以「能写的一定能看」
// 是构造保证的，不需要额外断言，也不可能漂移出「看得见但存不了」或反过来的组合。
//
// 这里刻意不复用 `tokenRedaction.ts` 的 `shouldRedactFor(source)`：那条轴问的是
// 「这是不是令牌通道」，本轴问的是「这个人有没有创作权」。两条轴正交且叠加——
// 一个既是 PAT 又无 `scripts:author` 的调用方两条都吃。

import { PRIVILEGED_LENS_TRANSPARENT, type PrivilegedNodeLens } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

export function privilegedNodeLensFor(actor: Actor): PrivilegedNodeLens {
  const scripts = !actor.permissions.has('scripts:author')
  const codeHost = !actor.permissions.has('code-host-calls:author')
  // 常量复用而不是新造对象：读出口靠「镜头透明 ⇒ 返回同一引用」短路，能少一次
  // 全量节点遍历。
  return scripts || codeHost ? { scripts, codeHost } : PRIVILEGED_LENS_TRANSPARENT
}
