// Sanity-check the minimal markdown renderer used by MarkdownEditor.

import { describe, expect, test } from 'vitest'
import { __testRenderMarkdown as render } from '../src/components/MarkdownEditor'

describe('renderMarkdown', () => {
  test('blank input → empty placeholder', () => {
    expect(render('')).toContain('Nothing to preview yet')
  })

  test('headings 1–6', () => {
    expect(render('# H1')).toContain('<h1>H1</h1>')
    expect(render('### H3')).toContain('<h3>H3</h3>')
    expect(render('###### H6')).toContain('<h6>H6</h6>')
  })

  test('paragraphs split on blank lines', () => {
    const html = render('one\n\ntwo')
    expect(html).toMatch(/<p>one<\/p>\s*<p>two<\/p>/)
  })

  test('bullets become <ul><li>', () => {
    const html = render('- a\n- b\n')
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>')
  })

  test('fenced code block preserves content + escapes html', () => {
    const html = render('```\n<script>alert(1)</script>\n```')
    expect(html).toContain('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>')
  })

  test('inline code + bold + italic', () => {
    const html = render('use `npm test` and **bold** and *italic*')
    expect(html).toContain('<code>npm test</code>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  test('escapes html outside code', () => {
    const html = render('beware <img onerror>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img onerror&gt;')
  })

  test('headings flush pending paragraph', () => {
    const html = render('intro\n# section')
    expect(html).toContain('<p>intro</p>')
    expect(html).toContain('<h1>section</h1>')
  })
})
