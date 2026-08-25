// RFC-008 T1 — fenced-code overrides for react-markdown.
//
// react-markdown 10 calls our overrides synchronously and the underlying
// processor is `processSync` — so async rehype plugins (rehype-pretty-code
// with shiki's Promise<Highlighter>) can't slot in. Instead we render the
// fence as a React component that lazy-loads shiki on mount and replaces
// its own innerHTML with the highlighted output once ready. Mermaid /
// PlantUML reuse the existing static helpers via thin React wrappers.
//
// Wiring:
//   - `components.pre` collapses to a fragment so the inner CodeBlock owns
//     the <pre> wrapper. Without this we'd get a stray browser <pre> around
//     each shiki <pre class="shiki ...">.
//   - `components.code` dispatches on `className=language-X`:
//       lang === ''        → inline <code>
//       lang === mermaid   → MermaidDiagram React shell
//       lang === plantuml  → PlantUmlDiagram React shell
//       supported lang     → ShikiPre (lazy shiki)
//       unsupported lang   → plain <pre><code> fallback
import type { ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { MermaidBlock } from '../review/MermaidBlock'
import { PlantUmlBlock } from '../review/PlantUmlBlock'
import { getHighlighter } from './highlighter'
import type { CodeAnchorRange } from './rehypeWrapAnchors'
import { useResolvedTheme } from '@/hooks/useTheme'

// -----------------------------------------------------------------------------
// RFC-326 D5 / P15 — review comment anchors inside fenced code.
//
// `rehypeWrapAnchors` cannot wrap text inside a fence (shiki replaces the
// whole block's innerHTML after mount), so it hands the code element the
// ranges as `data-anchor-ranges` (JSON, relative to the code text) and this
// file renders them: shiki `decorations` for the highlighted output, `<mark>`
// slices for the plain fallback. Shiki refuses CROSSING decorations
// (`intersect` in @shikijs/core), so ranges are first cut into non-crossing
// atomic segments; a segment covered by several comments carries the
// earliest-starting one as `data-comment-id` and every id in
// `data-comment-ids` (the sidebar / scroll-spy look marks up by the former).
// -----------------------------------------------------------------------------

export interface CodeAnchorSegment {
  start: number
  end: number
  commentId: string
  commentIds: string[]
}

/** Cut possibly overlapping ranges into non-crossing segments (containment allowed to nest → flattened). */
export function atomicAnchorSegments(
  ranges: ReadonlyArray<CodeAnchorRange>,
  length: number,
): CodeAnchorSegment[] {
  const clipped = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(length, r.start)),
      end: Math.max(0, Math.min(length, r.end)),
      commentId: r.commentId,
    }))
    .filter((r) => r.end > r.start)
  if (clipped.length === 0) return []
  const bounds = [...new Set(clipped.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b)
  const out: CodeAnchorSegment[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i]!
    const end = bounds[i + 1]!
    const covering = clipped.filter((r) => r.start <= start && r.end >= end)
    if (covering.length === 0) continue
    const earliest = covering.reduce((best, r) => (r.start < best.start ? r : best), covering[0]!)
    const ids = covering.map((r) => r.commentId)
    const prev = out[out.length - 1]
    if (
      prev !== undefined &&
      prev.end === start &&
      prev.commentId === earliest.commentId &&
      prev.commentIds.join('\u0000') === ids.join('\u0000')
    ) {
      prev.end = end
      continue
    }
    out.push({ start, end, commentId: earliest.commentId, commentIds: ids })
  }
  return out
}

function parseAnchorRanges(raw: unknown): CodeAnchorRange[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is CodeAnchorRange =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as CodeAnchorRange).start === 'number' &&
        typeof (r as CodeAnchorRange).end === 'number' &&
        typeof (r as CodeAnchorRange).commentId === 'string',
    )
  } catch {
    return []
  }
}

/** Plain-text rendering of `source` with `<mark>`s over the atomic segments. */
function markedSlices(source: string, segments: ReadonlyArray<CodeAnchorSegment>): ReactNode[] {
  const out: ReactNode[] = []
  let cursor = 0
  for (const seg of segments) {
    if (seg.start > cursor) out.push(source.slice(cursor, seg.start))
    out.push(
      <mark
        key={`${seg.start}-${seg.end}`}
        className="comment-anchor"
        data-comment-id={seg.commentId}
        data-comment-ids={seg.commentIds.join(' ')}
      >
        {source.slice(seg.start, seg.end)}
      </mark>,
    )
    cursor = seg.end
  }
  if (cursor < source.length) out.push(source.slice(cursor))
  return out
}

export function PassThroughPre({ children }: { children?: ReactNode }) {
  // Strip react-markdown's wrapping <pre> — fenced-code overrides own their
  // <pre> output. Inline code never lands here (no <pre> parent), so this
  // is safe.
  return <Fragment>{children}</Fragment>
}

