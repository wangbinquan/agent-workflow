// RFC-103 T4 (调研报告 05-PORT-06/07) — fanout 分片走 listWire kind-aware 切分。
//
// 为什么这条测试存在：wrapper-fanout 原本对 shardSource 内容裸 `.split('\n')`，
// 绕过单一事实源 listWire。对 list<markdown>（多行文档、以 MARKDOWN_DOC_BOUNDARY
// 分隔）会把每个文档按行裂成多个分片，shard 数与内容全错而任务仍 green。修复后
// 按 itemKind 选 splitter：list<markdown> → splitMarkdownDocs；list<path<md>> /
// list<string> → splitListItems。锁定切分判定的共享原语 + scheduler 不再裸 split。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  isInlineMarkdownItemKind,
  splitListItems,
  splitMarkdownDocs,
  tryParseKind,
  MARKDOWN_DOC_BOUNDARY,
} from '@agent-workflow/shared'

function itemKindOf(listKind: string) {
  const parsed = tryParseKind(listKind)
  if (parsed === null || parsed.kind !== 'list') throw new Error(`not a list kind: ${listKind}`)
  return parsed.item
}

describe('RFC-103 T4 — itemKind → splitter 判定（共享单一事实源）', () => {
  test('list<markdown> 的 item 判为 inline-markdown（用 boundary 切分）', () => {
    expect(isInlineMarkdownItemKind(itemKindOf('list<markdown>'))).toBe(true)
  })
  test('list<path<md>> 的 item 不是 inline-markdown（按行切分）', () => {
    expect(isInlineMarkdownItemKind(itemKindOf('list<path<md>>'))).toBe(false)
  })
  test('list<string> 的 item 不是 inline-markdown（按行切分）', () => {
    expect(isInlineMarkdownItemKind(itemKindOf('list<string>'))).toBe(false)
  })
})

describe('RFC-103 T4 — 切分结果（list<markdown> 不再按行裂分）', () => {
  test('list<markdown>：2 个各含换行的文档 → 切出 2 个分片，内容完整', () => {
    const wire = `# Doc One\nline a\nline b\n${MARKDOWN_DOC_BOUNDARY}\n# Doc Two\nline c\nline d`
    const docs = splitMarkdownDocs(wire)
    expect(docs).toHaveLength(2)
    expect(docs[0]).toBe('# Doc One\nline a\nline b')
    expect(docs[1]).toBe('# Doc Two\nline c\nline d')
  })
  test('对比：同样内容若按行裂分会错算成 7 个分片', () => {
    const wire = `# Doc One\nline a\nline b\n${MARKDOWN_DOC_BOUNDARY}\n# Doc Two\nline c\nline d`
    // splitListItems 会把 boundary 行也算进去（7 行），证明用错 splitter 的后果。
    expect(splitListItems(wire).length).toBeGreaterThan(2)
  })
  test('list<path<md>>：路径按行切分', () => {
    expect(splitListItems('a/x.md\nb/y.md\nc/z.md')).toEqual(['a/x.md', 'b/y.md', 'c/z.md'])
  })
})

describe('RFC-103 T4 — 源码层断言（wrapper mechanics 不再裸 split）', () => {
  const wrapperSrc = readFileSync(
    join(import.meta.dir, '../src/modules/task-execution/engine/wrapper/fanoutStrategy.ts'),
    'utf8',
  )
  // RFC-317 T57（findings NK-01）—— 证据锚点更新，性质不变。
  //
  // 这里原本钉的是 `isInlineMarkdownItemKind(itemKind)` + 两个 listWire splitter 的
  // 具体调用形态。要锁的性质是「分片按 **item kind** 选 codec，而不是裸 split」；
  // 那个 if 分支只是当时的实现。T57 把 codec 选择下沉进 handler 之后，
  // 同一个判断由 `splitPortItems` 统一做——它内部按 item kind 取 handler 的
  // `splitItems`。改锚到新形状，并多锁一条：调度器不得再自己直调 codec
  //（那正是「第三份独立判据」的形态，而另两份当时都忘了分支）。
  test('fanout 经 splitPortItems 按 item kind 选 codec，而非裸 split 或直调 codec', () => {
    expect(wrapperSrc).toContain('splitPortItems(itemKind, rawContent)')
    expect(wrapperSrc).not.toContain('rawContent\n    .split')
    expect(wrapperSrc).not.toContain('splitMarkdownDocs(')
    expect(wrapperSrc).not.toContain('splitListItems(')
  })
})
