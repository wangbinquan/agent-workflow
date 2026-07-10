// LOCKS: RFC-165 T11 (§11.21) — the shared Stepper primitive's contract.
//
//   ST1 renders every step header; the active one carries aria-current="step"
//       and the current-state class; visited headers are clickable and
//       navigate back; steps beyond maxReachable are disabled.
//   ST2 Next fires onNavigate(current+1) and honors nextEnabled gating.
//   ST3 the LAST step replaces Next with the caller's finalActions and shows
//       Back for回跳.

import { describe, expect, test, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Stepper } from '../src/components/Stepper'
import '../src/i18n'

afterEach(cleanup)

const STEPS = [
  { key: 'mode', title: 'Mode' },
  { key: 'space', title: 'Space' },
  { key: 'content', title: 'Content' },
  { key: 'confirm', title: 'Confirm' },
]

describe('Stepper (RFC-165 T11)', () => {
  test('ST1 headers: aria-current on active; visited clickable; forward-locked disabled', () => {
    const onNavigate = vi.fn()
    const { getByTestId } = render(
      <Stepper steps={STEPS} current={1} maxReachable={1} onNavigate={onNavigate}>
        <div>body</div>
      </Stepper>,
    )
    expect(getByTestId('stepper-step-space').getAttribute('aria-current')).toBe('step')
    expect((getByTestId('stepper-step-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId('stepper-step-mode') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(getByTestId('stepper-step-mode'))
    expect(onNavigate).toHaveBeenCalledWith(0)
  })

  test('ST2 Next advances and honors gating', () => {
    const onNavigate = vi.fn()
    const { getByTestId, rerender } = render(
      <Stepper steps={STEPS} current={0} onNavigate={onNavigate} nextEnabled={false}>
        <div>body</div>
      </Stepper>,
    )
    expect((getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    rerender(
      <Stepper steps={STEPS} current={0} onNavigate={onNavigate} nextEnabled>
        <div>body</div>
      </Stepper>,
    )
    fireEvent.click(getByTestId('stepper-next'))
    expect(onNavigate).toHaveBeenCalledWith(1)
  })

  test('ST3 last step renders finalActions instead of Next; Back navigates', () => {
    const onNavigate = vi.fn()
    const { getByTestId, queryByTestId } = render(
      <Stepper
        steps={STEPS}
        current={3}
        maxReachable={3}
        onNavigate={onNavigate}
        finalActions={
          <button type="button" data-testid="wizard-launch">
            Launch
          </button>
        }
      >
        <div>summary</div>
      </Stepper>,
    )
    expect(queryByTestId('stepper-next')).toBeNull()
    expect(getByTestId('wizard-launch')).toBeDefined()
    fireEvent.click(getByTestId('stepper-back'))
    expect(onNavigate).toHaveBeenCalledWith(2)
  })
})
