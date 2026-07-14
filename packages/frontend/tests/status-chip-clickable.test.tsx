// RFC-182 D9 —— StatusChip optional onClick：缺省仍是 <span>（全仓既有调用
// 逐字节不变，源级回归锁），给了 onClick 才升级为真 <button>（键盘可达）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { StatusChip } from '../src/components/StatusChip'

describe('StatusChip clickable variant (RFC-182 D9)', () => {
  test('default renders a span (no button semantics)', () => {
    render(
      <StatusChip kind="info" data-testid="chip-a">
        x
      </StatusChip>,
    )
    expect(screen.getByTestId('chip-a').tagName).toBe('SPAN')
    cleanup()
  })

  test('onClick renders a keyboard-focusable button and fires', () => {
    let hits = 0
    render(
      <StatusChip
        kind="info"
        data-testid="chip-b"
        onClick={() => {
          hits += 1
        }}
      >
        x
      </StatusChip>,
    )
    const el = screen.getByTestId('chip-b')
    expect(el.tagName).toBe('BUTTON')
    expect(el.className).toContain('status-chip--clickable')
    fireEvent.click(el)
    expect(hits).toBe(1)
    cleanup()
  })
})
