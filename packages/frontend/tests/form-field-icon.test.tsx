// RFC-173 (T4) — <Field icon={…}> renders a leading icon inside the label;
// omitting it renders no icon slot (backward compatible).

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Field } from '../src/components/Form'

afterEach(() => cleanup())

describe('Field icon slot', () => {
  test('renders the icon before the label when provided', () => {
    render(
      <Field label="Skills" icon={<svg data-icon="skill" />}>
        <input aria-label="Skills" />
      </Field>,
    )
    const icon = document.querySelector('.form-field__icon')
    expect(icon).toBeTruthy()
    expect(icon?.querySelector('[data-icon="skill"]')).toBeTruthy()
    expect(screen.getByText('Skills')).toBeTruthy()
  })

  test('renders no icon slot when omitted', () => {
    render(
      <Field label="Plain">
        <input aria-label="Plain" />
      </Field>,
    )
    expect(document.querySelector('.form-field__icon')).toBeNull()
  })
})
