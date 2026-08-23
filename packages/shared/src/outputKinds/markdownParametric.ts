// RFC-060 PR-A — parametric 'markdown' base kind handler. Passthrough.
// Sibling to outputKinds/markdown.ts under the new parametric registry.

import { isReviewableBodyKind, type ParsedKind } from '../kindParser'
import { joinMarkdownDocs, splitMarkdownDocs } from '../listWire'
import type { ParametricOutputKindHandler } from './registry'

const handler: ParametricOutputKindHandler = {
  displayName: 'markdown',
  subReasons: new Set<string>(),
  matches: (p: ParsedKind) => p.kind === 'base' && p.name === 'markdown',
  baseNames: ['markdown'],
  carriesData: () => true,
  bulletSuffix: () => null,
  examplePlaceholder: () => '...',
  // RFC-080/081: a base 'markdown' port is a single reviewable document body.
  // Delegates to the kindParser predicate (single source of truth).
  isReviewableBody: (p: ParsedKind) => isReviewableBodyKind(p),
  buildPromptGuidance: () => null,
  // RFC-317 T57（findings NK-01）—— markdown 条目是**多行文档正文**，
  // 用边界行分隔，不能按行切。默认的 `splitListItems` 会 trim 每一行、丢掉所有空行，
  // 于是段落间距、缩进、代码块的相对缩进在落库前就没了。
  // 这两条让 `list<markdown>` 的 codec 由 markdown 自己说了算，
  // 而不是由 `ListHandler.validate` 里一句无条件的按行切决定。
  splitItems: (_parsed, rawContent) => splitMarkdownDocs(rawContent),
  joinItems: (_parsed, items) => joinMarkdownDocs(items),
  validate: (rawContent) => ({ ok: true, body: rawContent }),
  buildRepairBlock: () => null,
}

export default handler
