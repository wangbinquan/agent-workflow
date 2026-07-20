// RFC-034 T9 — SubmoduleBadge renders 4 states correctly:
//   1. legacy row (hasSubmodules=null)         → renders nothing
//   2. no submodule (hasSubmodules=false)       → renders nothing
//   3. ok (hasSubmodules=true, syncOk=true)     → renders ok chip
//   4. error (hasSubmodules=true, syncOk=false) → renders error chip with
//      redacted stderr in title

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { SubmoduleBadge } from '../src/components/repos/SubmoduleBadge'

describe('<SubmoduleBadge />', () => {
  test('legacy row (hasSubmodules=null) renders nothing', () => {
    const { container } = render(
      <SubmoduleBadge
        hasSubmodules={null}
        lastSubmoduleSyncOk={null}
        lastSubmoduleSyncError={null}
      />,
    )
    expect(container.textContent).toBe('')
  })

  test('repo without submodules renders nothing', () => {
    const { container } = render(
      <SubmoduleBadge
        hasSubmodules={false}
        lastSubmoduleSyncOk={true}
        lastSubmoduleSyncError={null}
      />,
    )
    expect(container.textContent).toBe('')
  })

  test('successful sync renders ok chip', () => {
    render(
      <SubmoduleBadge
        hasSubmodules={true}
        lastSubmoduleSyncOk={true}
        lastSubmoduleSyncError={null}
      />,
    )
    const chip = screen.getByTestId('submodule-badge-ok')
    // RFC-210: folded into <StatusChip>; the private `.submodule-badge` CSS is gone.
    expect(chip.className).toContain('status-chip--success')
    expect(chip.textContent).toContain('submodule')
  })

  test('failed sync renders error chip with redacted stderr tooltip', () => {
    render(
      <SubmoduleBadge
        hasSubmodules={true}
        lastSubmoduleSyncOk={false}
        lastSubmoduleSyncError={'fatal: could not read Username for https://***@host/sub.git'}
      />,
    )
    const chip = screen.getByTestId('submodule-badge-error')
    expect(chip.className).toContain('status-chip--danger')
    expect(chip.getAttribute('title')).toContain('***')
    expect(chip.getAttribute('title')).not.toContain('user:tok')
  })

  test('failed sync with null stderr falls back to i18n error message', () => {
    render(
      <SubmoduleBadge
        hasSubmodules={true}
        lastSubmoduleSyncOk={false}
        lastSubmoduleSyncError={null}
      />,
    )
    const chip = screen.getByTestId('submodule-badge-error')
    expect(chip.getAttribute('title')).toBeTruthy()
    expect(chip.getAttribute('title')?.length).toBeGreaterThan(0)
  })
})
