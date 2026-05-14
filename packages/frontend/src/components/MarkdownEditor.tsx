// Side-by-side markdown editor for agent body / SKILL.md.
//
// M1 keeps it dependency-free: a textarea + a minimal renderer that handles
// the headings, fenced code blocks, inline code, bold/italic, and bullet
// lists most users write inside agent prompts. Real CommonMark + GFM is a
// P-5-XX polish item.

import { useMemo } from 'react'
import { TextArea } from './Form'

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}

export function MarkdownEditor({ value, onChange, rows = 18, placeholder }: MarkdownEditorProps) {
  const html = useMemo(() => renderMarkdown(value), [value])
  return (
    <div className="md-editor">
      <div className="md-editor__pane md-editor__pane--edit">
        <div className="md-editor__label">Edit</div>
        <TextArea
          value={value}
          onChange={onChange}
          rows={rows}
          placeholder={placeholder}
          monospace
        />
      </div>
      <div className="md-editor__pane md-editor__pane--preview">
        <div className="md-editor__label">Preview</div>
        <div className="md-editor__preview" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  )
}

// --- minimal markdown renderer ---

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c)
}

function inline(s: string): string {
  // order matters: handle code spans first to skip formatting inside them
  const parts: string[] = []
  let last = 0
  const codeRe = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = codeRe.exec(s)) !== null) {
    parts.push(formatBoldItalic(escape(s.slice(last, m.index))))
    parts.push(`<code>${escape(m[1] ?? '')}</code>`)
    last = m.index + m[0].length
  }
  parts.push(formatBoldItalic(escape(s.slice(last))))
  return parts.join('')
}

function formatBoldItalic(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function renderMarkdown(src: string): string {
  if (src.trim() === '') {
    return '<p class="md-preview__empty">Nothing to preview yet.</p>'
  }
  const lines = src.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceBuf: string[] = []
  let listBuf: string[] = []
  let paraBuf: string[] = []

  function flushPara() {
    if (paraBuf.length === 0) return
    out.push(`<p>${paraBuf.map(inline).join('<br/>')}</p>`)
    paraBuf = []
  }
  function flushList() {
    if (listBuf.length === 0) return
    out.push(`<ul>${listBuf.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`)
    listBuf = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (inFence) {
      if (line.startsWith('```')) {
        out.push(`<pre><code>${escape(fenceBuf.join('\n'))}</code></pre>`)
        fenceBuf = []
        inFence = false
      } else {
        fenceBuf.push(line)
      }
      continue
    }
    if (line.startsWith('```')) {
      flushPara()
      flushList()
      inFence = true
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h !== null) {
      flushPara()
      flushList()
      const level = (h[1] ?? '#').length
      out.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`)
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      flushPara()
      listBuf.push(bullet[1] ?? '')
      continue
    }
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    flushList()
    paraBuf.push(line)
  }
  if (inFence) {
    out.push(`<pre><code>${escape(fenceBuf.join('\n'))}</code></pre>`)
  }
  flushPara()
  flushList()
  return out.join('\n')
}

export { renderMarkdown as __testRenderMarkdown }
