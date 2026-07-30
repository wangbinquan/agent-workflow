import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { FeedbackStack } from '../src/components/FeedbackStack'

afterEach(cleanup)

describe('FeedbackStack', () => {
  test('groups multiple feedback surfaces and reserves section rhythm', () => {
    render(
      <FeedbackStack variant="section" testid="feedback">
        <div data-testid="first">first</div>
        <div data-testid="second">second</div>
      </FeedbackStack>,
    )

    const stack = screen.getByTestId('feedback')
    expect(stack.classList.contains('feedback-stack')).toBe(true)
    expect(stack.classList.contains('feedback-stack--section')).toBe(true)
    expect(stack.children).toHaveLength(2)
  })

  test('does not leave an empty spacing wrapper when every feedback child is absent', () => {
    render(
      <FeedbackStack variant="section" testid="feedback">
        {false}
        {null}
        {undefined}
      </FeedbackStack>,
    )

    expect(screen.queryByTestId('feedback')).toBeNull()
  })
})
