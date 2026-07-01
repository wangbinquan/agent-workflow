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
    setLanguage('zh-CN')
    expect(i18n.t('agentForm.fieldName')).toBe('名称')
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
    // tokenMask was removed with the Settings "Connection" tab; runtimeStatusBinary
    // keeps this test's settingsForm interpolation coverage on a live key.
    expect(i18n.t('settingsForm.runtimeStatusBinary', { path: '/opt/opencode' })).toBe(
      'Binary: /opt/opencode',
    )
    setLanguage('zh-CN')
    expect(i18n.t('settingsForm.runtimeStatusBinary', { path: '/opt/opencode' })).toBe(
      '二进制：/opt/opencode',
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

  // Locks in the 2026-05-24 i18n fix: wrapper-fanout previously fell through
  // to wrapperNode.labelGit because GroupWrapperNode's kind union only knew
  // 'git' / 'loop'; IO node chip labels were hardcoded English strings. Both
  // surfaces now need translation keys that resolve in both locales.
  test('wrapperNode.labelFanout + pillFanout reachable both locales', () => {
    setLanguage('en-US')
    expect(i18n.t('wrapperNode.labelFanout')).toBe('Fanout Wrapper')
    expect(i18n.t('wrapperNode.pillFanout')).toBe('fanout')
    setLanguage('zh-CN')
    expect(i18n.t('wrapperNode.labelFanout')).toBe('分片包装器')
    expect(i18n.t('wrapperNode.pillFanout')).toBe('分片')
  })

  test('ioNode.labelInput + labelOutput reachable both locales', () => {
    setLanguage('en-US')
    expect(i18n.t('ioNode.labelInput')).toBe('Input')
    expect(i18n.t('ioNode.labelOutput')).toBe('Output')
    setLanguage('zh-CN')
    expect(i18n.t('ioNode.labelInput')).toBe('输入')
    expect(i18n.t('ioNode.labelOutput')).toBe('输出')
  })

  // Locks in the 2026-05-24 follow-up fix: the editor sidebar palette
  // (`<EditorSidebar>`) is fed by `buildPalette(agents, t)`, and several of
  // its zh-CN entries still rendered English literals — paletteWrapperGitLabel
  // / paletteWrapperLoopLabel / paletteInputLabel / paletteOutputLabel were
  // verbatim "git wrapper" / "loop wrapper" / "input" / "output", and the
  // agent-description fallback collapsed to the English word "agent". Pin
  // the localized values so a future re-import / merge doesn't silently
  // revert them.
  test('sidebar palette zh-CN values are Chinese with leading kind-icon glyphs', () => {
    setLanguage('zh-CN')
    expect(i18n.t('editor.paletteWrapperGitLabel')).toBe('⎈ Git 包装器')
    expect(i18n.t('editor.paletteWrapperLoopLabel')).toBe('⟳ 循环包装器')
    expect(i18n.t('editor.paletteWrapperFanoutLabel')).toBe('⫶ 分片包装器')
    expect(i18n.t('editor.paletteInputLabel')).toBe('↳ 输入')
    expect(i18n.t('editor.paletteOutputLabel')).toBe('⤴ 输出')
    expect(i18n.t('editor.paletteReviewLabel')).toBe('⚖ 评审')
    expect(i18n.t('editor.paletteClarifyLabel')).toBe('⚡ 反问')
    expect(i18n.t('crossClarify.canvas.paletteLabel')).toBe('⚡ 跨代理反问')
    expect(i18n.t('editor.paletteAgentFallbackDesc')).toBe('代理节点')
  })

  test('sidebar palette en-US values carry icons and stay lowercase', () => {
    setLanguage('en-US')
    expect(i18n.t('editor.paletteWrapperGitLabel')).toBe('⎈ git wrapper')
    expect(i18n.t('editor.paletteWrapperLoopLabel')).toBe('⟳ loop wrapper')
    expect(i18n.t('editor.paletteWrapperFanoutLabel')).toBe('⫶ fanout wrapper')
    expect(i18n.t('editor.paletteInputLabel')).toBe('↳ input')
    expect(i18n.t('editor.paletteOutputLabel')).toBe('⤴ output')
    expect(i18n.t('editor.paletteReviewLabel')).toBe('⚖ review')
    expect(i18n.t('editor.paletteClarifyLabel')).toBe('⚡ clarify')
    expect(i18n.t('crossClarify.canvas.paletteLabel')).toBe('⚡ cross-clarify')
  })

  // Locks in the second follow-up: agent / review / clarify / cross-clarify
  // canvas chip labels now route through i18n instead of being hardcoded
  // English literals inside the renderer. AgentNode also picked up a
  // leading ⚙ icon so its chip lines up with every other kind chip.
  test('agentNode / reviewNode / clarifyNode / crossClarifyNode labels reachable both locales', () => {
    setLanguage('en-US')
    expect(i18n.t('agentNode.label')).toBe('agent')
    expect(i18n.t('reviewNode.label')).toBe('review')
    expect(i18n.t('clarifyNode.label')).toBe('clarify')
    expect(i18n.t('crossClarifyNode.label')).toBe('cross-clarify')
    setLanguage('zh-CN')
    expect(i18n.t('agentNode.label')).toBe('代理')
    expect(i18n.t('reviewNode.label')).toBe('评审')
    expect(i18n.t('clarifyNode.label')).toBe('反问')
    expect(i18n.t('crossClarifyNode.label')).toBe('跨代理反问')
  })
})
