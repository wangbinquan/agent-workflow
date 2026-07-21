// RFC-211 implementation-gate regressions (2026-07-21 adversarial self-review).
// Locks the four SpotlightTour fixes:
//   P1-1 — typing guard: keys aimed at an editable element never drive the tour
//          (ArrowLeft used to back() mid-edit, the route-advance step then
//          bounced forward and the fill effect overwrote the user's input;
//          Escape inside an input killed the whole tour).
//   P1-2 — loadState domain check: persisted {tourId, stepIndex} outlives tour
//          script edits — an unknown id / out-of-range / non-integer index used
//          to crash the overlay on EVERY load with no in-product recovery. Bad
//          state must self-heal (dropped key, clean null).
//   P2-1 — an open Dialog owns Escape: one Esc closes the dialog only; the tour
//          survives (Dialog + tour are sibling window listeners).
//   P2-2 — right page + anchor stays missing → delayed escape-hatch Next (the
//          do-the-thing contract is unfulfillable; don't trap at Back/Skip).

import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { getTour } from '../src/components/tour/tourScript'
import { TourProvider } from '../src/components/tour/SpotlightTour'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
})

const seed = (tourId: string, stepIndex: unknown): void =>
  window.localStorage.setItem('aw-tour', JSON.stringify({ tourId, stepIndex }))
const stepNow = (): unknown =>
  (JSON.parse(window.localStorage.getItem('aw-tour') ?? '{}') as { stepIndex?: unknown }).stepIndex

const manualIdx = getTour('first-task').steps.findIndex(
  (s) => s.advanceOnRoute === undefined && s.advanceOnClick !== true,
)
const manualStep = getTour('first-task').steps[manualIdx]!

describe('RFC-211 impl-gate — loadState domain check (P1-2)', () => {
  test.each([
    ['unknown tour id', () => seed('ghost-tour', 0)],
    ['stepIndex out of range', () => seed('first-task', 999)],
    ['stepIndex negative', () => seed('first-task', -1)],
    ['stepIndex non-integer', () => seed('first-task', 1.5)],
    ['stepIndex null (NaN serialises to null)', () => seed('first-task', null)],
    ['garbage JSON', () => window.localStorage.setItem('aw-tour', '{tourId: broken')],
  ])('%s → no crash, no overlay, key self-heals', (_name, plant) => {
    plant()
    render(
      <TourProvider pathname="/">
        <div data-testid="app-alive" />
      </TourProvider>,
    )
    expect(screen.getByTestId('app-alive')).toBeTruthy()
    expect(screen.queryByTestId('spotlight-tour-bubble')).toBeNull()
    expect(window.localStorage.getItem('aw-tour')).toBeNull()
  })

  test('valid persisted state still restores', () => {
    seed('first-task', manualIdx)
    render(
      <TourProvider pathname={manualStep.route ?? '/'}>
        <div />
      </TourProvider>,
    )
    expect(screen.getByTestId('spotlight-tour-bubble')).toBeTruthy()
    expect(stepNow()).toBe(manualIdx)
  })
})

describe('RFC-211 impl-gate — keyboard guards (P1-1 / P2-1)', () => {
  test('arrow/Escape typed into an editable element never drive the tour', () => {
    seed('first-task', manualIdx)
    render(
      <TourProvider pathname={manualStep.route ?? '/'}>
        <input data-testid="typing-here" />
      </TourProvider>,
    )
    const input = screen.getByTestId('typing-here')
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(stepNow()).toBe(manualIdx)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByTestId('spotlight-tour-bubble')).toBeTruthy()
  })

  test('outside an editable element ArrowRight advances a manual step', () => {
    seed('first-task', manualIdx)
    render(
      <TourProvider pathname={manualStep.route ?? '/'}>
        <div />
      </TourProvider>,
    )
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(stepNow()).toBe(manualIdx + 1)
  })

  test('an open dialog owns Escape; without it Escape stops the tour', () => {
    seed('first-task', manualIdx)
    const view = render(
      <TourProvider pathname={manualStep.route ?? '/'}>
        {/* Stand-in for an open <Dialog> panel (role=dialog, sibling window
            Escape listener). The tour bubble itself is role=dialog too and is
            excluded by testid. */}
        <div role="dialog" data-testid="open-modal" />
      </TourProvider>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByTestId('spotlight-tour-bubble')).toBeTruthy()

    view.rerender(
      <TourProvider pathname={manualStep.route ?? '/'}>
        <div />
      </TourProvider>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('spotlight-tour-bubble')).toBeNull()
  })
})

describe('RFC-211 impl-gate — anchor-stale escape hatch (P2-2)', () => {
  test('right page + anchor missing: no Next at first, Next after the stale delay', () => {
    vi.useFakeTimers()
    const clickIdx = getTour('first-task').steps.findIndex((s) => s.advanceOnClick === true)
    const clickStep = getTour('first-task').steps[clickIdx]!
    expect(clickStep.route).toBeDefined()
    seed('first-task', clickIdx)
    render(
      <TourProvider pathname={clickStep.route!}>
        {/* Anchor deliberately absent: the control the step points at is gone. */}
        <div />
      </TourProvider>,
    )
    // The render-in-progress window must NOT flash an escape Next.
    expect(screen.queryByTestId('spotlight-tour-next')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(3100)
    })
    const next = screen.getByTestId('spotlight-tour-next')
    fireEvent.click(next)
    expect(stepNow()).toBe(clickIdx + 1)
  })
})
