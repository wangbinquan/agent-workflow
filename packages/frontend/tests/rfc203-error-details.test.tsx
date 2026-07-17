// RFC-203 T2 — <ErrorDetails> structured-shape rendering locks.
//
// LOCKS: (1) each known details shape renders its dedicated row; (2) the ACL
// iron rule — legacy UNFILTERED reference arrays (referencedBy /
// scheduledTaskIds / workflows / agents / taskIds) render an aggregate count
// only, NEVER names (they may contain other users' private resource names —
// Codex design-gate P1); principal-aware shapes (visibleScheduled+hiddenCount)
// do render names; (3) unknown shapes render nothing and never throw; (4) the
// raw message lands in a collapsible block.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ErrorDetails } from '../src/components/ErrorDetails'
import '../src/i18n'
import { setLanguage } from '../src/i18n'

setLanguage('zh-CN')
afterEach(cleanup)

describe('<ErrorDetails />', () => {
  test('zod issues render capped list with overflow counter', () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({
      path: ['inputs', i],
      message: `bad ${i}`,
    }))
    const { container } = render(<ErrorDetails details={{ issues }} />)
    const items = container.querySelectorAll('.error-details__issues li')
    expect(items.length).toBe(6) // 5 + overflow row
    expect(container.textContent).toContain('inputs.0: bad 0')
    expect(container.textContent).toContain('2')
  })

  test('principal-aware reference shape renders names + hidden count', () => {
    const { container } = render(
      <ErrorDetails
        details={{ visibleScheduled: [{ id: 'a', name: 'daily-audit' }], hiddenCount: 2 }}
      />,
    )
    expect(container.textContent).toContain('daily-audit')
    expect(container.textContent).toContain('2')
  })

  test('ACL rule: bare referencedBy array renders count ONLY, never names', () => {
    const { container } = render(
      <ErrorDetails details={{ referencedBy: ['secret-agent-name', 'another'] }} />,
    )
    expect(container.textContent).not.toContain('secret-agent-name')
    expect(container.textContent).toContain('2')
  })

  test('ACL rule holds for scheduledTaskIds / workflows / agents shapes', () => {
    for (const details of [
      { scheduledTaskIds: ['01AAA', '01BBB', '01CCC'] },
      { workflows: [{ id: 'w1', name: 'private-flow' }] },
      { agents: ['private-agent'] },
    ]) {
      const { container, unmount } = render(<ErrorDetails details={details} />)
      expect(container.textContent).not.toContain('private-')
      expect(container.textContent).not.toContain('01AAA')
      unmount()
    }
  })

  test('availableRefs renders the branch list', () => {
    const { container } = render(<ErrorDetails details={{ availableRefs: ['main', 'dev'] }} />)
    expect(container.textContent).toContain('main')
    expect(container.textContent).toContain('dev')
  })

  test('OCC version pair renders refresh guidance', () => {
    const { container } = render(
      <ErrorDetails details={{ expectedVersion: 3, currentVersion: 5 }} />,
    )
    expect(container.textContent).toContain('v3')
    expect(container.textContent).toContain('v5')
  })

  test('stderr and raw render as collapsible pre blocks', () => {
    const { container } = render(<ErrorDetails details={{ stderr: 'fatal: x' }} raw="raw msg" />)
    const pres = container.querySelectorAll('details pre')
    expect(pres.length).toBe(2)
    expect(container.textContent).toContain('fatal: x')
    expect(container.textContent).toContain('raw msg')
  })

  test('unknown shape renders nothing and does not throw', () => {
    const { container } = render(<ErrorDetails details={{ zzz: { deep: [1, 2, 3] } }} />)
    expect(container.querySelector('.error-details')).toBeNull()
  })

  test('hint renders above everything', () => {
    const { container } = render(<ErrorDetails hint="下一步：重试" />)
    expect(container.querySelector('.error-details__hint')?.textContent).toContain('下一步')
  })
})

describe('RFC-203 ErrorDetails a11y guard (CSS source lock)', () => {
  test('the raw-toggle summary does NOT reduce opacity (WCAG AA contrast)', () => {
    // The /agents inbox dialog renders an ErrorBanner → <ErrorDetails> whose
    // <details><summary> toggle is axe-scanned. A prior `opacity: 0.85` on
    // it failed the color-contrast rule (CI e2e a11y, run 29551050507). Lock
    // that the .error-details__raw > summary rule carries no opacity.
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
    const block = css.slice(
      css.indexOf('.error-details__raw > summary'),
      css.indexOf('.error-details__raw pre'),
    )
    expect(block).not.toMatch(/opacity\s*:/)
  })
})
