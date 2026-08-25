// RFC-010 — 渲染态内联 diff 视图。
//
// 输入两份 markdown，先用 buildMergedMarkdown 拼成"含 PUA marker 的 merged
// markdown"，再用 react-markdown + remarkDiffMarkers 渲染成"prose 形态 +
// 内联高亮 <span class=\"diff-ins\"|\"diff-del\">"。
//
// 与 Prose.tsx 的关系：复用 react-markdown + remark-gfm + remark-alert +
// remark-math + 同套 rehype 链；不引 PlantUML / 图片 zoom（review diff
// 不需要）。如未来发现需要完全等价，再抽公共 plugin 配置。
//
// fallback：若构建或渲染抛错，回到 <pre>{merged}</pre>，至少不崩页。

import { useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { remarkAlert } from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import { rehypeWrapAnchors, type AnchorWrapInput } from '@/components/prose/rehypeWrapAnchors'
import { buildMergedMarkdown, type DiffGranularity } from '@/lib/review/markdownDiff'
import { remarkDiffMarkers } from '@/lib/review/remarkDiffMarkers'

// RFC-241 阶段 2 — 上一版意见锚进 merged diff 文档的匹配策略(design v6
// §语义基础):排除 .diff-ins 子树后的 del/context 文本流相对上一版原文
// 保序近似;word 档行内公式被 resolveMarkedString 解析成仅新版,katex
// 输出整树出流(正常形态 .katex,ParseError 形态 .katex-error);次数不足
// 走 strict 弃锚(未定位回退),不 clamp 错钉;word 档另有配对表重排校验
// (tableGuard)。mark class 与当前版区分,样式 / 测量选择器按它查询。
export const PRIOR_ANCHOR_MARK_CLASS = 'prior-comment-anchor'
const PRIOR_ANCHOR_EXCLUDE_CLASSES = ['diff-ins', 'katex', 'katex-error'] as const

export interface MarkdownDiffViewProps {
  left: string
  right: string
  /** word（默认）/ line / block。不同 granularity 仅改变 jsdiff 路径，
   *  渲染管线（remark + rehype 链 + 高亮 CSS）共用。 */
  granularity?: DiffGranularity
  className?: string
  /** RFC-241 阶段 2:上一版检视意见的锚(hast 阶段包 mark;后挂载 DOM
   *  突变会撞 React reconciliation,禁走 legacy wrapAnchorsInDom)。 */
  priorAnchors?: ReadonlyArray<AnchorWrapInput>
}

export function MarkdownDiffView({
  left,
  right,
  granularity = 'word',
  className,
  priorAnchors,
}: MarkdownDiffViewProps): ReactNode {
  const merged = useMemo(() => {
    try {
      return buildMergedMarkdown(left, right, granularity)
    } catch {
      return null
    }
  }, [left, right, granularity])

  const rehypePlugins = useMemo(() => {
    const base: unknown[] = [
      [rehypeKatex, { strict: false, output: 'html' }],
      rehypeSlug,
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          properties: {
            className: ['prose__anchor'],
            ariaHidden: 'true',
            tabIndex: -1,
          },
          content: { type: 'text', value: '#' },
        },
      ],
      [
        rehypeExternalLinks,
        {
          target: '_blank',
          rel: ['noopener', 'noreferrer'],
        },
      ],
    ]
    // 置于链尾:katex / autolink 产出的 className 先落地,排除列表与
    // 表格校验才能看到最终形态(与 Prose 的 rehypeWrapAnchors 位次同理)。
    if (priorAnchors !== undefined && priorAnchors.length > 0) {
      base.push([
        rehypeWrapAnchors,
        {
          anchors: priorAnchors,
          markClass: PRIOR_ANCHOR_MARK_CLASS,
          strictOccurrence: true,
          excludeClasses: PRIOR_ANCHOR_EXCLUDE_CLASSES,
          tableGuard: granularity === 'word',
          // RFC-326: the merged diff document is NOT the document the prior
          // anchors were resolved against — their source offsets mean nothing
          // here, so this path stays on text matching explicitly.
          mode: 'text',
        },
      ])
    }
    return base as unknown as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
  }, [priorAnchors, granularity])

  const wrapperClass = 'markdown-diff-view prose' + (className !== undefined ? ' ' + className : '')

  if (merged === null) {
    return (
      <div className={wrapperClass} data-fallback="true" data-granularity={granularity}>
        <pre>{left + '\n---\n' + right}</pre>
      </div>
    )
  }

  return (
    <div className={wrapperClass} data-testid="markdown-diff-view" data-granularity={granularity}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlert, remarkMath, remarkDiffMarkers]}
        rehypePlugins={rehypePlugins}
      >
        {merged}
      </ReactMarkdown>
    </div>
  )
}
