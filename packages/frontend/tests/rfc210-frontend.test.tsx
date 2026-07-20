// RFC-210 PR-8 — 前端三件：ShaRange 公共原语、settings git 分区的五处登记、
// 任务详情的子仓结果列表。
//
// 为什么这些测试存在：
//
//  1. **ShaRange**。短 sha 渲染此前散在三处、两种长度（tasks.detail 与
//     plugins.detail 用 slice(0,12)，McpInventoryPanel 用 slice(0,10)），而
//     「old → new」这种形态全仓没有先例。统一到 12 位并给箭头形态一个落点，
//     免得下一个需要它的功能再发明第四种写法。两端都可空——失败在提交前的子仓
//     没有 to，新增的子仓没有 from。
//
//  2. **settings 的登记点是五个不是一个**。SETTINGS_CONFIG_SCOPE_KEYS 同时是
//     「最小写入 allowlist」，漏登记的 key 在保存时被静默丢弃；而它又
//     `satisfies Record<keyof SETTINGS_CONFIG_SCOPE_IDS, …>`，所以 scope id
//     必须先存在。这里锁住四个纯数据登记点（第五个在 settings.tsx，由 typecheck
//     的穷尽 switch 兜住）。
//
//  3. **SubmoduleBadge 的第四态**。`lastSubmoduleSyncOk === null`（有子仓但从未
//     同步过）此前落进绿色 ok chip，宣称了一次从未发生的成功。

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShaRange, shortSha, SHORT_SHA_LEN } from '../src/components/ShaRange'
import { SubmoduleBadge } from '../src/components/repos/SubmoduleBadge'
import { SETTINGS_CONFIG_SCOPE_IDS, SETTINGS_CONFIG_SCOPE_KEYS } from '../src/lib/settings-drafts'
import '../src/i18n'

describe('RFC-210 <ShaRange>', () => {
  it('truncates both ends to the shared length', () => {
    const from = 'a'.repeat(40)
    const to = 'b'.repeat(40)
    render(<ShaRange from={from} to={to} data-testid="r" />)
    const el = screen.getByTestId('r')
    expect(el.textContent).toContain('a'.repeat(SHORT_SHA_LEN))
    expect(el.textContent).toContain('b'.repeat(SHORT_SHA_LEN))
    // Not the full sha — that is the whole point of the component.
    expect(el.textContent).not.toContain('a'.repeat(SHORT_SHA_LEN + 1))
  })

  it('keeps the full sha reachable via title so it can be copied', () => {
    const from = 'c'.repeat(40)
    render(<ShaRange from={from} to={null} data-testid="r" />)
    const codes = screen.getByTestId('r').querySelectorAll('code')
    expect(codes[0]?.getAttribute('title')).toBe(from)
  })

  it('renders an em dash for a missing endpoint rather than an empty gap', () => {
    render(<ShaRange from={null} to={'d'.repeat(40)} data-testid="r" />)
    expect(screen.getByTestId('r').textContent).toContain('—')
  })

  it('hides the arrow from assistive tech and labels the pair instead', () => {
    render(<ShaRange from={'e'.repeat(40)} to={'f'.repeat(40)} data-testid="r" />)
    const el = screen.getByTestId('r')
    expect(el.querySelector('[aria-hidden="true"]')?.textContent).toContain('→')
    expect(el.querySelector('.sr-only')?.textContent).toBeTruthy()
  })

  it('shortSha handles null / empty without throwing', () => {
    expect(shortSha(null)).toBeNull()
    expect(shortSha(undefined)).toBeNull()
    expect(shortSha('')).toBeNull()
  })
})

describe('RFC-210 settings git scope registration', () => {
  it('declares a git scope id', () => {
    expect(SETTINGS_CONFIG_SCOPE_IDS.git).toBe('settings.git')
  })

  it('owns exactly the four submodule-related config keys', () => {
    // This list IS the minimal-write allowlist — a key missing here is silently
    // dropped when the section saves.
    expect([...SETTINGS_CONFIG_SCOPE_KEYS.git].sort()).toEqual([
      'gitRecurseSubmodules',
      'gitSubmoduleJobs',
      'gitSubmoduleRemote',
      'submoduleAutoRefresh',
    ])
  })

  it('does not poach keys owned by another section', () => {
    const others = Object.entries(SETTINGS_CONFIG_SCOPE_KEYS)
      .filter(([k]) => k !== 'git')
      .flatMap(([, v]) => v as readonly string[])
    for (const key of SETTINGS_CONFIG_SCOPE_KEYS.git) {
      expect(others).not.toContain(key)
    }
  })
})

describe('RFC-210 <SubmoduleBadge> fourth state', () => {
  it('has submodules but never synced ⟹ neutral, not a green success claim', () => {
    render(
      <SubmoduleBadge hasSubmodules lastSubmoduleSyncOk={null} lastSubmoduleSyncError={null} />,
    )
    const chip = screen.getByText(/submodule/i)
    expect(chip.className).toContain('status-chip--neutral')
    expect(chip.className).not.toContain('status-chip--success')
  })

  it('is folded into StatusChip — no private badge CLASS survives', () => {
    render(<SubmoduleBadge hasSubmodules lastSubmoduleSyncOk lastSubmoduleSyncError={null} />)
    const chip = screen.getByTestId('submodule-badge-ok')
    // The testid is deliberately kept (existing unit tests and e2e select on it);
    // what had to go is the private `.submodule-badge` CSS family.
    expect(chip.className).not.toContain('submodule-badge')
    expect(chip.className).toContain('status-chip')
  })
})
