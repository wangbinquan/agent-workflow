import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Field } from '../src/components/Form'
import { SettingsNumberInput } from '../src/components/settings/SettingsNumberInput'
import i18n from '../src/i18n'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => cleanup())

describe('SettingsNumberInput', () => {
  test('renders the shared timeout range and human conversion', () => {
    render(
      <Field label="意图构建超时">
        <SettingsNumberInput
          setting="intentBuilderTurnTimeoutMs"
          value={30_000}
          onChange={() => {}}
        />
      </Field>,
    )
    expect(screen.getByText(/范围 30000 – 3600000/)).toBeTruthy()
    expect(screen.getByText(/30 秒 – 1 小时/)).toBeTruthy()
  })

  test('marks a directly typed value above max invalid', () => {
    render(
      <Field label="节点超时">
        <SettingsNumberInput
          setting="defaultPerNodeTimeoutMs"
          value={2_147_483_648}
          onChange={() => {}}
        />
      </Field>,
    )
    const input = screen.getByRole('spinbutton')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('2147483647')
  })

  test('expresses and validates the zero-or-positive periodic interval', () => {
    const { rerender } = render(
      <Field label="孤儿核对周期">
        <SettingsNumberInput setting="periodicOrphanReconcileMs" value={1} onChange={() => {}} />
      </Field>,
    )
    expect(screen.getByText('允许 0，或范围 60000 – 2147483647')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('60000')

    rerender(
      <Field label="孤儿核对周期">
        <SettingsNumberInput setting="periodicOrphanReconcileMs" value={0} onChange={() => {}} />
      </Field>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
