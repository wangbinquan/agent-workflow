// RFC-124 — Card primitive contract.
//
// Locks the reusable shell the task board (and future surfaces) depend on:
//   - default render = .card + .card__body only (no empty header/footer divs)
//   - header / footer slots render when provided
//   - null / false slots are treated as absent so the common `header={cond && node}`
//     pattern never leaves an empty wrapper (Codex P3 fold, design §1)
//   - interactive / highlighted / className modifiers + data-testid passthrough
//   - body child DOM order is preserved (the board relies on title→answer→meta order)

import { render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { Card } from '../src/components/Card'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Card primitive', () => {
  test('default render is .card + .card__body only (no header/footer)', () => {
    const { container } = render(<Card>body</Card>)
    expect(container.querySelector('.card')).toBeTruthy()
    expect(container.querySelector('.card__body')?.textContent).toBe('body')
    expect(container.querySelector('.card__header')).toBeNull()
    expect(container.querySelector('.card__footer')).toBeNull()
  })

  test('renders header + footer slots when provided', () => {
    const { container } = render(
      <Card header={<span>H</span>} footer={<span>F</span>}>
        body
      </Card>,
    )
    expect(container.querySelector('.card__header')?.textContent).toBe('H')
    expect(container.querySelector('.card__footer')?.textContent).toBe('F')
  })

  test('treats null / false slots as absent (cond && node pattern — Codex P3)', () => {
    const cond = false
    const { container } = render(
      <Card header={cond && <span>H</span>} footer={null}>
        body
      </Card>,
    )
    expect(container.querySelector('.card__header')).toBeNull()
    expect(container.querySelector('.card__footer')).toBeNull()
  })

  test('applies interactive / highlighted / className modifiers + data-testid', () => {
    const { container } = render(
      <Card interactive highlighted className="extra" data-testid="my-card">
        body
      </Card>,
    )
    const card = container.querySelector('.card') as HTMLElement
    expect(card.classList.contains('card--interactive')).toBe(true)
    expect(card.classList.contains('card--highlighted')).toBe(true)
    expect(card.classList.contains('extra')).toBe(true)
    expect(card.getAttribute('data-testid')).toBe('my-card')
  })

  test('preserves body child DOM order', () => {
    const { container } = render(
      <Card>
        <div className="a">A</div>
        <div className="b">B</div>
      </Card>,
    )
    const body = container.querySelector('.card__body') as HTMLElement
    const a = body.querySelector('.a') as HTMLElement
    const b = body.querySelector('.b') as HTMLElement
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
