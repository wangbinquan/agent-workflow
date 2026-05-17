// RFC-035 PR3 — render matrix for the shared <DetailLayout>.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { DetailLayout } from '../src/components/DetailLayout'

describe('<DetailLayout />', () => {
  test('no aside → single column class set', () => {
    const { container } = render(<DetailLayout main={<div data-testid="main">m</div>} />)
    const layout = container.querySelector('.detail-layout') as HTMLElement
    expect(layout).not.toBeNull()
    expect(layout.classList.contains('detail-layout--has-aside')).toBe(false)
  })

  test('aside present → has-aside + size + position', () => {
    const { container } = render(
      <DetailLayout main={<div>m</div>} aside={<div>a</div>} asideWidth="lg" />,
    )
    const layout = container.querySelector('.detail-layout')
    expect(layout?.classList.contains('detail-layout--has-aside')).toBe(true)
    expect(layout?.classList.contains('detail-layout--aside-lg')).toBe(true)
    // Default position is right; left modifier should NOT be present.
    expect(layout?.classList.contains('detail-layout--aside-left')).toBe(false)
  })

  test('asidePosition=left applies the left modifier and renders aside first', () => {
    const { container } = render(
      <DetailLayout
        main={<div data-testid="m">m</div>}
        aside={<div data-testid="a">a</div>}
        asidePosition="left"
      />,
    )
    expect(container.querySelector('.detail-layout--aside-left')).not.toBeNull()
    // Aside should be the first child in the DOM order so screen readers
    // encounter it first.
    const layout = container.querySelector('.detail-layout') as HTMLElement
    const firstChild = layout.firstElementChild
    expect(firstChild?.classList.contains('detail-layout__aside')).toBe(true)
  })

  test('asideWidth defaults to md when omitted', () => {
    const { container } = render(<DetailLayout main={<div>m</div>} aside={<div>a</div>} />)
    expect(container.querySelector('.detail-layout--aside-md')).not.toBeNull()
  })
})
