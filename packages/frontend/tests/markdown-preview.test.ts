// RFC-105 — pure-function contract for the Markdown preview wiring.
// Locks isMarkdownPath / isMarkdownPreviewable / validatePreviewSearch /
// resolvePreviewSource / buildPreviewTarget so a refactor that changes the
// button gate or the route search shape fails here, not in the UI.

import { describe, expect, test } from 'vitest'
import {
  buildPreviewTarget,
  isMarkdownPath,
  isMarkdownPreviewable,
  resolvePreviewSource,
  validatePreviewSearch,
} from '../src/lib/markdown-preview'

describe('isMarkdownPath', () => {
  test('matches .md / .markdown case-insensitively', () => {
    expect(isMarkdownPath('a.md')).toBe(true)
    expect(isMarkdownPath('A.MD')).toBe(true)
    expect(isMarkdownPath('docs/report.md')).toBe(true)
    expect(isMarkdownPath('x.markdown')).toBe(true)
    expect(isMarkdownPath('  spaced.md  ')).toBe(true)
  })
  test('rejects non-markdown / malformed', () => {
    expect(isMarkdownPath('a.md.txt')).toBe(false)
    expect(isMarkdownPath('a.mdx')).toBe(false)
    expect(isMarkdownPath('readme')).toBe(false)
    expect(isMarkdownPath('a.png')).toBe(false)
    expect(isMarkdownPath('multi\nline.md')).toBe(false)
    expect(isMarkdownPath('')).toBe(false)
  })
})

describe('isMarkdownPreviewable', () => {
  test('markdown_file / path<md> value ending .md → true', () => {
    expect(isMarkdownPreviewable('markdown_file', 'out/report.md')).toBe(true)
    expect(isMarkdownPreviewable('path<md>', 'docs/a.md')).toBe(true)
  })
  test('path<*> with .md value → true; with .png value → false', () => {
    expect(isMarkdownPreviewable('path<*>', 'a.md')).toBe(true)
    expect(isMarkdownPreviewable('path<*>', 'a.png')).toBe(false)
  })
  test('inline markdown kind with non-empty value → true', () => {
    expect(isMarkdownPreviewable('markdown', '# Title\n\nbody')).toBe(true)
  })
  test('non-previewable kinds / values → false', () => {
    expect(isMarkdownPreviewable('string', 'plain text')).toBe(false)
    expect(isMarkdownPreviewable('signal', 'done')).toBe(false)
    expect(isMarkdownPreviewable('list<markdown>', '# a\n# b')).toBe(false)
    expect(isMarkdownPreviewable('markdown', '')).toBe(false)
    expect(isMarkdownPreviewable('markdown', '   ')).toBe(false)
    expect(isMarkdownPreviewable('markdown_file', null)).toBe(false)
    expect(isMarkdownPreviewable(null, 'x')).toBe(false)
    expect(isMarkdownPreviewable(undefined, 'x')).toBe(false)
    // file kind but multi-line value is never a usable path
    expect(isMarkdownPreviewable('markdown_file', 'a.md\nb.md')).toBe(false)
  })
})

describe('validatePreviewSearch', () => {
  test('keeps non-empty string fields, drops empties / non-strings', () => {
    expect(validatePreviewSearch({ path: 'a.md' })).toEqual({ path: 'a.md' })
    expect(validatePreviewSearch({ runId: 'r1', port: 'doc', title: 'Report' })).toEqual({
      runId: 'r1',
      port: 'doc',
      title: 'Report',
    })
    expect(validatePreviewSearch({ path: '', runId: 5, port: null })).toEqual({})
    expect(validatePreviewSearch({})).toEqual({})
  })
})

describe('resolvePreviewSource', () => {
  test('all three params → artifact mode (RFC-193; was "path wins" pre-archive)', () => {
    // RFC-105 的 builder 从不同时序列化三参，"path wins" 只是防御顺序；RFC-193
    // 起三参齐是 ARTIFACT 源的正式形态（emit-time 归档优先，404 回退 file）。
    expect(resolvePreviewSource({ path: 'a.md', runId: 'r', port: 'p' })).toEqual({
      mode: 'artifact',
      path: 'a.md',
      runId: 'r',
      port: 'p',
    })
  })
  test('runId+port → port mode', () => {
    expect(resolvePreviewSource({ runId: 'r1', port: 'doc' })).toEqual({
      mode: 'port',
      runId: 'r1',
      port: 'doc',
    })
  })
  test('missing / partial → invalid', () => {
    expect(resolvePreviewSource({}).mode).toBe('invalid')
    expect(resolvePreviewSource({ runId: 'r1' }).mode).toBe('invalid')
    expect(resolvePreviewSource({ port: 'doc' }).mode).toBe('invalid')
  })
})

describe('buildPreviewTarget', () => {
  test('file source → ?path=', () => {
    expect(buildPreviewTarget('task1', { kind: 'file', path: 'docs/a.md' })).toEqual({
      to: '/tasks/$id/preview',
      params: { id: 'task1' },
      search: { path: 'docs/a.md' },
    })
  })
  test('port source → ?runId=&port=', () => {
    expect(
      buildPreviewTarget('task1', { kind: 'port', runId: 'r1', port: 'doc' }, 'Report'),
    ).toEqual({
      to: '/tasks/$id/preview',
      params: { id: 'task1' },
      search: { runId: 'r1', port: 'doc', title: 'Report' },
    })
  })
  test('empty title is dropped', () => {
    expect(buildPreviewTarget('t', { kind: 'file', path: 'a.md' }, '').search).toEqual({
      path: 'a.md',
    })
  })
})
