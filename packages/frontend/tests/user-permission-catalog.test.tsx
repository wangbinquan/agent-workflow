import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, test } from 'vitest'
import type { Permission } from '@agent-workflow/shared'
import { UserPermissionCatalog } from '@/components/users/UserPermissionCatalog'
import i18n from '@/i18n'

function Harness() {
  const [permissions, setPermissions] = useState<ReadonlyArray<Permission>>([])
  return (
    <I18nextProvider i18n={i18n}>
      <UserPermissionCatalog
        role="user"
        additionalPermissions={permissions}
        onChange={setPermissions}
      />
    </I18nextProvider>
  )
}

describe('RFC-305 UserPermissionCatalog', () => {
  test('renders catalog-derived rows and makes only additional points interactive', () => {
    render(<Harness />)
    const baseline = screen.getByTestId('user-permission-agents:read') as HTMLInputElement
    expect(baseline.checked).toBe(true)
    expect(baseline.disabled).toBe(true)
    const settings = screen.getByTestId('user-permission-settings:write') as HTMLInputElement
    expect(settings.disabled).toBe(false)
    expect(settings.checked).toBe(false)
    expect(screen.queryByTestId('user-permission-account:self')).toBeNull()

    const scripts = screen.getByTestId('user-permission-scripts:author') as HTMLInputElement
    expect(scripts.disabled).toBe(false)
    expect(scripts.checked).toBe(false)
    fireEvent.click(scripts)
    expect(scripts.checked).toBe(true)
    // 54 baseline (RFC-304 added the two template reads and the three group-layer
    // writes) + the one explicitly ticked `scripts:author`.
    expect(screen.getByText(/84 effective/i)).toBeTruthy()
  })

  test('search keeps selection while hiding non-matching rows', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('user-permission-scripts:author'))
    fireEvent.change(screen.getByTestId('user-permission-search'), {
      target: { value: 'scripts:author' },
    })
    expect((screen.getByTestId('user-permission-scripts:author') as HTMLInputElement).checked).toBe(
      true,
    )
    expect(screen.queryByText('agents:read')).toBeNull()
    fireEvent.change(screen.getByTestId('user-permission-search'), {
      target: { value: 'missing-permission' },
    })
    expect(
      within(screen.getByTestId('user-permission-empty')).getByText('No permissions found'),
    ).toBeTruthy()
  })
})
