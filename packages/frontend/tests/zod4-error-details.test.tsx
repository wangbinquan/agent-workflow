// Real v4 issues must remain readable by the existing error-details UI.
import { expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { z } from 'zod'
import { ErrorDetails } from '../src/components/ErrorDetails'

test('renders Zod 4 paths and messages without relying on removed issue fields', () => {
  const result = z
    .object({ entries: z.array(z.object({ name: z.string() })) })
    .safeParse({ entries: [{}] })
  expect(result.success).toBe(false)
  if (result.success) throw new Error('invalid fixture unexpectedly parsed')
  render(<ErrorDetails details={{ issues: result.error.issues }} />)
  expect(
    screen.getByText('entries.0.name: Invalid input: expected string, received undefined'),
  ).toBeTruthy()
})
