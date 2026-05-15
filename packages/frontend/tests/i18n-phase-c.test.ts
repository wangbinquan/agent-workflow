// P-5-03 stage 2 Phase C: smoke-test components/* + settings bundles.
// Focus on key presence in both locales, interpolation correctness, and
// common section reuse (Copy / Copied! / (empty) / (optional) shared
// across NodeDetailDrawer, TaskOutputPanel, EnumPicker, AgentForm).

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'

describe('Phase C bundles', () => {
  test('agentForm core keys reachable both locales', () => {
    setLanguage('en-US')
    expect(i18n.t('agentForm.fieldName')).toBe('Name')
    expect(i18n.t('agentForm.fieldReadonlyHint')).toContain('serialize')
    setLanguage('zh-CN')
    expect(i18n.t('agentForm.fieldName')).toBe('名称')
    expect(i18n.t('agentForm.fieldReadonlyHint')).toContain('串行')
  })

  test('nodeDrawer stats column titles', () => {
    setLanguage('en-US')
    expect(i18n.t('nodeDrawer.statTokensTotal')).toBe('Tokens total')
    expect(i18n.t('nodeDrawer.tabPrompt')).toBe('Prompt')
    expect(i18n.t('nodeDrawer.tabStats')).toBe('Stats')
    setLanguage('zh-CN')
    expect(i18n.t('nodeDrawer.statTokensTotal')).toBe('总 tokens')
  })

  test('nodeDrawer interpolations', () => {
    setLanguage('en-US')
    expect(i18n.t('nodeDrawer.shardCount', { n: 3 })).toBe('3 shard(s)')
    expect(i18n.t('nodeDrawer.attempt', { n: 2 })).toBe('attempt 2')
    setLanguage('zh-CN')
    expect(i18n.t('nodeDrawer.shardCount', { n: 3 })).toBe('3 个 shard')
    expect(i18n.t('nodeDrawer.attempt', { n: 2 })).toBe('第 2 次')
  })

  test('settings form labels reachable', () => {
    setLanguage('en-US')
    expect(i18n.t('settingsForm.bindHost')).toBe('Bind host')
    expect(i18n.t('settingsForm.archiveGlobal')).toContain('global')
    expect(i18n.t('settingsForm.tokenMask', { prefix: 'abcd', suffix: 'wxyz', len: 64 })).toBe(
      'abcd…wxyz (64 chars)',
    )
    setLanguage('zh-CN')
    expect(i18n.t('settingsForm.tokenMask', { prefix: 'abcd', suffix: 'wxyz', len: 64 })).toBe(
      'abcd…wxyz（共 64 字符）',
    )
  })

  test('common section shared bits', () => {
    setLanguage('en-US')
    expect(i18n.t('common.copy')).toBe('Copy')
    expect(i18n.t('common.copied')).toBe('Copied!')
    expect(i18n.t('common.empty')).toBe('(empty)')
    expect(i18n.t('common.optionalPlaceholder')).toBe('(optional)')
    expect(i18n.t('common.confirmPrompt')).toBe('Confirm?')
  })

  test('wrapperNode + enumPicker keys', () => {
    setLanguage('en-US')
    expect(i18n.t('wrapperNode.innerNodes', { n: 0 })).toBe('0 inner node(s)')
    expect(i18n.t('enumPicker.add')).toBe('Add')
    setLanguage('zh-CN')
    expect(i18n.t('wrapperNode.innerNodes', { n: 5 })).toBe('5 个内部节点')
    expect(i18n.t('enumPicker.add')).toBe('添加')
  })
})
