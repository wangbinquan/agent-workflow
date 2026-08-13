import { render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { SettingsCard } from '../src/components/settings/SettingsCard'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SettingsCard', () => {
  test('labels a settings section from its visible card title', () => {
    const { getByRole } = render(
      <SettingsCard
        title="Automation"
        hint="Run recovery automatically."
        actions={<button type="button">Add rule</button>}
        className="extra"
        data-testid="automation-card"
      >
        <button type="button">Configure</button>
      </SettingsCard>,
    )

    const section = getByRole('region', { name: 'Automation' })
    expect(section.classList.contains('settings-card')).toBe(true)
    expect(section.classList.contains('extra')).toBe(true)
    expect(section.getAttribute('data-testid')).toBe('automation-card')
    expect(section.querySelector('.card__title')?.textContent).toBe('Automation')
    expect(section.querySelector('.settings-hint')?.textContent).toBe('Run recovery automatically.')
    expect(section.querySelector('.form-section__body button')?.textContent).toBe('Configure')
    expect(section.querySelector('.card__title-actions button')?.textContent).toBe('Add rule')
  })

  test('uses native disabled fieldset semantics for grouped dialog fields', () => {
    const { getByRole } = render(
      <SettingsCard as="fieldset" disabled title="OIDC credentials">
        <input aria-label="Client ID" />
      </SettingsCard>,
    )

    const group = getByRole('group', { name: 'OIDC credentials' }) as HTMLFieldSetElement
    expect(group.disabled).toBe(true)
    expect(getByRole('textbox').closest('fieldset')).toBe(group)
  })

  test('omits the hint wrapper when no hint is supplied', () => {
    const { container } = render(
      <SettingsCard title="Display">
        <span>Theme</span>
      </SettingsCard>,
    )
    expect(container.querySelector('.settings-hint')).toBeNull()
    expect(container.querySelector('.card__title-actions')).toBeNull()
  })
})
