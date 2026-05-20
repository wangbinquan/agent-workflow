// RFC-008 T1 — Premium markdown renderer (review + editor preview share).
//
// Stack:
//   - react-markdown 10 (processSync — sync plugins only)
//   - remark-gfm (tables / strikethrough / task lists / footnotes / autolink)
//   - rehype-slug + rehype-autolink-headings (`#` anchor next to each h1-h6)
//   - rehype-external-links (target=_blank + visual icon for absolute URLs)
//
// Notes:
//   - We deliberately do NOT enable rehype-raw — business markdown does not
//     need inline HTML, and skipping it makes the renderer XSS-safe by
//     construction (react-markdown escapes text by default).
//   - shiki integration is *not* via rehype-pretty-code: rehype-pretty-code
//     calls shiki async, but react-markdown 10's processSync can't drive
//     async plugins. Instead our `pre` override (CodeBlock.makePreBlock)
//     renders a `<ShikiPre>` React component that lazy-loads shiki on
//     mount and swaps its innerHTML to the highlighted output.
//
// T2 adds: remark-github-blockquote-alert + remark-math/rehype-katex +
// medium-zoom on <img>. T3 swaps the existing MarkdownView / MarkdownEditor
// consumers over and deletes the old renderers.
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeExternalLinks from 'rehype-external-links'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import { remarkAlert } from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import { makeCode, PassThroughPre } from './CodeBlock'
import { makeProseImage } from './ProseImage'
import { rehypeWrapAnchors, type AnchorWrapInput } from './rehypeWrapAnchors'

export type { AnchorWrapInput } from './rehypeWrapAnchors'

export interface ProseProps {
  /** Raw markdown body. Pass the deferred value when called from an editor. */
  body: string
  /** Task id for resolving workspace-relative image hrefs. */
  taskId?: string
  /** PlantUML render endpoint (kroki-compatible). */
  plantumlEndpoint?: string
  /** Authorization header for the plantuml endpoint. */
  plantumlAuthHeader?: string
  /** Additional class on the outer wrapper (joins `.prose`). */
  className?: string
  /**
   * RFC-051 — Optional review-comment anchors. When provided and non-empty,
   * each occurrence of an anchor's `selectedText` is wrapped with
   * `<mark class="comment-anchor" data-comment-id>` *inside the React
   * tree* (via a local rehype plugin) instead of via post-mount DOM
   * mutation. Omitting the prop or passing `[]` leaves output
   * byte-identical to the legacy non-review callers (editor preview,
   * memory body, distill job detail, etc.).
   */
  anchors?: ReadonlyArray<AnchorWrapInput>
}

export function Prose({
  body,
  taskId,
  plantumlEndpoint,
  plantumlAuthHeader,
  className,
  anchors,
}: ProseProps) {
  const components = useMemo<Components>(
    () =>
      ({
        pre: PassThroughPre,
        code: makeCode({ plantumlEndpoint, plantumlAuthHeader }),
        img: makeProseImage({ taskId }),
      }) as Components,
    [plantumlEndpoint, plantumlAuthHeader, taskId],
  )

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
          content: {
            type: 'element',
            tagName: 'span',
            properties: { className: ['prose__external-icon'], ariaHidden: 'true' },
            children: [],
          },
        },
      ],
    ]
    // RFC-051: only insert when anchors is non-empty so the byte-identical
    // contract for non-review callers (anchors omitted OR passed as []) is
    // preserved. The legacy DOM-mutation utility ran behind a `length === 0`
    // short-circuit too — empty anchors means "no high-light work to do".
    if (anchors !== undefined && anchors.length > 0) {
      base.push([rehypeWrapAnchors, { anchors }])
    }
    return base as unknown as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
  }, [anchors])

  const wrapperClass = 'prose' + (className !== undefined ? ' ' + className : '')

  return (
    <div className={wrapperClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlert, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}