// RFC-105 WP-B — PlantUML now renders via the backend proxy, so no endpoint /
// auth header is threaded through Prose any more (the server holds them).
export function makeCode() {
  return function Code({
    className,
    children,
    ...rest
  }: {
    className?: string
    children?: ReactNode
  } & Record<string, unknown>) {
    const lang = extractLang(className)
    if (lang === '') {
      // Inline `code` or fenced block with no language — render as plain
      // <code>. For the language-less fence case PassThroughPre stripped
      // the outer <pre>, so we need to put it back here.
      // Heuristic: if children contains a newline, it's a block.
      const text = childrenToString(children)
      if (text.includes('\n')) {
        // RFC-326:无语言围栏块**也**要带锚 mark。此前这里在读 data-anchor-ranges
        // 之前就 return 了,于是 ```（无 info string）里的代码锚被静默丢掉——
        // 高亮不亮、气泡掉 orphan,而 rehype 那边照常算出了区间。
        const source = text.replace(/\n$/, '')
        const ranges = parseAnchorRanges(rest['data-anchor-ranges'])
        const segments = atomicAnchorSegments(ranges, source.length)
        return (
          <pre className="prose__code-fallback" data-prose-code-fallback="plain">
            <code>{segments.length > 0 ? markedSlices(source, segments) : text}</code>
          </pre>
        )
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    }
    const source = childrenToString(children).replace(/\n$/, '')
    // Diagrams are never highlighted (design §9.4) — the ranges are dropped.
    if (lang === 'mermaid') return <MermaidDiagram source={source} />
    if (lang === 'plantuml') return <PlantUmlDiagram source={source} />
    const ranges = parseAnchorRanges(rest['data-anchor-ranges'])
    return <ShikiPre source={source} lang={lang} ranges={ranges} />
  }
}

function extractLang(className: string | undefined): string {
  if (className === undefined) return ''
  const m = /(?:^|\s)language-([^\s]+)/.exec(className)
  return m === null ? '' : (m[1] ?? '').toLowerCase()
}

function childrenToString(c: ReactNode): string {
  if (typeof c === 'string') return c
  if (typeof c === 'number') return String(c)
  if (Array.isArray(c)) return c.map(childrenToString).join('')
  if (c !== null && typeof c === 'object' && 'props' in c) {
    const props = (c as { props: { children?: ReactNode } }).props
    return childrenToString(props.children)
  }
  return ''
}

// ---- mermaid / plantuml React shells around the imperative static helpers ----

function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()
  useEffect(() => {
    if (ref.current === null) return
    const mount = ref.current
    void MermaidBlock.render(mount, source, theme)
    return () => {
      mount.innerHTML = ''
    }
  }, [source, theme])
  return (
    <div
      ref={ref}
      className="prose__diagram prose__diagram--mermaid"
      data-prose-diagram="mermaid"
      data-prose-diagram-theme={theme}
    />
  )
}

function PlantUmlDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current === null) return
    const mount = ref.current
    PlantUmlBlock.renderViaProxy(mount, source)
    return () => {
      mount.innerHTML = ''
    }
  }, [source])
  return (
    <div
      ref={ref}
      className="prose__diagram prose__diagram--plantuml"
      data-prose-diagram="plantuml"
    />
  )
}

// ---- shiki block: lazy-load + post-mount innerHTML swap ----

interface ShikiPreProps {
  source: string
  lang: string
  /** RFC-326: review anchors inside this block, relative to `source` (already `\n`-trimmed). */
  ranges?: ReadonlyArray<CodeAnchorRange>
}

const SUPPORTED_LANGS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'md',
  'yaml',
  'sql',
  'python',
  'diff',
])

function normalizeLang(lang: string): string {
  if (lang === 'typescript') return 'ts'
  if (lang === 'javascript') return 'js'
  if (lang === 'shell' || lang === 'zsh') return 'bash'
  if (lang === 'markdown') return 'md'
  if (lang === 'yml') return 'yaml'
  if (lang === 'py') return 'python'
  return lang
}

function ShikiPre({ source, lang, ranges }: ShikiPreProps) {
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const normalized = normalizeLang(lang)
  const supported = normalized.length > 0 && SUPPORTED_LANGS.has(normalized)
  // Stable identity for the effect: the same ranges must not re-run shiki.
  const segmentsKey = JSON.stringify(ranges ?? [])
  const segments = useMemo(
    () => atomicAnchorSegments(ranges ?? [], source.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the serialised ranges
    [segmentsKey, source],
  )

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      try {
        const hl = await getHighlighter()
        if (cancelled) return
        const html = hl.codeToHtml(source, {
          lang: normalized,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false,
          ...(segments.length > 0
            ? {
                decorations: segments.map((seg) => ({
                  start: seg.start,
                  end: seg.end,
                  tagName: 'mark',
                  properties: {
                    class: 'comment-anchor',
                    'data-comment-id': seg.commentId,
                    'data-comment-ids': seg.commentIds.join(' '),
                  },
                })),
              }
            : {}),
        })
        if (!cancelled) setHighlighted(html)
      } catch {
        // Stay in fallback (plain <pre><code>) — better than blank.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, normalized, supported, segments])

  if (supported && highlighted !== null) {
    return (
      <div
        className="prose__code"
        data-prose-code={normalized}
        // shiki output is a self-contained <pre class="shiki ..."><code>...</code></pre>
        // — already escapes user content; safe to inject as HTML.
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    )
  }
  return (
    <pre
      className="prose__code-fallback"
      data-prose-code-fallback={supported ? normalized : normalized || 'plain'}
    >
      <code className={normalized.length > 0 ? `language-${normalized}` : undefined}>
        {segments.length > 0 ? markedSlices(source, segments) : source}
      </code>
    </pre>
  )
}
