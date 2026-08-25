// RFC-241 阶段 2 — 锚 mark 的 active 高亮与滚动定位帮助函数,从
// ReviewDocPane 抽取共享。一条意见的选区跨多个 text 节点时会产生同
// data-comment-id 的多段 <mark>,因此 active 高亮必须 querySelectorAll
// 整组切换(此前 ReviewDocPane 只点亮第一段——迁移后当前版同样整组
// 点亮,属良性修正,设计 v6 聚焦复核已确认);滚动定位到第一段。
//
// 纯 DOM 帮助函数,无 React。data-active 属性不在 React VDOM props 里,
// React 更新时不会碰它(ReviewDocPane 既有 effect 同款模式)。

/**
 * RFC-326 —— 一条意见的 mark 有两种挂法,任何按 id 找 mark 的地方都必须两种都认:
 *   · `data-comment-id="X"`  —— 普通文本段,以及代码块里只属于一条意见的原子段;
 *   · `data-comment-ids="X Y"` —— 代码块里被**多条意见重叠覆盖**的原子段。shiki
 *     的 decorations 不接受交叉区间,重叠部分只能切成一个原子段由多条意见共享,
 *     此时 `data-comment-id` 只写最早开始的那条(见 CodeBlock.tsx atomicAnchorSegments)。
 *
 * 只按 `data-comment-id` 找的话,重叠区里**后开始的那条意见永远找不到自己的 mark**
 * ——高亮不亮、滚不过去、气泡掉进 orphan 栏。属性选择器 `~=` 就是空格分隔的词匹配,
 * 与 CodeBlock 写入时的 `join(' ')` 对应。
 */
export function anchorMarkSelector(markSelector: string, commentId: string): string {
  return `${markSelector}[data-comment-id="${commentId}"], ${markSelector}[data-comment-ids~="${commentId}"]`
}

/**
 * 清掉 `markSelector` 全部 mark 的 data-active,再给 `commentId` 的整组
 * mark 打上。`commentId` 传 null 时只清不设。
 */
export function setActiveAnchorMarks(
  root: HTMLElement,
  commentId: string | null,
  markSelector: string,
): void {
  root.querySelectorAll<HTMLElement>(`${markSelector}[data-active]`).forEach((m) => {
    m.removeAttribute('data-active')
  })
  if (commentId === null) return
  root.querySelectorAll<HTMLElement>(anchorMarkSelector(markSelector, commentId)).forEach((m) => {
    m.setAttribute('data-active', 'true')
  })
}

/**
 * 滚动到该意见的第一段 mark。instant 滚动(behavior: 'auto')——真实鼠标
 * 点击会打断 smooth 滚动动画,见 ReviewDocPane 的 RFC-082 fix 注释。
 * 返回是否找到 mark(未定位意见返回 false,调用方不滚)。
 */
export function scrollToAnchorMark(
  root: HTMLElement,
  commentId: string,
  markSelector: string,
): boolean {
  const el = root.querySelector<HTMLElement>(anchorMarkSelector(markSelector, commentId))
  if (el === null) return false
  el.scrollIntoView({ behavior: 'auto', block: 'center' })
  return true
}
