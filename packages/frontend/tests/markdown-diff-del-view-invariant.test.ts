// RFC-241 阶段 2 — 语义基础不变量守卫(design v6 §语义基础,聚焦复核修订
// 稿):merged 文档剔除 ins 内容后的 del/context 流,相对上一版原文 L 是
// 保序近似。对无表格 / 无 math 的文档对,断言归一化后 token 序列相等。
//
// 归一化规范(测 12 所选规则,写死于此;聚焦复核指出逐字节等式恒不成立
// 的三个 context 残留源——ins 行的外置结构前缀与行间空行、removed 原子
// pad 补的空行、拆行修复插入的空行):
//   1. extractMarkedView(merged, 'del') 得 del 视图;
//   2. 按行拆分,丢弃「结构框架行」——仅由空白与结构前缀字符
//      [>#*+`\-\d.=] 组成的行(涵盖:空行、ins 行剥掉 ins 内容后残留的
//      `- ` / `### ` / '```' 框架、setext 下划线、pad 空行);两侧同规则,
//      L 自身的 '---' / '===' 等纯结构行也对称丢弃,等式不受影响;
//   3. tokenizeForWordDiff 切词,丢弃纯空白 token;
//   4. 与 L 同归一化后的序列逐项相等。
// 该规则同时保住「防污染」方向:若 ins 内容错漏进 del 视图,所在行含
// 非结构字符,不会被 (2) 丢弃,序列必不等 → 测试红。

import { describe, expect, test } from 'vitest'
import {
  buildMergedMarkdown,
  extractMarkedView,
  tokenizeForWordDiff,
  type DiffGranularity,
} from '../src/lib/review/markdownDiff'

const FRAME_LINE_RE = /^[\s>#*+`\-\d.=]*$/

function normalize(text: string): string[] {
  const kept = text
    .split('\n')
    .filter((line) => !FRAME_LINE_RE.test(line))
    .join('\n')
  return tokenizeForWordDiff(kept).filter((t) => !/^\s+$/u.test(t))
}

function assertDelViewPreservesLeft(left: string, right: string, g: DiffGranularity): void {
  const merged = buildMergedMarkdown(left, right, g)
  const delView = extractMarkedView(merged, 'del')
  expect(normalize(delView)).toEqual(normalize(left))
}

// 文档对夹具:无表格、无 math(两者是设计明示的破例面,分别由表格校验
// 回退与 katex 排除承担,见 review-diff-prior-comments.test.tsx #9c/#9d)。
const PAIRS: Array<{ name: string; left: string; right: string }> = [
  {
    name: '恒等(L === R)',
    left: '# 标题\n\n一段正文内容。\n',
    right: '# 标题\n\n一段正文内容。\n',
  },
  {
    name: '段中词替换',
    left: '这是一段包含旧词汇的正文,后面还有更多内容。\n',
    right: '这是一段包含新词汇的正文,后面还有更多内容。\n',
  },
  {
    name: '段中词删除',
    left: '开头 alpha beta gamma 结尾。\n',
    right: '开头 alpha gamma 结尾。\n',
  },
  {
    name: '段中词插入',
    left: '开头 alpha gamma 结尾。\n',
    right: '开头 alpha beta gamma 结尾。\n',
  },
  {
    name: '新增整段(纯 prose)',
    left: '第一段。\n',
    right: '第一段。\n\n新增的第二段内容。\n',
  },
  {
    name: '删除整段',
    left: '第一段。\n\n将被删除的第二段。\n',
    right: '第一段。\n',
  },
  {
    name: '标题文本编辑',
    left: '## 旧的章节名\n\n正文。\n',
    right: '## 新的章节名\n\n正文。\n',
  },
  {
    name: '标题层级变化(前缀改动)',
    left: '## 章节\n\n正文。\n',
    right: '### 章节\n\n正文。\n',
  },
  {
    name: '列表项编辑 + 删除',
    left: '- 第一项旧文\n- 第二项保留\n- 第三项将删\n',
    right: '- 第一项新文\n- 第二项保留\n',
  },
  {
    name: '列表项新增(结构行加入,ins 前缀残留由框架行规则对消)',
    left: '- 第一项\n',
    right: '- 第一项\n- 新增项内容\n',
  },
  {
    name: 'fence 未变更(context 保序入流)',
    left: '```js\nconst kept = 1\n```\n\n后文。\n',
    right: '```js\nconst kept = 1\n```\n\n后文变了。\n',
  },
  {
    name: '引用块编辑',
    left: '> 引用的旧句子。\n\n正文。\n',
    right: '> 引用的新句子。\n\n正文。\n',
  },
  {
    name: 'setext 标题编辑',
    left: '旧标题文字\n=========\n\n正文。\n',
    right: '新标题文字\n=========\n\n正文。\n',
  },
  {
    name: '链接 URL 变化(原子化路径)',
    left: '参见 [文档](https://old.example/a) 链接。\n',
    right: '参见 [文档](https://new.example/b) 链接。\n',
  },
  {
    name: 'CJK + emoji 编辑',
    left: '中文与表情 👍🏻 混排的一句旧话。\n',
    right: '中文与表情 👍🏿 混排的一句新话。\n',
  },
  {
    name: '空文档 → 有内容',
    left: '',
    right: '全新的第一段。\n',
  },
  {
    name: '有内容 → 空文档',
    left: '将被整体删除的段落。\n',
    right: '',
  },
  {
    name: '行前缀替换(list → quote)',
    left: '- 前缀会变的一行\n',
    right: '> 前缀会变的一行\n',
  },
  {
    name: '标点密集编辑',
    left: '(旧)——「引号」、括号;以及……结尾!\n',
    right: '(新)——「引号」、括号;以及……收尾!\n',
  },
]

describe('RFC-241 阶段 2:del 视图保序近似不变量(word / line)', () => {
  for (const g of ['word', 'line'] as const) {
    for (const p of PAIRS) {
      test(`[${g}] ${p.name}`, () => {
        assertDelViewPreservesLeft(p.left, p.right, g)
      })
    }
  }
})

describe('RFC-241 阶段 2:变更 fence 破例锁定(块级原子还原丢 marker)', () => {
  // RFC-010 的既有取舍:marker 落在 fence 头部会破坏 fence 解析、落在
  // fence 内部只是 code 文本里的 PUA 字符(markdownDiff.ts 顶部注释),
  // 因此块级 fence 原子还原后新旧两块都不带 marker——**新 fence 内容以
  // context 形态进入 del/context 流**,是保序近似的一条破例(design v7
  // §语义基础):残余风险面 =「锚点在变更 fence 之后 + selectedText 出现
  // 在新 fence 内容中」的计数右移;锚在旧 fence 文本上仍可命中(旧内容
  // 保序在流中)。此锁如果变红,说明 markdownDiff 开始给 fence 携带
  // marker——届时应回头收紧锚定侧的排除/校验并更新设计。
  for (const g of ['word', 'line'] as const) {
    test(`[${g}] fence 编辑:del 视图按序含旧+新两块内容`, () => {
      const left = '```js\nconst legacy = 1\n```\n\n后文。\n'
      const right = '```js\nconst modern = 2\n```\n\n后文。\n'
      const merged = buildMergedMarkdown(left, right, g)
      const delView = extractMarkedView(merged, 'del')
      const reference = '```js\nconst legacy = 1\n```\n\n```js\nconst modern = 2\n```\n\n后文。\n'
      expect(normalize(delView)).toEqual(normalize(reference))
    })
  }
})
