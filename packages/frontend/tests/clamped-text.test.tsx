// Contract for the shared <ClampedText> primitive.
//
// It exists because "long user text in a bounded container" kept being solved
// with a bare `max-height` + `overflow: hidden`, which hard-clips mid-sentence
// with no affordance to read on. The workgroup room's 工作组信息 goal shipped
// exactly that (styles.css even claimed "full text via title" while the JSX
// never set a title), so the tail of a long goal was simply unreachable.
//
// Locks the two properties that make it a safe replacement for a raw clip:
//   1. Short text costs nothing — bare element, no wrapper, no button, so
//      callers can adopt it without layout churn.
//   2. Long text is CSS-clamped, never text-truncated: the full string stays
//      in the DOM (screen readers / Ctrl-F reach it) and the toggle is the
//      visible way out.
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ClampedText } from '../src/components/ClampedText'
import '../src/i18n'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const CLAMPED = 'clamped-text__body--clamped'

describe('ClampedText', () => {
  test('short text renders bare: no wrapper, no toggle, no data-expanded', () => {
    render(<ClampedText text="short goal" data-testid="ct" toggleTestId="ct-toggle" />)
    const body = screen.getByTestId('ct')
    expect(body.textContent).toBe('short goal')
    expect(body.className).not.toContain(CLAMPED)
    // No fold ⇒ no expanded state to report and nothing to click.
    expect(body.getAttribute('data-expanded')).toBeNull()
    expect(screen.queryByTestId('ct-toggle')).toBeNull()
    expect(document.querySelector('.clamped-text')).toBeNull()
  })

  test('too many lines folds and toggles open / closed', () => {
    const many = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<ClampedText text={many} maxLines={4} data-testid="ct" toggleTestId="ct-toggle" />)
    const body = screen.getByTestId('ct')
    expect(body.className).toContain(CLAMPED)
    expect(body.getAttribute('data-expanded')).toBe('false')

    const toggle = screen.getByTestId('ct-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(body.className).not.toContain(CLAMPED)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(body.className).toContain(CLAMPED)
    expect(body.getAttribute('data-expanded')).toBe('false')
  })

  test('a long single paragraph folds too — the char budget catches what line-counting misses', () => {
    // One line, zero newlines: only the character budget can know this wraps
    // far past the line budget in a 280px rail.
    const paragraph = 'x'.repeat(400)
    render(<ClampedText text={paragraph} maxLines={4} data-testid="ct" toggleTestId="ct-toggle" />)
    expect(screen.getByTestId('ct').className).toContain(CLAMPED)
    expect(screen.getByTestId('ct-toggle')).toBeTruthy()
  })

  test('folding is CSS-only — the whole string stays in the DOM for Ctrl-F / screen readers', () => {
    const many = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<ClampedText text={many} maxLines={4} data-testid="ct" />)
    // Still folded, yet the last line is present and findable.
    const body = screen.getByTestId('ct')
    expect(body.className).toContain(CLAMPED)
    expect(body.textContent).toContain('line 12')
  })

  test('the line budget rides in on a custom property so one rule serves every caller', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    render(<ClampedText text={many} maxLines={7} data-testid="ct" />)
    expect(screen.getByTestId('ct').style.getPropertyValue('--clamped-text-lines')).toBe('7')
  })
})
