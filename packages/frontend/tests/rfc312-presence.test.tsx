// RFC-312 —— 前端 presence store 与渲染原语的行为锁。
//
// 锁的核心是**三态**：`undefined` 是"我不知道"，不是"离线"。
// 少了这一维就会在断线 / 无权限 / 快照未到时把所有人谎报成离线——
// 而那恰恰是用户最可能盯着屏幕看的时刻（daemon 重启、网络抖动）。

import { beforeEach, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'

import { PresenceDot } from '../src/components/PresenceDot'
import {
  applyPresenceChanges,
  applyPresenceSnapshot,
  resetPresence,
  usePresenceOf,
} from '../src/hooks/usePresence'

function Probe({ id }: { id: string | null }) {
  const online = usePresenceOf(id)
  return <span data-testid="probe">{online === undefined ? 'unknown' : String(online)}</span>
}

describe('rfc312 presence store', () => {
  beforeEach(() => {
    resetPresence()
  })

  test('未水化时一切查询都是 unknown（不是 offline）', () => {
    render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('unknown')
  })

  test('收到快照后：在名单里 = true，不在名单里 = false（确定的离线）', () => {
    applyPresenceSnapshot(['u1'])
    const { rerender } = render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('true')
    rerender(<Probe id="u2" />)
    expect(screen.getByTestId('probe').textContent).toBe('false')
  })

  test('快照到达前的增量被丢弃（不得用半截状态冒充真值）', () => {
    applyPresenceChanges([{ userId: 'u1', online: true }])
    render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('unknown')
  })

  test('增量在水化后正常生效（上线与下线两向）', () => {
    applyPresenceSnapshot([])
    const { rerender } = render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('false')

    applyPresenceChanges([{ userId: 'u1', online: true }])
    rerender(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('true')

    applyPresenceChanges([{ userId: 'u1', online: false }])
    rerender(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('false')
  })

  test('reset（断线 / 登出 / 失权）回到 unknown，而不是把所有人显示成离线', () => {
    applyPresenceSnapshot(['u1'])
    const { rerender } = render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('true')

    resetPresence()
    rerender(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('unknown')
  })

  test('非真实用户 id（历史行 / 系统行 / null）恒为 unknown', () => {
    applyPresenceSnapshot(['u1'])
    for (const id of ['local', '__system__', '', null]) {
      const { unmount } = render(<Probe id={id} />)
      expect(screen.getByTestId('probe').textContent).toBe('unknown')
      unmount()
    }
  })
})

describe('rfc312 PresenceDot', () => {
  test('undefined ⇒ 渲染 null（无权限用户看到的界面与今天一致）', () => {
    const { container } = render(<PresenceDot online={undefined} />)
    expect(container.querySelector('.presence-dot')).toBeNull()
  })

  test('在线 / 离线各有可访问名称，不靠颜色单独传达', () => {
    const { unmount } = render(<PresenceDot online={true} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBeTruthy()
    expect(screen.getByRole('img').className).toContain('presence-dot--online')
    unmount()

    render(<PresenceDot online={false} />)
    expect(screen.getByRole('img').className).toContain('presence-dot--offline')
  })
})
