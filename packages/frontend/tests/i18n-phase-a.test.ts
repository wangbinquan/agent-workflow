// P-5-03 stage 2 Phase A: smoke-test the new agents / skills / workflows /
// tasks / common bundles.
//
// Goals here are narrow: catch missing keys (zh-CN / en-US drift).
// RFC-192: tasks.tsx's page-private `formatRelative` (and its
// tasks.secondsAgo/minutesAgo/hoursAgo keys) retired — the list renders the
// shared <RelativeTime> primitive, covered by relative-time.test.ts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'

describe('Phase A bundles', () => {
  test('zh-CN agents/skills/workflows/tasks core keys are populated', () => {
    setLanguage('zh-CN')
    expect(i18n.t('agents.title')).toBe('代理')
    expect(i18n.t('skills.title')).toBe('技能')
    expect(i18n.t('workflows.title')).toBe('工作流')
    expect(i18n.t('tasks.title')).toBe('任务')
    expect(i18n.t('common.delete')).toBe('删除')
  })

  test('en-US matches the same key tree', () => {
    setLanguage('en-US')
    expect(i18n.t('agents.newButton')).toBe('+ New agent')
    expect(i18n.t('workflows.importButton')).toBe('Import YAML')
    expect(i18n.t('tasks.cancelButton')).toBe('Cancel task')
    expect(i18n.t('skills.tabExternal')).toBe('External')
    setLanguage('zh-CN')
  })

  test('interpolated keys substitute the placeholder', () => {
    setLanguage('en-US')
    expect(i18n.t('tasks.jumpToFailed', { nodeId: 'coder' })).toBe('Jump to failed node (coder)')
    expect(i18n.t('tasks.worktreePreserved', { path: '/wt/abc' })).toContain('/wt/abc')
    setLanguage('zh-CN')
    expect(i18n.t('tasks.jumpToFailed', { nodeId: 'coder' })).toBe('跳到失败节点 (coder)')
  })
})

describe('formatRelative retirement (RFC-192)', () => {
  test('tasks.tsx no longer exports the page-private formatter (shared <RelativeTime> instead)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'),
      'utf-8',
    )
    expect(src).not.toContain('function formatRelative')
    expect(src).toContain("import { RelativeTime } from '@/components/RelativeTime'")
  })
})
