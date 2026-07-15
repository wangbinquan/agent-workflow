// RFC-194 — validation summaries have one live compact alert, one non-live
// detail region, per-code repair copy, and explicit Ports/Advanced navigation.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AgentPortValidationSummary } from '../src/components/agent-ports/AgentPortValidationSummary'
import type { AgentPortValidationIssue } from '../src/lib/agent-ports'

const compactIssues: AgentPortValidationIssue[] = [
  {
    severity: 'error',
    repairTarget: 'ports',
    code: 'output-name-duplicate',
    name: 'result',
    indices: [0, 2],
  },
  {
    severity: 'error',
    repairTarget: 'advanced',
    code: 'reserved-port-sidecar-key',
    key: 'outputKinds',
    source: 'frontmatterExtra',
  },
]

describe('AgentPortValidationSummary', () => {
  test('compact gives every repair action a unique name and hands focus to the target tab', async () => {
    const onNavigate = vi.fn()
    render(
      <>
        <button data-testid="agent-tab-ports">Ports tab</button>
        <button data-testid="agent-tab-advanced">Advanced tab</button>
        <AgentPortValidationSummary
          issues={compactIssues}
          variant="compact"
          onNavigate={onNavigate}
        />
      </>,
    )

    const alert = screen.getByRole('alert', {
      name: 'Port configuration needs attention (2)',
    })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(alert).getByText(/result is duplicated at items 1, 3/)).toBeTruthy()
    expect(within(alert).getByText(/Reserved key outputKinds/)).toBeTruthy()

    const portsRepair = within(alert).getByRole('button', {
      name: /Fix in Ports: Output port result is duplicated/i,
    })
    const advancedRepair = within(alert).getByRole('button', {
      name: /Fix in Advanced: Reserved key outputKinds/i,
    })
    expect(portsRepair.textContent).toBe('Fix in Ports')
    expect(advancedRepair.textContent).toBe('Fix in Advanced')

    fireEvent.click(portsRepair)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('agent-tab-ports')))
    fireEvent.click(advancedRepair)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('agent-tab-advanced')),
    )
    expect(onNavigate.mock.calls).toEqual([['ports'], ['advanced']])
  })

  test('detail is a named non-live region and renders every issue code', () => {
    const issues: AgentPortValidationIssue[] = [
      {
        severity: 'error',
        repairTarget: 'ports',
        code: 'input-name-schema',
        name: '',
        index: 0,
      },
      {
        severity: 'error',
        repairTarget: 'ports',
        code: 'input-name-duplicate',
        name: 'source',
        indices: [0, 1],
      },
      {
        severity: 'error',
        repairTarget: 'ports',
        code: 'output-name-duplicate',
        name: 'result',
        indices: [1, 3],
      },
      {
        severity: 'error',
        repairTarget: 'ports',
        code: 'output-kind-invalid',
        key: 'report',
        value: 'not_registered',
      },
      {
        severity: 'error',
        repairTarget: 'ports',
        code: 'wrapper-name-duplicate',
        name: 'merged',
        indices: [0, 2],
      },
      {
        severity: 'error',
        repairTarget: 'advanced',
        code: 'reserved-port-sidecar-key',
        key: 'role',
      },
      {
        severity: 'warning',
        repairTarget: 'ports',
        code: 'orphan-output-kind',
        key: 'old_result',
        value: 'markdown',
      },
      {
        severity: 'warning',
        repairTarget: 'ports',
        code: 'orphan-wrapper-name',
        key: 'old_result',
        value: 'legacy_result',
      },
    ]

    render(<AgentPortValidationSummary issues={issues} variant="detail" />)

    const region = screen.getByRole('region', { name: 'Port configuration issues (8)' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(region.getAttribute('aria-live')).toBeNull()
    expect(within(region).getByText(/Input port 1 .* has an invalid name/)).toBeTruthy()
    expect(within(region).getByText(/source is duplicated at items 1, 2/)).toBeTruthy()
    expect(within(region).getByText(/result is duplicated at items 2, 4/)).toBeTruthy()
    expect(within(region).getByText(/report is invalid: not_registered/)).toBeTruthy()
    expect(within(region).getByText(/Reserved key role/)).toBeTruthy()
    const messages = Array.from(region.querySelectorAll('.agent-port-validation__message')).map(
      (element) => element.textContent ?? '',
    )
    expect(messages.some((message) => message.includes('merged') && message.includes('1, 3'))).toBe(
      true,
    )
    expect(
      messages.some((message) => message.includes('old_result') && message.includes('markdown')),
    ).toBe(true)
    expect(
      messages.some(
        (message) => message.includes('old_result') && message.includes('legacy_result'),
      ),
    ).toBe(true)
    expect(within(region).getAllByText('Fix in Ports')).toHaveLength(7)
    expect(within(region).getByText('Fix in Advanced')).toBeTruthy()
  })

  test('renders nothing when there are no issues', () => {
    const { container } = render(<AgentPortValidationSummary issues={[]} variant="compact" />)
    expect(container.innerHTML).toBe('')
  })
})
