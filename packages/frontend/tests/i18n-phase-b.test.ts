// P-5-03 stage 2 Phase B: smoke-test editor / launch / inspector / promptPreview
// bundles + buildPalette translator wiring.

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'
import { buildPalette } from '@/components/canvas/nodePalette'

describe('Phase B bundles', () => {
  test('editor core keys are reachable in both locales', () => {
    setLanguage('zh-CN')
    expect(i18n.t('editor.launch')).toBe('启动任务 →')
    expect(i18n.t('editor.exportYaml')).toBe('导出 YAML')
    setLanguage('en-US')
    expect(i18n.t('editor.launch')).toBe('Launch task →')
    expect(i18n.t('editor.exportYaml')).toBe('Export YAML')
    setLanguage('zh-CN')
  })

  test('launch title interpolates {{name}}', () => {
    setLanguage('en-US')
    expect(i18n.t('launch.title', { name: 'my-workflow' })).toBe('Launch: my-workflow')
    setLanguage('zh-CN')
    expect(i18n.t('launch.title', { name: 'my-workflow' })).toBe('启动：my-workflow')
  })

  test('editor remote-updated interpolates {{version}}', () => {
    setLanguage('en-US')
    expect(i18n.t('editor.remoteUpdated', { version: 7 })).toContain('v7')
  })

  test('inspector prompt-template hint preserves literal {{port_name}}', () => {
    // i18next skipOnVariables default leaves unresolved {{var}} literal —
    // important so the hint can mention the template syntax the user types.
    setLanguage('en-US')
    const hint = i18n.t('inspector.fieldPromptTemplateHint')
    expect(hint).toContain('{{port_name}}')
    expect(hint).toContain('{{__repo_path__}}')
    setLanguage('zh-CN')
    const zh = i18n.t('inspector.fieldPromptTemplateHint')
    expect(zh).toContain('{{port_name}}')
    expect(zh).toContain('{{__repo_path__}}')
  })

  test('inspector loop banner is present in both locales', () => {
    setLanguage('en-US')
    expect(i18n.t('inspector.loopBanner').length).toBeGreaterThan(0)
    setLanguage('zh-CN')
    expect(i18n.t('inspector.loopBanner').length).toBeGreaterThan(0)
  })

  test('promptPreview titles are reachable', () => {
    setLanguage('en-US')
    expect(i18n.t('promptPreview.mockTitle')).toBe('Mock port values')
    expect(i18n.t('promptPreview.assembledTitle')).toBe('Assembled prompt')
  })
})

describe('buildPalette with real i18n', () => {
  test('section labels resolve through react-i18next translator', () => {
    setLanguage('en-US')
    const t = i18n.t.bind(i18n)
    const sections = buildPalette([], t)
    expect(sections.map((s) => s.label)).toEqual(['Agents', 'Fan-out', 'Wrappers', 'IO'])
    // Built-in wrapper + IO labels come through too.
    const ioItems = sections[3]?.items.map((i) => i.label) ?? []
    expect(ioItems).toContain('input')
    expect(ioItems).toContain('output')
    setLanguage('zh-CN')
  })
})
