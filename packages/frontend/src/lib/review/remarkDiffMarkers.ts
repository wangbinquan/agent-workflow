// RFC-010 — remark 插件：把 PUA marker（INS_OPEN/CLOSE、DEL_OPEN/CLOSE）
// 从 mdast 里切出来，替换成带 hName='span' + className 的 "diffMark" 节点。
// mdast→hast 阶段会按 hName/hProperties 直接生成
// <span class="diff-ins"|"diff-del">，全程不依赖 rehype-raw（保持 RFC-008
// 的 XSS-safe 不变量）。
//
// 2026-07-16 重构（评审页 diff 乱码 / 高亮丢失修复）：
//   1. 旧实现逐 text 节点独立配对 marker——open/close 一旦分居不同 text
//      节点（整行新增里夹 **bold** / `code` / [link] 时必然如此），两侧
//      都当"未配对"吞掉，整行高亮静默消失。现改为 sibling 级状态机：
//      在同一 parent 的 children 序列上持续扫描，open 之后的兄弟元素节点
//      整个收进当前 diffMark，直到遇到 close。
//   2. code / inlineCode / math / inlineMath / html 等"带 value 的叶子
//      节点"不经过 text 处理，残留 marker 会被浏览器渲染成 tofu 方块
//      （乱码）。现在统一剥掉这些节点 value 里的 marker 字符；link /
//      image 的 url、title 同理（marker 落进 URL 会污染 href）。
//      markdownDiff 的占位符原子化让 marker 正常情况下不会落进 code，
//      这里是最后一道保险丝。
//
// 算法：
//   1. 后序递归：先处理每个子节点的子树（子树内部自行配对），再在本层
//      children 上跑 sibling 状态机。
//   2. text 节点内的字符逐个走状态机；非 text 节点按当前模式归组（context
//      → 原样保留；ins/del → 收进当前 diffMark）。
//   3. 未配对的 open marker 吞掉 marker 本身、内容摊平回原位置（容错，
//      不丢字不崩渲染）；孤儿 close marker 直接吞。
//
// 不引入 unist-util-visit 依赖，递归足够用。
//
// 注意：直接在 source 用 PUA 字符字面量容易在编辑链路上被剥（曾被 Write
// 工具脱掉），一律从 MARKERS 单一来源派生 / 运行时拼接，避免漂移。

import { MARKERS } from './markdownDiff'

const STRIP_MARKER_RE = new RegExp(
  '[' + MARKERS.INS_OPEN + MARKERS.INS_CLOSE + MARKERS.DEL_OPEN + MARKERS.DEL_CLOSE + ']',
  'g',
)

interface TextNode {
  type: 'text'
  value: string
}

interface DiffMarkNode {
  type: 'diffMark'
  data: {
    hName: 'span'
    hProperties: { className: string[] }
  }
  children: AnyNode[]
}

interface ParentNode {
  type: string
  children?: AnyNode[]
  value?: string
  url?: string
  title?: string | null
}

type AnyNode = ParentNode | TextNode | DiffMarkNode

type Mode = 'ins' | 'del'

function makeMark(kind: Mode): DiffMarkNode {
  return {
    type: 'diffMark',
    data: {
      hName: 'span',
      hProperties: { className: [kind === 'ins' ? 'diff-ins' : 'diff-del'] },
    },
    children: [],
  }
}

/**
 * sibling 级状态机：对一个 parent 的 children 序列做 marker 配对。
 * text 内的 open/close 正常切分；open 与 close 之间遇到的元素节点
 * （strong / em / inlineCode / link…）整个收进当前 diffMark，这样
 * "整行新增里夹内联格式"的高亮不再丢失。
 */
function groupChildren(kids: AnyNode[]): AnyNode[] {
  const out: AnyNode[] = []
  // 状态放对象属性而非 let 变量：闭包内赋值的 let 会被 TS 控制流分析
  // narrow 成 null → never，属性访问则始终取声明类型。
  const st: { mode: Mode | null; mark: DiffMarkNode | null; buf: string } = {
    mode: null,
    mark: null,
    buf: '',
  }

  const flushBuf = (): void => {
    if (st.buf.length === 0) return
    const node: TextNode = { type: 'text', value: st.buf }
    st.buf = ''
    if (st.mark !== null) {
      st.mark.children.push(node)
    } else {
      out.push(node)
    }
  }
  const openMark = (kind: Mode): void => {
    flushBuf()
    st.mark = makeMark(kind)
    st.mode = kind
  }
  const closeMark = (): void => {
    flushBuf()
    if (st.mark !== null && st.mark.children.length > 0) out.push(st.mark)
    st.mark = null
    st.mode = null
  }

  for (const child of kids) {
    if (child.type === 'text') {
      for (const ch of (child as TextNode).value) {
        if (ch === MARKERS.INS_OPEN || ch === MARKERS.DEL_OPEN) {
          // 嵌套 / 错位的二次 open：先关上当前段再开新段
          if (st.mode !== null) closeMark()
          openMark(ch === MARKERS.INS_OPEN ? 'ins' : 'del')
        } else if (ch === MARKERS.INS_CLOSE || ch === MARKERS.DEL_CLOSE) {
          // 与当前段种类不匹配的 close 也终结当前段（错位容错）；
          // context 下的孤儿 close 直接吞掉（不渲染 PUA）
          if (st.mode !== null) closeMark()
        } else {
          st.buf += ch
        }
      }
      continue
    }
    flushBuf()
    if (st.mark !== null) {
      st.mark.children.push(child)
    } else {
      out.push(child)
    }
  }

  // 终止：未闭合的 diff 段吞掉 open marker，内容原样摊平（不加高亮）
  if (st.mark !== null) {
    flushBuf()
    out.push(...st.mark.children)
    st.mark = null
    st.mode = null
  } else {
    flushBuf()
  }

  return out
}

/**
 * 状态机扫一遍 s，按 marker 切分输出 (text | diffMark)[]。
 * 未配对的 open marker 只丢 marker 不丢内容，孤儿 close marker 吞掉。
 * （groupChildren 对单 text 输入的特例，保留作为独立纯函数供测试锁定。）
 */
export function splitMarkers(s: string): Array<TextNode | DiffMarkNode> {
  return groupChildren([{ type: 'text', value: s }]) as Array<TextNode | DiffMarkNode>
}

/** 带 value 的非 text 叶子（code / inlineCode / math / html…）与 link/image
 *  的 url、title：剥掉残留 marker，防止 PUA 字符渲染成乱码方块。 */
function stripNodeStrings(node: ParentNode): void {
  if (node.type !== 'text' && typeof node.value === 'string') {
    node.value = node.value.replace(STRIP_MARKER_RE, '')
  }
  if (typeof node.url === 'string') {
    node.url = node.url.replace(STRIP_MARKER_RE, '')
  }
  if (typeof node.title === 'string') {
    node.title = node.title.replace(STRIP_MARKER_RE, '')
  }
}

function transformTree(node: ParentNode): void {
  const kids = node.children
  if (kids === undefined) return
  for (const child of kids) {
    if (child.type === 'text') continue
    stripNodeStrings(child as ParentNode)
    transformTree(child as ParentNode)
  }
  node.children = groupChildren(kids)
}

/**
 * unified Plugin（loose typing — 不强依赖 unified/mdast 类型包，避免
 * 在 frontend package.json 多塞依赖）。
 */
export function remarkDiffMarkers(): (tree: ParentNode) => void {
  return (tree) => {
    transformTree(tree)
  }
}
