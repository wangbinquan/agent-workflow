// RFC-166 §4.2 (T8) — AgentCapabilityCard render locks.
//
//  1. Renders name / description / role / input+output port chips (name + kind)
//     and the per-input `required` badge.
//  2. Empty inputs / outputs render the "(none declared)" placeholder.
//  3. `compact` hides the prompt summary.
//  4. Prompt-isolation: even if the source object smuggles an ownerUserId, the
//     card never renders it (CapabilitySource Pick<> + capabilityCardModel).

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { CapabilitySource } from '@agent-workflow/shared'
import { AgentCapabilityCard } from '../src/components/agent/AgentCapabilityCard'

afterEach(cleanup)

const AUDITOR: CapabilitySource = {
  name: 'auditor',
  description: 'Reviews a diff.',
  inputs: [
    { name: 'diff', kind: 'string', required: true },
    { name: 'spec', kind: 'markdown' },
  ],
  outputs: ['report'],
  outputKinds: { report: 'markdown' },
  role: 'normal',
  bodyMd: 'You are a meticulous auditor.',
}

describe('AgentCapabilityCard', () => {
  test('renders name, description, ports with kinds, and the required badge', () => {
    render(<AgentCapabilityCard agent={AUDITOR} />)
    expect(screen.getByText('auditor')).toBeTruthy()
    expect(screen.getByText('Reviews a diff.')).toBeTruthy()
    expect(screen.getByText('diff')).toBeTruthy()
    expect(screen.getByText('spec')).toBeTruthy()
    expect(screen.getByText('report')).toBeTruthy()
    // the per-input required badge (i18n capabilityCard.required)
    expect(screen.getByText('required')).toBeTruthy()
    // prompt summary present by default
    expect(screen.getByText(/meticulous auditor/)).toBeTruthy()
  })

  test('empty inputs/outputs render the none-declared placeholder', () => {
    render(<AgentCapabilityCard agent={{ ...AUDITOR, inputs: [], outputs: [] }} />)
    expect(screen.getAllByText('(none declared)').length).toBe(2)
  })

  test('compact hides the prompt summary', () => {
    const { container } = render(<AgentCapabilityCard agent={AUDITOR} compact />)
    expect(container.querySelector('.capability-card__prompt')).toBeNull()
  })

  test('prompt-isolation: never renders an owner user id', () => {
    const leaky = { ...AUDITOR, ownerUserId: 'user_SECRET_OWNER' } as unknown as CapabilitySource
    const { container } = render(<AgentCapabilityCard agent={leaky} />)
    expect(container.textContent ?? '').not.toContain('user_SECRET_OWNER')
  })
})
