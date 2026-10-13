import { describe, expect, test } from 'vitest'
import {
  MARKDOWN_SPLIT_MIN_WIDTH,
  markdownEditorLayout,
  parseMarkdownLayout,
  parseSavedMarkdownLayout,
} from '@/lib/markdown-editor-layout'

describe('Markdown layout preferences and available space', () => {
  test('unmeasured / hidden panels do not force a narrow layout', () => {
    expect(markdownEditorLayout(parseMarkdownLayout(null), 0).mode).toBe('split')
  })

  test('the exact two-pane threshold fits 320px on each side', () => {
    const preference = { ...parseMarkdownLayout(null), ratio: 0.8 }
    const atLimit = markdownEditorLayout(preference, MARKDOWN_SPLIT_MIN_WIDTH)
    expect(atLimit.mode).toBe('split')
    expect(atLimit.available * atLimit.ratio).toBe(320)
    expect(atLimit.available * (1 - atLimit.ratio)).toBe(320)
    expect(markdownEditorLayout(preference, MARKDOWN_SPLIT_MIN_WIDTH - 1).mode).toBe('edit')
  })

  test('narrowing temporarily clamps the split without replacing the desktop preference', () => {
    const preference = { ...parseMarkdownLayout(null), ratio: 0.7 }
    const narrow = markdownEditorLayout(preference, 720)
    expect(narrow.available * (1 - narrow.ratio)).toBeCloseTo(320)
    expect(markdownEditorLayout(preference, 1200).ratio).toBe(0.7)
    expect(preference.ratio).toBe(0.7)
  })

  test('compact uses the last pane; an explicit single-pane choice survives widening', () => {
    const preference = { ...parseMarkdownLayout(null), singlePane: 'preview' as const }
    expect(markdownEditorLayout(preference, 320).mode).toBe('preview')
    expect(markdownEditorLayout(preference, 1000).mode).toBe('split')
    expect(markdownEditorLayout({ ...preference, mode: 'preview' }, 1000).mode).toBe('preview')
  })

  test('read-only defaults to preview on a phone while valid saved choices take precedence', () => {
    expect(markdownEditorLayout(parseMarkdownLayout(null, true), 390).mode).toBe('preview')
    const saved = { version: 1, mode: 'edit', ratio: 0.6, singlePane: 'edit' }
    expect(parseMarkdownLayout(JSON.stringify(saved), true)).toEqual(saved)
  })

  test.each([
    '',
    'broken',
    'null',
    '[]',
    '{"version":2,"mode":"split","ratio":0.5,"singlePane":"edit"}',
    '{"version":1,"mode":"hidden","ratio":0.5,"singlePane":"edit"}',
    '{"version":1,"mode":"split","ratio":0.5,"singlePane":"split"}',
    '{"version":1,"mode":"split","ratio":-0.1,"singlePane":"edit"}',
    '{"version":1,"mode":"split","ratio":1.1,"singlePane":"edit"}',
    '{"version":1,"mode":"split","ratio":1e309,"singlePane":"edit"}',
    '{"version":1,"mode":"split","ratio":"0.5","singlePane":"edit"}',
  ])('invalid storage has a complete usable fallback: %s', (raw) => {
    expect(parseSavedMarkdownLayout(raw)).toBeNull()
    expect(parseMarkdownLayout(raw)).toEqual(parseMarkdownLayout(null))
  })
})
